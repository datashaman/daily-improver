import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { CommandRunner } from "../infra/command-runner.js";
import { verifierManifestFilePaths, verifyVerifierTestManifest } from "./artifacts.js";
import { assertVerificationReport, verificationReportSchemaVersion } from "../domain/verification-report.js";
import type { VerifierExecutionInputs } from "./verifier-execution-inputs.js";
import { artifactAuthenticationPath, signArtifact, verifyArtifact } from "./artifact-authentication.js";

const maximumTransferFiles = 10_000;
const maximumPathLength = 1_024;
const publisherArtifacts = [
  "daily-improvement-decision.json",
  "publication-authorization.json",
  "publication-request.json",
] as const;
const publisherArtifactSchemas = {
  "daily-improvement-decision.json": "daily-improvement-decision/v1",
  "publication-authorization.json": "publication-authorization/v1",
  "publication-request.json": "publication-request/v1",
} as const;

export interface VerifiedPublicationFile {
  readonly path: string;
  readonly state: "regular" | "deleted";
  readonly sha256?: string;
  readonly mode?: number;
}

export interface VerifiedPublicationPatch {
  readonly schemaVersion: "verified-publication-patch/v1";
  readonly expectedBaseSha: string;
  readonly verifierInputsSha256: string;
  readonly verificationReportSha256: string;
  readonly verificationLifecycleSha256: string;
  readonly files: readonly VerifiedPublicationFile[];
}

export interface TrustedPublicationWorkspaceHandle {
  readonly path: string;
  readonly patch: VerifiedPublicationPatch;
  commitToBranch(repository: string, branch: string, message: string): Promise<string>;
  cleanup(): Promise<void>;
}

export class TrustedPublicationWorkspace {
  constructor(
    private readonly baseDirectory: string,
    private readonly runner: CommandRunner,
    private readonly artifactKey: string,
  ) {}

