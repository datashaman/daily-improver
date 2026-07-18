import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, cp, glob, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { minimatch } from "minimatch";
import type { AgentContext, BuilderExecution } from "../agents/agent-provider.js";
import {
  BuilderFilesystemStateCapturer,
  deriveBuilderFilesystemChangeSet,
} from "./builder-filesystem-state.js";
import type { BuilderFilesystemChangeSet, BuilderFilesystemState } from "./builder-filesystem-state.js";

const maximumPathLength = 1_024;
const maximumProtectedFiles = 10_000;

export interface BuilderWriteAllowlist {
  readonly schemaVersion: "builder-write-allowlist/v1";
  readonly files: readonly string[];
}

export interface BuilderProtectedInputs {
  readonly schemaVersion: "builder-protected-inputs/v1";
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly source: "trusted-configuration" | "sealed-artifact";
  }[];
}

export interface BuilderProtectionInput {
  readonly trustedPatterns: readonly string[];
  readonly sealedFiles: Readonly<Record<string, string>>;
}

interface PathIdentity {
  readonly device: number;
  readonly inode: number;
}

interface FileIdentity extends PathIdentity {
  readonly size: number;
  readonly modifiedAtMs: number;
}

interface PathConfinementSnapshot {
  readonly root: PathIdentity;
  readonly parents: ReadonlyMap<string, PathIdentity>;
  readonly targets: ReadonlyMap<string, FileIdentity | undefined>;
}

interface StagedAllowedFile {
  readonly path: string;
  readonly stagedPath?: string;
  readonly stagedIdentity?: FileIdentity;
  readonly stagedParentIdentity?: PathIdentity;
  readonly sha256?: string;
  readonly mode?: number;
  readonly workspaceIdentity?: FileIdentity;
}

interface BuilderFilesystemSynchronization {
  readonly beforeImport?: (workspace: string) => Promise<void>;
  readonly afterStateCapture?: (capture: BuilderFilesystemExecutionState) => Promise<void>;
}

export interface BuilderFilesystemExecutionState {
  readonly before: BuilderFilesystemState;
  readonly after: BuilderFilesystemState;
  readonly changes: BuilderFilesystemChangeSet;
}

export function deriveBuilderWriteAllowlist(context: AgentContext): BuilderWriteAllowlist {
  const entries = context.spec.allowedFiles;
  if (entries.length === 0 || entries.length > context.spec.constraints.maxFiles) {
    throw new Error("Builder write allowlist must be non-empty and within the specification file limit.");
  }
  const seen = new Set<string>();
  const files: string[] = [];
  for (const entry of entries) {
    assertExactRepositoryFile(entry);
    if (seen.has(entry)) throw new Error(`Builder write allowlist contains a duplicate path: ${entry}`);
    seen.add(entry);
    if (context.inputs.protectedFiles.some((pattern) => protectedBy(entry, pattern))) {
      throw new Error(`Builder write allowlist targets a protected path: ${entry}`);
    }
    files.push(entry);
  }
  return { schemaVersion: "builder-write-allowlist/v1", files: files.sort() };
}

export class IsolatedBuilderFilesystem {
  constructor(
    private readonly workspaceBase: string,
    private readonly synchronization: BuilderFilesystemSynchronization = {},
    private readonly stateCapturer = new BuilderFilesystemStateCapturer(),
  ) {}

