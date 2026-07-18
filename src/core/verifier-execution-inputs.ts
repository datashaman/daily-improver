import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { ImproverConfig } from "../config.js";
import type { ImprovementSpec } from "../domain/model.js";
import type { CommandRunner } from "../infra/command-runner.js";
import { runDirectory, type TestManifest } from "./artifacts.js";
import {
  validateVerifierCommandEnvironmentDecision,
  type VerifierCommandEnvironmentDecision,
} from "./verifier-command-environment.js";

const maximumCommands = 64;
const maximumCommandLength = 4_096;

export interface VerifierExecutionPreparation {
  readonly schemaVersion: "verifier-execution-preparation/v3";
  readonly expectedBaseSha: string;
  readonly specification: ImprovementSpec;
  readonly specificationSha256: string;
  readonly configurationSha256: string | "absent";
  readonly commands: readonly string[];
  readonly mutationMode: "off" | "targeted" | "full";
  readonly protectedPaths: readonly string[];
  readonly commandEnvironment: VerifierCommandEnvironmentDecision;
  readonly outputArtifact: string;
  readonly trustedArtifacts: readonly string[];
}

export interface VerifierExecutionInputs extends Omit<VerifierExecutionPreparation, "schemaVersion"> {
  readonly schemaVersion: "verifier-execution-inputs/v3";
  readonly manifest: TestManifest;
  readonly manifestArtifactSha256: string;
  readonly integritySha256: string;
}

export async function prepareVerifierExecution(
  root: string,
  base: string,
  spec: ImprovementSpec,
  config: ImproverConfig,
  commandEnvironment: VerifierCommandEnvironmentDecision,
  runner: CommandRunner,
): Promise<VerifierExecutionPreparation> {
  const expectedBaseSha = await resolveCommit(root, base, runner);
  const specificationSha256 = await regularFileSha256(root, relative(root, join(runDirectory(root), "spec.json")));
  const configurationSha256 = await optionalRegularFileSha256(root, ".ai/improver.yml");
  const commands = validateCommands(config.verification.commands);
  const outputArtifact = exactRepositoryPath(root, join(runDirectory(root), "verification.json"));
  const runRoot = exactRepositoryPath(root, runDirectory(root));
  return deepFreeze({
    schemaVersion: "verifier-execution-preparation/v3",
    expectedBaseSha,
    specification: clone(spec),
    specificationSha256,
    configurationSha256,
    commands,
    mutationMode: config.verification.mutation_testing,
    protectedPaths: clone(config.protected_paths),
    commandEnvironment: validateVerifierCommandEnvironmentDecision(commandEnvironment),
    outputArtifact,
    trustedArtifacts: [
      `${runRoot}/build-agent-usage.json`,
      `${runRoot}/build-agent-rationale.json`,
    ],
  });
}

export async function sealVerifierExecution(
  root: string,
  preparation: VerifierExecutionPreparation,
  manifest: TestManifest,
): Promise<VerifierExecutionInputs> {
  assertPreparation(preparation);
  const manifestArtifactSha256 = await regularFileSha256(root, relative(root, join(runDirectory(root), "test-manifest.json")));
  const unsigned = {
    ...clone(preparation),
    schemaVersion: "verifier-execution-inputs/v3" as const,
    manifest: clone(manifest),
    manifestArtifactSha256,
  };
  return deepFreeze({ ...unsigned, integritySha256: sha256(JSON.stringify(unsigned)) });
}

export async function assertVerifierExecutionInputs(
  root: string,
  inputs: VerifierExecutionInputs,
  runner: CommandRunner,
): Promise<void> {
  if (inputs.schemaVersion !== "verifier-execution-inputs/v3") throw new Error("Verifier execution inputs use an unsupported schema.");
  const { integritySha256, ...unsigned } = inputs;
  if (!/^[a-f0-9]{64}$/u.test(integritySha256) || sha256(JSON.stringify(unsigned)) !== integritySha256) {
    throw new Error("Verifier execution inputs changed after they were sealed.");
  }
  assertPreparation({ ...unsigned, schemaVersion: "verifier-execution-preparation/v3" });
  if (await regularFileSha256(root, relative(root, join(runDirectory(root), "spec.json"))) !== inputs.specificationSha256) {
    throw new Error("Verifier specification identity changed after preparation.");
  }
  if (await optionalRegularFileSha256(root, ".ai/improver.yml") !== inputs.configurationSha256) {
    throw new Error("Verifier configuration identity changed after preparation.");
  }
  if (await regularFileSha256(root, relative(root, join(runDirectory(root), "test-manifest.json"))) !== inputs.manifestArtifactSha256) {
    throw new Error("Verifier manifest identity changed after sealing.");
  }
  const currentHead = await resolveCommit(root, "HEAD", runner);
  if (currentHead !== inputs.expectedBaseSha) throw new Error("Verifier baseline identity changed before execution.");
}