  async create(
    sourceRepository: string,
    verifiedWorkspace: string,
    inputs: VerifierExecutionInputs,
    verification: unknown,
    verificationLifecyclePath: string,
  ): Promise<TrustedPublicationWorkspaceHandle> {
    assertVerificationBinding(inputs, verification);
    const source = await realpath(sourceRepository);
    const verified = await realpath(verifiedWorkspace);
    if (source === verified) throw new Error("Trusted publication requires a separate verified workspace.");
    await assertExactHead(source, inputs.expectedBaseSha, this.runner, "Trusted publication baseline changed");
    await assertExactHead(verified, inputs.expectedBaseSha, this.runner, "Verified publication source baseline changed");

    const productionPaths = validatePaths(inputs.specification.allowedFiles, "production");
    const sealedPaths = validatePaths(verifierManifestFilePaths(inputs.manifest), "sealed");
    const manifestPath = siblingArtifactPath(inputs.outputArtifact, "test-manifest.json");
    const patchPath = siblingArtifactPath(inputs.outputArtifact, "verified-publication-patch.json");
    const reportAuthenticationPath = artifactAuthenticationPath(inputs.outputArtifact);
    const lifecycleAuthenticationPath = artifactAuthenticationPath(verificationLifecyclePath);
    const patchAuthenticationPath = artifactAuthenticationPath(patchPath);
    assertRepositoryPath(verificationLifecyclePath);
    const transferPaths = [
      ...productionPaths,
      ...sealedPaths,
      manifestPath,
      inputs.outputArtifact,
      reportAuthenticationPath,
      verificationLifecyclePath,
      lifecycleAuthenticationPath,
    ];
    if (new Set(transferPaths).size !== transferPaths.length) throw new Error("Trusted publication transfer paths overlap.");

    await assertOnlyExpectedWorkspaceChanges(verified, transferPaths, this.runner);
    await assertFileSha256(verified, manifestPath, inputs.manifestArtifactSha256);
    if (!(await verifyVerifierTestManifest(verified, inputs.manifest, this.artifactKey))) {
      throw new Error("Trusted publication test manifest authentication failed.");
    }
    for (const path of sealedPaths) await assertFileSha256(verified, path, inputs.manifest.files[path]!);
    const reportBytes = await verifyArtifact(verified, inputs.outputArtifact, verificationReportSchemaVersion, this.artifactKey);
    const parsedReport = assertVerificationReport(JSON.parse(reportBytes.toString("utf8")), {
      expectedBaseSha: inputs.expectedBaseSha,
      verifierInputsSha256: inputs.integritySha256,
      mutationMode: inputs.mutationMode === "targeted" ? "targeted" : "off",
      commands: inputs.commands,
    });
    assertVerificationBinding(inputs, parsedReport);
    if (JSON.stringify(parsedReport) !== JSON.stringify(verification)) {
      throw new Error("Trusted publication verification report does not match the successful verifier result.");
    }
    const lifecycleBytes = await verifyArtifact(
      verified,
      verificationLifecyclePath,
      "generated-test-lifecycle-decision/v1",
      this.artifactKey,
    );
    const files = await Promise.all([...productionPaths, ...sealedPaths, manifestPath].sort().map(
      async (path) => await describeVerifiedFile(verified, path, productionPaths.includes(path)),
    ));
    const patch: VerifiedPublicationPatch = deepFreeze({
      schemaVersion: "verified-publication-patch/v1",
      expectedBaseSha: inputs.expectedBaseSha,
      verifierInputsSha256: inputs.integritySha256,
      verificationReportSha256: sha256(reportBytes),
      verificationLifecycleSha256: sha256(lifecycleBytes),
      files,
    });

    await mkdir(this.baseDirectory, { recursive: true });
    const temporary = await mkdtemp(join(this.baseDirectory, "trusted-publication-"));
    const checkout = join(temporary, basename(source));
    try {
      await expectSuccess(
        this.runner.run(["git", "clone", "--no-local", "--no-checkout", "--", source, checkout], temporary),
        "Unable to create trusted publication checkout",
      );
      await expectSuccess(
        this.runner.run(["git", "checkout", "--detach", inputs.expectedBaseSha], checkout),
        "Unable to check out trusted publication baseline",
      );
      await assertCleanCheckout(checkout, inputs.expectedBaseSha, this.runner);
      for (const file of files) await materializeVerifiedFile(verified, checkout, file);
      await transferBoundFile(verified, checkout, inputs.outputArtifact, patch.verificationReportSha256);
      await transferBoundFile(verified, checkout, reportAuthenticationPath, sha256(await readFile(await exactRegularFile(verified, reportAuthenticationPath))));
      await transferBoundFile(verified, checkout, verificationLifecyclePath, patch.verificationLifecycleSha256);
      await transferBoundFile(verified, checkout, lifecycleAuthenticationPath, sha256(await readFile(await exactRegularFile(verified, lifecycleAuthenticationPath))));
      const patchBytes = Buffer.from(`${JSON.stringify(patch, null, 2)}\n`);
      const patchSha256 = sha256(patchBytes);
      await atomicWrite(join(checkout, patchPath), patchBytes, 0o600);
      await signArtifact(checkout, patchPath, "verified-publication-patch/v1", this.artifactKey);
      await assertExactHead(source, inputs.expectedBaseSha, this.runner, "Trusted publication baseline changed");
      await assertExactHead(checkout, inputs.expectedBaseSha, this.runner, "Trusted publication checkout baseline changed");
      const publisherPaths = publisherArtifacts.map((name) => siblingArtifactPath(inputs.outputArtifact, name));
      const publisherAuthenticationPaths = publisherPaths.map((path) => artifactAuthenticationPath(path));
      const permittedPaths = [...transferPaths, patchPath, patchAuthenticationPath, ...publisherPaths, ...publisherAuthenticationPaths];
      const publicationDecisionPath = siblingArtifactPath(inputs.outputArtifact, "daily-improvement-decision.json");
      return {
        path: checkout,
        patch,
        commitToBranch: async (repository, branch, message) => {
          await assertExactHead(source, inputs.expectedBaseSha, this.runner, "Trusted publication baseline changed");
          await assertExactHead(checkout, inputs.expectedBaseSha, this.runner, "Trusted publication checkout baseline changed");
          await assertMaterializedPatch(checkout, patch, inputs.outputArtifact, verificationLifecyclePath, publicationDecisionPath);
          await assertFileSha256(checkout, patchPath, patchSha256);
          await verifyArtifact(checkout, patchPath, "verified-publication-patch/v1", this.artifactKey);
          const reportBytes = await verifyArtifact(checkout, inputs.outputArtifact, verificationReportSchemaVersion, this.artifactKey);
          assertVerificationReport(JSON.parse(reportBytes.toString("utf8")), {
            expectedBaseSha: inputs.expectedBaseSha,
            verifierInputsSha256: inputs.integritySha256,
            mutationMode: inputs.mutationMode === "targeted" ? "targeted" : "off",
            commands: inputs.commands,
          });
          await verifyArtifact(checkout, verificationLifecyclePath, "generated-test-lifecycle-decision/v1", this.artifactKey);
          for (const name of publisherArtifacts) {
            await verifyArtifact(
              checkout,
              siblingArtifactPath(inputs.outputArtifact, name),
              publisherArtifactSchemas[name],
              this.artifactKey,
            );
          }
          await assertOnlyExpectedWorkspaceChanges(checkout, permittedPaths, this.runner);
          assertBranchName(branch);
          if (!message || message.length > 512 || message.includes("\0")) throw new Error("Publication commit message is malformed.");
          await stagePaths(checkout, permittedPaths, this.runner);
          const committedPaths = await changedPaths(checkout, ["git", "diff", "--cached", "--name-only", "-z"], this.runner);
          if (committedPaths.length === 0 || committedPaths.some((path) => !permittedPaths.includes(path))) {
            throw new Error("Trusted publication staged an empty or unauthorized patch.");
          }
          await expectSuccess(this.runner.run(["git", "commit", "-m", message], checkout), "Unable to commit trusted publication patch");
          const commit = await resolveExactCommit(checkout, "HEAD", this.runner);
          const destination = await realpath(repository);
          if (destination !== source) throw new Error("Trusted publication branch destination changed.");
          await expectSuccess(
            this.runner.run(["git", "fetch", "--no-tags", "--force", "--", checkout, `HEAD:refs/heads/${branch}`], source),
            "Unable to publish trusted commit to the requested branch",
          );
          const published = await resolveExactCommit(source, `refs/heads/${branch}`, this.runner);
          if (published !== commit) throw new Error("Published branch does not match the trusted publication commit.");
          return commit;
        },
        cleanup: async () => await rm(temporary, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
}

async function describeVerifiedFile(root: string, path: string, deletionAllowed: boolean): Promise<VerifiedPublicationFile> {
  try {
    const source = await exactRegularFile(root, path);
    const metadata = await lstat(source);
    return { path, state: "regular", sha256: sha256(await readFile(source)), mode: metadata.mode & 0o777 };
  } catch (error) {
    if (deletionAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return { path, state: "deleted" };
    throw error;
  }
}

async function materializeVerifiedFile(sourceRoot: string, destinationRoot: string, file: VerifiedPublicationFile): Promise<void> {
  if (file.state === "deleted") {
    const destination = await safeDestination(destinationRoot, file.path);
    const metadata = await lstat(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Trusted publication deletion target is unsafe: ${file.path}`);
    await unlink(destination);
    return;
  }
  if (!file.sha256 || file.mode === undefined) throw new Error("Trusted publication regular-file identity is incomplete.");
  await transferBoundFile(sourceRoot, destinationRoot, file.path, file.sha256, file.mode);
}

async function transferBoundFile(sourceRoot: string, destinationRoot: string, path: string, expectedSha256: string, expectedMode?: number): Promise<void> {
  const source = await exactRegularFile(sourceRoot, path);
  const metadata = await lstat(source);
  const content = await readFile(source);
  if (sha256(content) !== expectedSha256 || (expectedMode !== undefined && (metadata.mode & 0o777) !== expectedMode)) {
    throw new Error(`Trusted publication input identity changed: ${path}`);
  }
  await atomicWrite(await safeDestination(destinationRoot, path), content, expectedMode ?? (metadata.mode & 0o777));
}

async function assertMaterializedPatch(
  root: string,
  patch: VerifiedPublicationPatch,
  reportPath: string,
  lifecyclePath: string,
  publicationDecisionPath: string,
): Promise<void> {
  assertVerifiedPublicationPatchContract(patch);
  for (const file of patch.files) {
    // The trusted publisher alone transitions this control artifact from claimed to completed.
    if (file.path === publicationDecisionPath) continue;
    if (file.state === "deleted") {
      try { await lstat(join(root, file.path)); throw new Error(`Trusted publication deletion was not preserved: ${file.path}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      continue;
    }
    await assertFileSha256(root, file.path, file.sha256!);
    const metadata = await lstat(await exactRegularFile(root, file.path));
    if ((metadata.mode & 0o777) !== file.mode) throw new Error(`Trusted publication mode changed: ${file.path}`);
  }
  await assertFileSha256(root, reportPath, patch.verificationReportSha256);
  await assertFileSha256(root, lifecyclePath, patch.verificationLifecycleSha256);
}

export async function assertVerifiedPublicationPatchMaterialized(
  root: string,
  patch: VerifiedPublicationPatch,
  reportPath: string,
  lifecyclePath: string,
  publicationDecisionPath: string,
): Promise<void> {
  await assertMaterializedPatch(root, patch, reportPath, lifecyclePath, publicationDecisionPath);
}

function assertVerifiedPublicationPatchContract(patch: VerifiedPublicationPatch): void {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)
    || Object.keys(patch).sort().join("|") !== "expectedBaseSha|files|schemaVersion|verificationLifecycleSha256|verificationReportSha256|verifierInputsSha256"
    || patch.schemaVersion !== "verified-publication-patch/v1") {
    throw new Error("Verified publication patch must use the exact verified-publication-patch/v1 contract.");
  }
  assertCommitSha(patch.expectedBaseSha);
  for (const identity of [patch.verifierInputsSha256, patch.verificationReportSha256, patch.verificationLifecycleSha256]) {
    if (!/^[a-f0-9]{64}$/u.test(identity)) throw new Error("Verified publication patch identity is malformed.");
  }
  if (!Array.isArray(patch.files) || patch.files.length === 0 || patch.files.length > maximumTransferFiles) {
    throw new Error("Verified publication patch file inventory is empty or excessive.");
  }
  const paths = patch.files.map((file) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) throw new Error("Verified publication patch file is malformed.");
    assertRepositoryPath(file.path);
    if (file.state === "deleted") {
      if (Object.keys(file).sort().join("|") !== "path|state") throw new Error("Verified publication deletion contract is extended or malformed.");
    } else if (file.state === "regular") {
      if (Object.keys(file).sort().join("|") !== "mode|path|sha256|state"
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)
        || !Number.isInteger(file.mode) || file.mode! < 0 || file.mode! > 0o777) {
        throw new Error("Verified publication regular-file contract is extended or malformed.");
      }
    } else {
      throw new Error("Verified publication file state is unsupported.");
    }
    return file.path;
  });
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    throw new Error("Verified publication patch file inventory is duplicate or ambiguously ordered.");
  }
}