  async execute(
    context: AgentContext,
    protection: BuilderProtectionInput,
    build: (isolatedContext: AgentContext) => Promise<BuilderExecution | void>,
  ): Promise<BuilderExecution | void> {
    const allowlist = deriveBuilderWriteAllowlist(context);
    const root = await realpath(context.repository);
    await assertSafeTargets(root, allowlist.files);
    const sourceConfinement = await capturePathConfinement(root, allowlist.files);
    const protectedInputs = await deriveBuilderProtectedInputs(root, protection);
    await mkdir(this.workspaceBase, { recursive: true });
    const temporary = await mkdtemp(join(this.workspaceBase, "builder-filesystem-"));
    const workspace = join(temporary, "repository");
    try {
      await cp(root, workspace, {
        recursive: true,
        filter: (source) => relative(root, source).split("/")[0] !== ".git",
      });
      await assertSafeTargets(workspace, allowlist.files);
      const workspaceConfinement = await capturePathConfinement(workspace, allowlist.files);
      await materializeReadOnlyProtectedInputs(workspace, protectedInputs);
      const specPath = relative(root, await realpath(context.specPath));
      assertExactRepositoryFile(specPath);
      const isolatedContext: AgentContext = {
        ...context,
        repository: workspace,
        specPath: join(workspace, specPath),
        spec: { ...context.spec, allowedFiles: allowlist.files },
      };
      const before = await this.stateCapturer.capture(workspace);
      let result: BuilderExecution | void = undefined;
      let buildFailed = false;
      let buildFailure: unknown;
      try {
        result = await build(isolatedContext);
      } catch (error) {
        buildFailed = true;
        buildFailure = error;
      }
      const after = await this.stateCapturer.capture(workspace);
      const changes = deriveBuilderFilesystemChangeSet(before, after);
      assertBuilderProtectedFilesystemUnchanged({ before, after, changes }, protectedInputs);
      await this.synchronization.afterStateCapture?.({ before, after, changes });
      if (buildFailed) throw buildFailure;
      await assertProtectedInputsReadOnly(workspace, protectedInputs);
      await assertPathConfinement(workspace, allowlist.files, workspaceConfinement, false);
      const staged = await stageAllowedFiles(workspace, temporary, allowlist.files, workspaceConfinement);
      await this.synchronization.beforeImport?.(workspace);
      await assertProtectedInputsReadOnly(workspace, protectedInputs);
      await importAllowedFiles(workspace, root, staged, workspaceConfinement, sourceConfinement);
      return result;
    } finally {
      await makeProtectedInputsRemovable(workspace, protectedInputs);
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

export function assertBuilderProtectedFilesystemUnchanged(
  state: BuilderFilesystemExecutionState,
  inputs: BuilderProtectedInputs,
): void {
  if (inputs.schemaVersion !== "builder-protected-inputs/v1" || inputs.files.length === 0) {
    throw new Error("Builder protected inputs must be a non-empty versioned value.");
  }
  const beforeByPath = new Map(state.before.entries.map((entry) => [entry.path, entry]));
  const protectedFiles = new Set<string>();
  const protectedParents = new Set<string>();
  for (const input of inputs.files) {
    assertExactRepositoryFile(input.path);
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)
      || (input.source !== "trusted-configuration" && input.source !== "sealed-artifact")) {
      throw new Error(`Builder protected input identity is malformed: ${input.path}`);
    }
    const baseline = beforeByPath.get(input.path);
    if (baseline?.type !== "regular-file" || baseline.sha256 !== input.sha256) {
      throw new Error(`Builder protected input identity does not match the captured baseline: ${input.path}`);
    }
    protectedFiles.add(input.path);
    for (const parent of repositoryParents(input.path)) {
      if (beforeByPath.get(parent)?.type !== "directory") {
        throw new Error(`Builder protected input parent does not match the captured baseline: ${input.path}`);
      }
      protectedParents.add(parent);
    }
  }
  for (const change of state.changes.changes) {
    if (protectedFiles.has(change.path) || repositoryParents(change.path).some((parent) => protectedParents.has(parent))
      || protectedParents.has(change.path)) {
      throw new Error(`Builder changed a protected filesystem path: ${change.path}`);
    }
  }
}

export async function deriveBuilderProtectedInputs(
  root: string,
  protection: BuilderProtectionInput,
): Promise<BuilderProtectedInputs> {
  const files = new Map<string, { sha256: string; source: "trusted-configuration" | "sealed-artifact" }>();
  for (const pattern of protection.trustedPatterns) {
    assertSafeProtectedPattern(pattern);
    for await (const path of glob(pattern, { cwd: root, exclude: [".git/**", "**/node_modules/**"] })) {
      assertExactRepositoryFile(path);
      const metadata = await assertSafeProtectedPath(root, path);
      if (metadata.isDirectory()) continue;
      if (!metadata.isFile()) throw new Error(`Builder protected input is not a regular file: ${path}`);
      assertSingleLinkedFile(metadata, `Builder protected input has multiple hard links: ${path}`);
      files.set(path, { sha256: await hashFile(join(root, path)), source: "trusted-configuration" });
      if (files.size > maximumProtectedFiles) throw new Error("Builder protected inputs exceed the file limit.");
    }
  }
  for (const [path, sha256] of Object.entries(protection.sealedFiles)) {
    assertExactRepositoryFile(path);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`Builder sealed artifact identity is malformed: ${path}`);
    const metadata = await assertSafeProtectedPath(root, path);
    if (!metadata.isFile()) throw new Error(`Builder sealed artifact is not a regular file: ${path}`);
    assertSingleLinkedFile(metadata, `Builder sealed artifact has multiple hard links: ${path}`);
    if (await hashFile(join(root, path)) !== sha256) throw new Error(`Builder sealed artifact was replaced: ${path}`);
    files.set(path, { sha256, source: "sealed-artifact" });
    if (files.size > maximumProtectedFiles) throw new Error("Builder protected inputs exceed the file limit.");
  }
  if (files.size === 0) throw new Error("Builder requires at least one protected input.");
  return {
    schemaVersion: "builder-protected-inputs/v1",
    files: [...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, identity]) => ({ path, ...identity })),
  };
}

