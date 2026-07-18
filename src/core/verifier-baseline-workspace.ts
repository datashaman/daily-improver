import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { CommandRunner } from "../infra/command-runner.js";
import { verifierManifestFilePaths } from "./artifacts.js";
import type { VerifierExecutionInputs } from "./verifier-execution-inputs.js";

const maximumPathLength = 1_024;

export interface VerifierBaselineWorkspaceHandle {
  readonly path: string;
  cleanup(): Promise<void>;
}

export async function createVerifierBaselineWorkspace(
  changedVerifierRoot: string,
  inputs: VerifierExecutionInputs,
  runner: CommandRunner,
): Promise<VerifierBaselineWorkspaceHandle> {
  const source = await realpath(changedVerifierRoot);
  await assertExactHead(source, inputs.expectedBaseSha, runner);
  const temporary = await mkdtemp(join(tmpdir(), "daily-improver-verifier-baseline-"));
  const checkout = join(temporary, "checkout");
  try {
    await expectSuccess(
      runner.run(["git", "clone", "--no-local", "--no-checkout", "--", source, checkout], temporary),
      "Unable to create verifier baseline checkout",
    );
    await expectSuccess(
      runner.run(["git", "checkout", "--detach", inputs.expectedBaseSha], checkout),
      "Unable to check out the verifier baseline",
    );
    await assertExactHead(checkout, inputs.expectedBaseSha, runner);
    await assertClean(checkout, runner);
    for (const path of verifierManifestFilePaths(inputs.manifest)) {
      await transferExactRegularFile(source, checkout, path, inputs.manifest.files[path]);
    }
    const manifestPath = siblingArtifactPath(inputs.outputArtifact, "test-manifest.json");
    await transferExactRegularFile(source, checkout, manifestPath, inputs.manifestArtifactSha256);
    await assertExactHead(source, inputs.expectedBaseSha, runner);
    await assertExactHead(checkout, inputs.expectedBaseSha, runner);
    return { path: checkout, cleanup: async () => await rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function transferExactRegularFile(sourceRoot: string, destinationRoot: string, path: string, expectedSha256?: string): Promise<void> {
  assertRepositoryPath(path);
  const source = await containedRegularFile(sourceRoot, path);
  const metadata = await lstat(source);
  const content = await readFile(source);
  if (expectedSha256 === undefined || sha256(content) !== expectedSha256) {
    throw new Error(`Verifier baseline input identity changed: ${path}`);
  }
  const destination = await safeDestination(destinationRoot, path);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.verifier-baseline-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: metadata.mode & 0o777 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function containedRegularFile(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const lexical = join(canonicalRoot, path);
  const metadata = await lstat(lexical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Verifier baseline input is not a regular file: ${path}`);
  const canonical = await realpath(lexical);
  if (!contained(canonicalRoot, canonical) || canonical !== lexical) throw new Error(`Verifier baseline input escapes its workspace: ${path}`);
  return canonical;
}

async function safeDestination(root: string, path: string): Promise<string> {
  assertRepositoryPath(path);
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const component of dirname(path).split("/").filter((part) => part !== ".")) {
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Verifier baseline parent is unsafe: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Verifier baseline parent is unsafe: ${path}`);
    }
  }
  const destination = join(canonicalRoot, path);
  try {
    const metadata = await lstat(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Verifier baseline destination is unsafe: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return destination;
}

async function assertExactHead(root: string, expected: string, runner: CommandRunner): Promise<void> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(expected)) throw new Error("Verifier baseline identity is malformed.");
  const type = await runner.run(["git", "cat-file", "-t", expected], root);
  if (type.exitCode !== 0 || type.stdout.trim() !== "commit") throw new Error("Verifier baseline is missing or is not a commit.");
  const head = await runner.run(["git", "rev-parse", "--verify", "HEAD^{commit}"], root);
  const lines = head.stdout.split("\n").filter(Boolean);
  if (head.exitCode !== 0 || lines.length !== 1 || lines[0] !== expected) {
    throw new Error("Verifier baseline does not match the sealed verifier commit.");
  }
}

async function assertClean(root: string, runner: CommandRunner): Promise<void> {
  const status = await runner.run(["git", "status", "--porcelain=v1", "--untracked-files=all"], root);
  if (status.exitCode !== 0 || status.stdout !== "") throw new Error("Verifier baseline checkout did not start clean.");
}

function siblingArtifactPath(outputArtifact: string, name: string): string {
  assertRepositoryPath(outputArtifact);
  return `${dirname(outputArtifact)}/${name}`;
}

function assertRepositoryPath(path: string): void {
  if (typeof path !== "string" || !path || path.length > maximumPathLength || path.startsWith("/") || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Verifier baseline path is malformed.");
  }
}

function contained(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function expectSuccess(resultPromise: ReturnType<CommandRunner["run"]>, message: string): Promise<void> {
  const result = await resultPromise;
  if (result.exitCode !== 0) throw new Error(`${message}: ${result.stderr.trim()}`);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
