import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { CommandRunner } from "../infra/command-runner.js";
import { verifierManifestFilePaths } from "./artifacts.js";
import type { VerifierExecutionInputs } from "./verifier-execution-inputs.js";

const maximumTransferFiles = 10_000;
const maximumPathLength = 1_024;

export interface FreshVerifierWorkspaceHandle {
  readonly path: string;
  readonly expectedBaseSha: string;
  readonly productionFiles: readonly string[];
  readonly sealedFiles: readonly string[];
  assertReady(): Promise<void>;
  copyOutputTo(sourcePath: string, destinationRoot: string, destinationPath: string): Promise<void>;
  cleanup(): Promise<void>;
}

export class FreshVerifierWorkspace {
  constructor(
    private readonly baseDirectory: string,
    private readonly runner: CommandRunner,
  ) {}

  async create(
    sourceRepository: string,
    generatedWorkspace: string,
    inputs: VerifierExecutionInputs,
  ): Promise<FreshVerifierWorkspaceHandle> {
    const source = await realpath(sourceRepository);
    const generated = await realpath(generatedWorkspace);
    if (source === generated) throw new Error("Fresh verification requires separate source and generated workspaces.");
    await assertExpectedSourceHead(source, inputs.expectedBaseSha, this.runner);
    const productionFiles = validateTransferPaths(inputs.specification.allowedFiles, "production");
    const sealedFiles = validateTransferPaths(verifierManifestFilePaths(inputs.manifest), "sealed");
    const manifestPath = runArtifactPath(inputs.outputArtifact, "test-manifest.json");
    const allTransfers = [...productionFiles, ...sealedFiles, manifestPath];
    if (new Set(allTransfers).size !== allTransfers.length) {
      throw new Error("Fresh verifier transfer paths overlap.");
    }

    await mkdir(this.baseDirectory, { recursive: true });
    const temporary = await mkdtemp(join(this.baseDirectory, "fresh-verifier-"));
    const checkout = join(temporary, basename(source));
    try {
      await expectSuccess(
        this.runner.run(["git", "clone", "--no-local", "--no-checkout", "--", source, checkout], temporary),
        "Unable to create fresh verifier checkout",
      );
      await expectSuccess(
        this.runner.run(["git", "checkout", "--detach", inputs.expectedBaseSha], checkout),
        "Unable to check out the sealed verifier baseline",
      );
      await assertExactCheckout(checkout, inputs.expectedBaseSha, this.runner);
      for (const path of productionFiles) await transferProductionPath(generated, checkout, path);
      for (const path of sealedFiles) {
        await transferExactRegularFile(generated, checkout, path, inputs.manifest.files[path]);
      }
      await transferExactRegularFile(generated, checkout, manifestPath, inputs.manifestArtifactSha256);
      await expectSuccess(
        this.runner.run(["git", "add", "-N", "--all"], checkout),
        "Unable to prepare the fresh verifier diff",
      );
      await assertExpectedSourceHead(source, inputs.expectedBaseSha, this.runner);
      await assertExactCheckoutHead(checkout, inputs.expectedBaseSha, this.runner);
      return {
        path: checkout,
        expectedBaseSha: inputs.expectedBaseSha,
        productionFiles,
        sealedFiles,
        assertReady: async () => {
          await assertExpectedSourceHead(source, inputs.expectedBaseSha, this.runner);
          await assertExactCheckoutHead(checkout, inputs.expectedBaseSha, this.runner);
        },
        copyOutputTo: async (sourcePath, destinationRoot, destinationPath) => {
          assertRepositoryPath(sourcePath);
          assertRepositoryPath(destinationPath);
          await atomicCopyToRoot(await containedRegularFile(checkout, sourcePath), destinationRoot, destinationPath);
        },
        cleanup: async () => await rm(temporary, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}

async function assertExpectedSourceHead(root: string, expected: string, runner: CommandRunner): Promise<void> {
  assertCommitSha(expected);
  const type = await runner.run(["git", "cat-file", "-t", expected], root);
  if (type.exitCode !== 0 || type.stdout.trim() !== "commit") {
    throw new Error("Sealed verifier baseline is missing or is not a commit in the source repository.");
  }
  const head = await resolveExactCommit(root, "HEAD", runner);
  if (head !== expected) throw new Error("Source baseline advanced or no longer matches the sealed verifier commit.");
}

async function assertExactCheckout(root: string, expected: string, runner: CommandRunner): Promise<void> {
  await assertExactCheckoutHead(root, expected, runner);
  const status = await runner.run(["git", "status", "--porcelain=v1", "--untracked-files=all"], root);
  if (status.exitCode !== 0 || status.stdout !== "") throw new Error("Fresh verifier checkout did not start clean.");
}

async function assertExactCheckoutHead(root: string, expected: string, runner: CommandRunner): Promise<void> {
  const head = await resolveExactCommit(root, "HEAD", runner);
  if (head !== expected) throw new Error("Fresh verifier checkout does not match the sealed baseline commit.");
}

async function resolveExactCommit(root: string, ref: string, runner: CommandRunner): Promise<string> {
  const result = await runner.run(["git", "rev-parse", "--verify", `${ref}^{commit}`], root);
  const lines = result.stdout.split("\n").filter(Boolean);
  if (result.exitCode !== 0 || lines.length !== 1) throw new Error("Verifier baseline did not resolve to one unambiguous commit.");
  assertCommitSha(lines[0]!);
  return lines[0]!;
}

async function transferProductionPath(sourceRoot: string, destinationRoot: string, path: string): Promise<void> {
  try {
    const source = await containedRegularFile(sourceRoot, path);
    await atomicCopyToRoot(source, destinationRoot, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const destination = await safeDestination(destinationRoot, path);
    const metadata = await lstat(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Approved verifier deletion target is not a regular file: ${path}`);
    await unlink(destination);
  }
}

async function transferExactRegularFile(
  sourceRoot: string,
  destinationRoot: string,
  path: string,
  expectedSha256?: string,
): Promise<void> {
  assertRepositoryPath(path);
  const source = await containedRegularFile(sourceRoot, path);
  const metadata = await lstat(source);
  const content = await readFile(source);
  if (expectedSha256 !== undefined && sha256(content) !== expectedSha256) {
    throw new Error(`Verifier transfer input identity changed: ${path}`);
  }
  await atomicWrite(await safeDestination(destinationRoot, path), content, metadata.mode & 0o777);
}

async function atomicCopyToRoot(source: string, destinationRoot: string, destinationPath: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Verifier output is not a regular file.");
  await atomicWrite(await safeDestination(destinationRoot, destinationPath), await readFile(source), metadata.mode & 0o777);
}

async function atomicWrite(destination: string, content: Buffer, mode: number): Promise<void> {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.verifier-transfer-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function containedRegularFile(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const lexical = join(canonicalRoot, path);
  const metadata = await lstat(lexical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Verifier transfer input is not a regular file: ${path}`);
  const canonical = await realpath(lexical);
  if (!contained(canonicalRoot, canonical) || canonical !== lexical) throw new Error(`Verifier transfer input escapes its workspace: ${path}`);
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
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Verifier transfer parent is unsafe: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Verifier transfer parent is unsafe: ${path}`);
    }
  }
  const destination = join(canonicalRoot, path);
  try {
    const metadata = await lstat(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Verifier transfer destination is unsafe: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return destination;
}

function contained(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function validateTransferPaths(paths: readonly string[], kind: string): readonly string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > maximumTransferFiles) {
    throw new Error(`Fresh verifier ${kind} transfer list is empty or excessive.`);
  }
  const result = paths.map((path) => {
    assertRepositoryPath(path);
    return path;
  }).sort();
  if (new Set(result).size !== result.length) throw new Error(`Fresh verifier ${kind} transfer list contains duplicates.`);
  return result;
}

function runArtifactPath(outputArtifact: string, name: string): string {
  assertRepositoryPath(outputArtifact);
  return join(dirname(outputArtifact), name).split(sep).join("/");
}

function assertRepositoryPath(path: string): void {
  if (typeof path !== "string" || !path || path.length > maximumPathLength || path.startsWith("/")
    || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Fresh verifier transfer path is malformed.");
  }
}

function assertCommitSha(value: string): void {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) throw new Error("Verifier baseline identity is malformed.");
}

async function expectSuccess(resultPromise: ReturnType<CommandRunner["run"]>, message: string): Promise<void> {
  const result = await resultPromise;
  if (result.exitCode !== 0) throw new Error(`${message}: ${result.stderr.trim()}`);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