export async function assertProtectedInputsReadOnly(root: string, inputs: BuilderProtectedInputs): Promise<void> {
  for (const input of inputs.files) {
    const metadata = await assertSafeProtectedPath(root, input.path);
    if (!metadata.isFile()) throw new Error(`Builder protected input is not a regular file: ${input.path}`);
    assertSingleLinkedFile(metadata, `Builder protected input has multiple hard links: ${input.path}`);
    if ((metadata.mode & 0o222) !== 0) throw new Error(`Builder protected input is mutable: ${input.path}`);
    if (await hashFile(join(root, input.path)) !== input.sha256) throw new Error(`Builder protected input was replaced: ${input.path}`);
    const parent = await lstat(dirname(join(root, input.path)));
    if (!parent.isDirectory() || (parent.mode & 0o222) !== 0) {
      throw new Error(`Builder protected input parent is mutable: ${input.path}`);
    }
  }
}

async function materializeReadOnlyProtectedInputs(root: string, inputs: BuilderProtectedInputs): Promise<void> {
  for (const input of inputs.files) {
    const metadata = await assertSafeProtectedPath(root, input.path);
    if (!metadata.isFile() || await hashFile(join(root, input.path)) !== input.sha256) {
      throw new Error(`Builder protected input was replaced while materializing: ${input.path}`);
    }
    assertSingleLinkedFile(metadata, `Builder protected input has multiple hard links: ${input.path}`);
    await chmod(join(root, input.path), 0o444);
  }
  const parents = new Set(inputs.files.flatMap((input) => protectedParents(root, input.path)));
  for (const parent of [...parents].sort((left, right) => right.length - left.length)) await chmod(parent, 0o555);
  await assertProtectedInputsReadOnly(root, inputs);
}

async function makeProtectedInputsRemovable(root: string, inputs: BuilderProtectedInputs): Promise<void> {
  const parents = new Set(inputs.files.flatMap((input) => protectedParents(root, input.path)));
  for (const parent of [...parents].sort((left, right) => left.length - right.length)) {
    try { await chmod(parent, 0o755); } catch { /* The disposable workspace is removed immediately below. */ }
  }
  for (const input of inputs.files) {
    try { await chmod(join(root, input.path), 0o600); } catch { /* Missing or replaced inputs still require cleanup. */ }
  }
}

function assertExactRepositoryFile(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.length > maximumPathLength
    || isAbsolute(path) || path.includes("\\") || path.includes("\0") || /[*?[\]{}!]/u.test(path)) {
    throw new Error(`Builder write allowlist path must be one exact bounded repository-relative POSIX file: ${path}`);
  }
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Builder write allowlist path contains an empty or traversal segment: ${path}`);
  }
}

function assertSafeProtectedPattern(pattern: string): void {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > maximumPathLength
    || isAbsolute(pattern) || pattern.includes("\\") || pattern.includes("\0")
    || pattern.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Builder protected pattern must be a bounded repository-relative POSIX pattern: ${pattern}`);
  }
}