export async function writeVerificationOutput(
  root: string,
  outputArtifact: string,
  value: unknown,
): Promise<void> {
  assertRepositoryRelativePath(outputArtifact);
  const absolute = join(root, outputArtifact);
  const parent = dirname(absolute);
  await mkdir(parent, { recursive: true });
  await assertContainedDirectory(root, parent);
  const temporary = join(parent, `.verification-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, absolute);
  } finally {
    // A successful rename makes the temporary path absent; a failed write leaves nothing useful to retain.
    try { await unlink(temporary); } catch { /* absent */ }
  }
}

function assertPreparation(value: VerifierExecutionPreparation): void {
  if (value.schemaVersion !== "verifier-execution-preparation/v3") throw new Error("Verifier preparation uses an unsupported schema.");
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.expectedBaseSha)) throw new Error("Verifier baseline identity is malformed.");
  if (!/^[a-f0-9]{64}$/u.test(value.specificationSha256)) throw new Error("Verifier specification identity is malformed.");
  if (value.configurationSha256 !== "absent" && !/^[a-f0-9]{64}$/u.test(value.configurationSha256)) throw new Error("Verifier configuration identity is malformed.");
  validateCommands(value.commands);
  if (value.mutationMode !== "off" && value.mutationMode !== "targeted" && value.mutationMode !== "full") throw new Error("Verifier mutation mode is unsupported.");
  validateVerifierCommandEnvironmentDecision(value.commandEnvironment);
  assertRepositoryRelativePath(value.outputArtifact);
  if (value.trustedArtifacts.length !== 2 || new Set(value.trustedArtifacts).size !== 2) throw new Error("Verifier trusted artifact paths are malformed.");
  for (const path of [...value.trustedArtifacts, ...value.protectedPaths]) {
    if (!path || path.length > 1_024 || path.includes("\0") || path.startsWith("/")) throw new Error("Verifier protected or trusted path is malformed.");
  }
}

function validateCommands(commands: readonly string[]): readonly string[] {
  if (!Array.isArray(commands) || commands.length > maximumCommands) throw new Error("Verifier commands exceed the command limit.");
  const validated = commands.map((command) => {
    if (typeof command !== "string" || !command || command.length > maximumCommandLength || command.includes("\0")) {
      throw new Error("Verifier command is malformed or unbounded.");
    }
    return command;
  });
  return clone(validated);
}

async function resolveCommit(root: string, ref: string, runner: CommandRunner): Promise<string> {
  if (!ref || ref.length > 256 || ref.startsWith("-") || ref.includes("\0")) throw new Error("Verifier base reference is malformed.");
  const result = await runner.run(["git", "rev-parse", "--verify", `${ref}^{commit}`], root);
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha)) throw new Error("Verifier expected baseline commit is unavailable.");
  return sha;
}

async function optionalRegularFileSha256(root: string, path: string): Promise<string | "absent"> {
  try { return await regularFileSha256(root, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
}

async function regularFileSha256(root: string, path: string): Promise<string> {
  assertRepositoryRelativePath(path);
  const absolute = join(root, path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Verifier input is not a regular file: ${path}`);
  return sha256(await readFile(absolute));
}

async function assertContainedDirectory(root: string, directory: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const canonicalDirectory = await realpath(directory);
  if (canonicalDirectory !== canonicalRoot && !canonicalDirectory.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("Verifier output directory escapes the repository.");
  }
  let current = canonicalDirectory;
  while (current !== canonicalRoot) {
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Verifier output directory is not a contained regular directory.");
    const parent = dirname(current);
    if (parent === current) throw new Error("Verifier output directory escapes the repository.");
    current = parent;
  }
}

function exactRepositoryPath(root: string, absolute: string): string {
  const path = relative(root, absolute);
  assertRepositoryRelativePath(path);
  return path;
}

function assertRepositoryRelativePath(path: string): void {
  if (!path || path.length > 1_024 || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) {
    throw new Error("Verifier artifact path is malformed.");
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