async function assertOnlyExpectedWorkspaceChanges(root: string, expected: readonly string[], runner: CommandRunner): Promise<void> {
  const paths = await changedPaths(root, ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], runner, true);
  const allowed = new Set(expected);
  const unexpected = paths.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) throw new Error(`Trusted publication workspace contains an additional or unverified path: ${unexpected[0]}`);
}

async function changedPaths(root: string, command: readonly string[], runner: CommandRunner, porcelain = false): Promise<readonly string[]> {
  const result = await runner.run(command, root);
  if (result.exitCode !== 0) throw new Error("Unable to inspect trusted publication workspace state.");
  const entries = result.stdout.split("\0").filter(Boolean);
  return entries.map((entry) => {
    const path = porcelain ? entry.slice(3) : entry;
    assertRepositoryPath(path);
    return path;
  }).sort();
}

async function stagePaths(root: string, paths: readonly string[], runner: CommandRunner): Promise<void> {
  for (let index = 0; index < paths.length; index += 128) {
    await expectSuccess(runner.run(["git", "add", "--", ...paths.slice(index, index + 128)], root), "Unable to stage trusted publication paths");
  }
}

async function assertFileSha256(root: string, path: string, expected: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(expected) || sha256(await readFile(await exactRegularFile(root, path))) !== expected) {
    throw new Error(`Trusted publication input identity changed: ${path}`);
  }
}