function protectedBy(path: string, pattern: string): boolean {
  if (path === pattern || minimatch(path, pattern)) return true;
  const firstPattern = pattern.search(/[*?[\]{}!]/u);
  if (firstPattern < 0) return path.startsWith(`${pattern.replace(/\/$/u, "")}/`);
  const prefix = pattern.slice(0, firstPattern).replace(/\/$/u, "");
  return prefix.length > 0 && (path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`));
}

async function assertSafeTargets(root: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    let current = root;
    for (const part of file.split("/")) {
      current = join(current, part);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) throw new Error(`Builder write allowlist path crosses a symbolic link: ${file}`);
        if (current !== join(root, file) && !metadata.isDirectory()) {
          throw new Error(`Builder write allowlist parent is not a directory: ${file}`);
        }
        if (current === join(root, file) && !metadata.isFile()) {
          throw new Error(`Builder write allowlist target is not a regular file: ${file}`);
        }
        if (current === join(root, file)) {
          assertSingleLinkedFile(metadata, `Builder write allowlist target has multiple hard links: ${file}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (current !== join(root, file)) throw new Error(`Builder write allowlist parent does not exist: ${file}`);
      }
    }
  }
}

async function assertSafeProtectedPath(root: string, path: string): Promise<Stats> {
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    let metadata: Stats;
    try { metadata = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Builder protected input is missing: ${path}`);
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error(`Builder protected input crosses a symbolic link: ${path}`);
    if (current !== join(root, path) && !metadata.isDirectory()) {
      throw new Error(`Builder protected input parent is not a directory: ${path}`);
    }
    if (current === join(root, path)) return metadata;
  }
  throw new Error(`Builder protected input is missing: ${path}`);
}

function protectedParents(root: string, path: string): readonly string[] {
  const parents: string[] = [];
  let current = dirname(join(root, path));
  while (current !== root) {
    parents.push(current);
    current = dirname(current);
  }
  return parents;
}

function repositoryParents(path: string): readonly string[] {
  const parts = path.split("/");
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) parents.push(parts.slice(0, index).join("/"));
  return parents;
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function assertSingleLinkedFile(metadata: Stats, message: string): void {
  if (metadata.nlink !== 1) throw new Error(message);
}

function pathIdentity(metadata: Stats): PathIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function fileIdentity(metadata: Stats): FileIdentity {
  return { ...pathIdentity(metadata), size: metadata.size, modifiedAtMs: metadata.mtimeMs };
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameFileIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : samePathIdentity(left, right) && left.size === right.size && left.modifiedAtMs === right.modifiedAtMs;
}

async function capturePathConfinement(root: string, files: readonly string[]): Promise<PathConfinementSnapshot> {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error("Builder repository root is not a confined directory.");
  const parents = new Map<string, PathIdentity>();
  const targets = new Map<string, FileIdentity | undefined>();
  for (const file of files) {
    assertExactRepositoryFile(file);
    let current = root;
    for (const part of file.split("/").slice(0, -1)) {
      current = join(current, part);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Builder write allowlist parent is not a confined directory: ${file}`);
      }
      parents.set(relative(root, current), pathIdentity(metadata));
    }
    try {
      const metadata = await lstat(join(root, file));
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Builder write allowlist target is not a regular file: ${file}`);
      }
      assertSingleLinkedFile(metadata, `Builder write allowlist target has multiple hard links: ${file}`);
      targets.set(file, fileIdentity(metadata));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      targets.set(file, undefined);
    }
  }
  return { root: pathIdentity(rootMetadata), parents, targets };
}

async function assertPathConfinement(
  root: string,
  files: readonly string[],
  snapshot: PathConfinementSnapshot,
  requireUnchangedTargets: boolean,
): Promise<void> {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory() || !samePathIdentity(snapshot.root, pathIdentity(rootMetadata))) {
    throw new Error("Builder repository root was replaced.");
  }
  for (const file of files) {
    let current = root;
    for (const part of file.split("/").slice(0, -1)) {
      current = join(current, part);
      const path = relative(root, current);
      const expected = snapshot.parents.get(path);
      const metadata = await lstat(current);
      if (expected === undefined || metadata.isSymbolicLink() || !metadata.isDirectory()
        || !samePathIdentity(expected, pathIdentity(metadata))) {
        throw new Error(`Builder write allowlist parent was replaced: ${file}`);
      }
    }
    let actual: FileIdentity | undefined;
    try {
      const metadata = await lstat(join(root, file));
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Builder produced an unsupported allowed-file target: ${file}`);
      }
      assertSingleLinkedFile(metadata, `Builder write allowlist target has multiple hard links: ${file}`);
      actual = fileIdentity(metadata);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (requireUnchangedTargets && !sameFileIdentity(snapshot.targets.get(file), actual)) {
      throw new Error(`Builder source checkout target changed during isolated execution: ${file}`);
    }
  }
}

async function stageAllowedFiles(
  workspace: string,
  temporary: string,
  files: readonly string[],
  confinement: PathConfinementSnapshot,
): Promise<readonly StagedAllowedFile[]> {
  const staging = join(temporary, "approved-files");
  await mkdir(staging);
  const stagingParentIdentity = pathIdentity(await lstat(staging));
  const staged: StagedAllowedFile[] = [];
  for (const file of files) {
    await assertPathConfinement(workspace, [file], confinement, false);
    const source = join(workspace, file);
    let sourceHandle;
    try {
      sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        staged.push({ path: file });
        continue;
      }
      throw error;
    }
    const stagedPath = join(staging, randomUUID());
    const destinationHandle = await open(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const openedMetadata = await sourceHandle.stat();
      if (!openedMetadata.isFile()) throw new Error(`Builder produced an unsupported allowed-file target: ${file}`);
      assertSingleLinkedFile(openedMetadata, `Builder write allowlist target has multiple hard links: ${file}`);
      const openedIdentity = fileIdentity(openedMetadata);
      const pathMetadata = await lstat(source);
      if (!sameFileIdentity(openedIdentity, fileIdentity(pathMetadata))) {
        throw new Error(`Builder write allowlist target changed while staging: ${file}`);
      }
      const sha256 = await copyOpenedFile(sourceHandle, destinationHandle, openedMetadata.size, file);
      await destinationHandle.chmod(openedMetadata.mode & 0o777);
      await destinationHandle.sync();
      await assertPathConfinement(workspace, [file], confinement, false);
      const finalPathMetadata = await lstat(source);
      const finalOpenedMetadata = await sourceHandle.stat();
      if (!sameFileIdentity(openedIdentity, fileIdentity(finalPathMetadata))
        || !sameFileIdentity(openedIdentity, fileIdentity(finalOpenedMetadata))) {
        throw new Error(`Builder write allowlist target changed while staging: ${file}`);
      }
      const stagedMetadata = await destinationHandle.stat();
      staged.push({
        path: file,
        stagedPath,
        stagedIdentity: fileIdentity(stagedMetadata),
        stagedParentIdentity: stagingParentIdentity,
        sha256,
        mode: openedMetadata.mode & 0o777,
        workspaceIdentity: openedIdentity,
      });
    } finally {
      await Promise.allSettled([sourceHandle.close(), destinationHandle.close()]);
    }
  }
  return staged;
}

async function copyOpenedFile(
  source: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
  size: number,
  path: string,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    const { bytesRead } = await source.read(buffer, 0, length, offset);
    if (bytesRead === 0) throw new Error(`Builder write allowlist target changed while staging: ${path}`);
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, offset + written);
      written += result.bytesWritten;
    }
    offset += bytesRead;
  }
  return hash.digest("hex");
}