async function exactRegularFile(root: string, path: string): Promise<string> {
  assertRepositoryPath(path);
  const canonicalRoot = await realpath(root);
  const lexical = join(canonicalRoot, path);
  const metadata = await lstat(lexical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Trusted publication input is not a regular file: ${path}`);
  const canonical = await realpath(lexical);
  if (!contained(canonicalRoot, canonical) || canonical !== lexical) throw new Error(`Trusted publication input escapes its workspace: ${path}`);
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
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Trusted publication parent is unsafe: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  const destination = join(canonicalRoot, path);
  try {
    const metadata = await lstat(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Trusted publication destination is unsafe: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return destination;
}

async function atomicWrite(destination: string, content: Buffer, mode: number): Promise<void> {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.publication-transfer-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertCleanCheckout(root: string, expected: string, runner: CommandRunner): Promise<void> {
  await assertExactHead(root, expected, runner, "Trusted publication checkout baseline changed");
  const status = await runner.run(["git", "status", "--porcelain=v1", "--untracked-files=all"], root);
  if (status.exitCode !== 0 || status.stdout !== "") throw new Error("Trusted publication checkout did not start clean.");
}

async function assertExactHead(root: string, expected: string, runner: CommandRunner, message: string): Promise<void> {
  assertCommitSha(expected);
  const resolved = await resolveExactCommit(root, "HEAD", runner);
  if (resolved !== expected) throw new Error(`${message}.`);
  const type = await runner.run(["git", "cat-file", "-t", expected], root);
  if (type.exitCode !== 0 || type.stdout.trim() !== "commit") throw new Error(`${message}: expected object is not a commit.`);
}

async function resolveExactCommit(root: string, reference: string, runner: CommandRunner): Promise<string> {
  const result = await runner.run(["git", "rev-parse", "--verify", `${reference}^{commit}`], root);
  const lines = result.stdout.split("\n").filter(Boolean);
  if (result.exitCode !== 0 || lines.length !== 1) throw new Error("Trusted publication reference did not resolve to one commit.");
  assertCommitSha(lines[0]!);
  return lines[0]!;
}

function assertVerificationBinding(inputs: VerifierExecutionInputs, verification: unknown): void {
  assertVerificationReport(verification, {
    expectedBaseSha: inputs.expectedBaseSha,
    verifierInputsSha256: inputs.integritySha256,
    mutationMode: inputs.mutationMode === "targeted" ? "targeted" : "off",
    commands: inputs.commands,
  });
}

function validatePaths(paths: readonly string[], kind: string): readonly string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > maximumTransferFiles) {
    throw new Error(`Trusted publication ${kind} path list is empty or excessive.`);
  }
  const result = paths.map((path) => { assertRepositoryPath(path); return path; }).sort();
  if (new Set(result).size !== result.length) throw new Error(`Trusted publication ${kind} path list contains duplicates.`);
  return result;
}

function siblingArtifactPath(outputArtifact: string, name: string): string {
  assertRepositoryPath(outputArtifact);
  return `${dirname(outputArtifact)}/${name}`;
}

function assertRepositoryPath(path: string): void {
  if (typeof path !== "string" || !path || path.length > maximumPathLength || path.startsWith("/")
    || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Trusted publication path is malformed.");
  }
}

function assertBranchName(value: string): void {
  if (!value || value.length > 256 || value.startsWith("-") || value.includes("..") || value.includes("\0")
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)) throw new Error("Trusted publication branch is malformed.");
}

function assertCommitSha(value: string): void {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) throw new Error("Trusted publication commit identity is malformed.");
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