async function assertStagedWorkspaceTarget(
  workspace: string,
  staged: StagedAllowedFile,
  confinement: PathConfinementSnapshot,
): Promise<void> {
  await assertPathConfinement(workspace, [staged.path], confinement, false);
  let actual: FileIdentity | undefined;
  try { actual = fileIdentity(await lstat(join(workspace, staged.path))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!sameFileIdentity(staged.workspaceIdentity, actual)) {
    throw new Error(`Builder write allowlist target changed before import: ${staged.path}`);
  }
}

async function importAllowedFiles(
  workspace: string,
  root: string,
  files: readonly StagedAllowedFile[],
  workspaceConfinement: PathConfinementSnapshot,
  sourceConfinement: PathConfinementSnapshot,
): Promise<void> {
  for (const file of files) {
    await assertStagedWorkspaceTarget(workspace, file, workspaceConfinement);
    await assertPathConfinement(root, [file.path], sourceConfinement, true);
    const target = join(root, file.path);
    if (file.stagedPath === undefined) {
      await assertStagedWorkspaceTarget(workspace, file, workspaceConfinement);
      await assertPathConfinement(root, [file.path], sourceConfinement, true);
      try { await unlink(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (file.stagedIdentity === undefined || file.stagedParentIdentity === undefined
      || file.sha256 === undefined || file.mode === undefined) {
      throw new Error(`Builder staged allowed-file identity is incomplete: ${file.path}`);
    }
    const temporary = join(dirname(target), `.daily-improver-builder-${randomUUID()}.tmp`);
    try {
      await assertTrustedStagedFile(file);
      await copyStagedAllowedFile(file, temporary);
      await assertTrustedStagedFile(file);
      if (await hashFile(temporary) !== file.sha256) {
        throw new Error(`Builder staged allowed file changed during import: ${file.path}`);
      }
      await assertStagedWorkspaceTarget(workspace, file, workspaceConfinement);
      await assertPathConfinement(root, [file.path], sourceConfinement, true);
      await rename(temporary, target);
      await assertPathConfinement(root, [file.path], await capturePathConfinement(root, [file.path]), true);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function assertTrustedStagedFile(file: StagedAllowedFile): Promise<void> {
  if (file.stagedPath === undefined || file.stagedIdentity === undefined
    || file.stagedParentIdentity === undefined || file.sha256 === undefined) {
    throw new Error(`Builder staged allowed-file identity is incomplete: ${file.path}`);
  }
  const parent = await lstat(dirname(file.stagedPath));
  if (parent.isSymbolicLink() || !parent.isDirectory()
    || !samePathIdentity(file.stagedParentIdentity, pathIdentity(parent))) {
    throw new Error(`Builder staged allowed-file parent was replaced: ${file.path}`);
  }
  const metadata = await lstat(file.stagedPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()
    || !sameFileIdentity(file.stagedIdentity, fileIdentity(metadata))) {
    throw new Error(`Builder staged allowed file was replaced: ${file.path}`);
  }
  assertSingleLinkedFile(metadata, `Builder staged allowed file has multiple hard links: ${file.path}`);
  if (await hashFile(file.stagedPath) !== file.sha256) {
    throw new Error(`Builder staged allowed file was replaced: ${file.path}`);
  }
}

async function copyStagedAllowedFile(file: StagedAllowedFile, target: string): Promise<void> {
  if (file.stagedPath === undefined || file.stagedIdentity === undefined
    || file.sha256 === undefined || file.mode === undefined) {
    throw new Error(`Builder staged allowed-file identity is incomplete: ${file.path}`);
  }
  const source = await open(file.stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination;
  try {
    const sourceMetadata = await source.stat();
    if (!sourceMetadata.isFile() || !sameFileIdentity(file.stagedIdentity, fileIdentity(sourceMetadata))) {
      throw new Error(`Builder staged allowed file was replaced: ${file.path}`);
    }
    assertSingleLinkedFile(sourceMetadata, `Builder staged allowed file has multiple hard links: ${file.path}`);
    destination = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      file.mode,
    );
    const digest = await copyOpenedFile(source, destination, sourceMetadata.size, file.path);
    await destination.chmod(file.mode);
    await destination.sync();
    const finalSourceMetadata = await source.stat();
    if (digest !== file.sha256 || !sameFileIdentity(file.stagedIdentity, fileIdentity(finalSourceMetadata))) {
      throw new Error(`Builder staged allowed file changed during import: ${file.path}`);
    }
  } finally {
    await Promise.allSettled([source.close(), ...(destination === undefined ? [] : [destination.close()])]);
  }
}
