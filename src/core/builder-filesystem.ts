import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, copyFile, cp, glob, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { minimatch } from "minimatch";
import type { AgentContext, BuilderExecution } from "../agents/agent-provider.js";

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
  constructor(private readonly workspaceBase: string) {}

  async execute(
    context: AgentContext,
    protection: BuilderProtectionInput,
    build: (isolatedContext: AgentContext) => Promise<BuilderExecution | void>,
  ): Promise<BuilderExecution | void> {
    const allowlist = deriveBuilderWriteAllowlist(context);
    const root = await realpath(context.repository);
    await assertSafeTargets(root, allowlist.files);
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
      await materializeReadOnlyProtectedInputs(workspace, protectedInputs);
      const specPath = relative(root, await realpath(context.specPath));
      assertExactRepositoryFile(specPath);
      const isolatedContext: AgentContext = {
        ...context,
        repository: workspace,
        specPath: join(workspace, specPath),
        spec: { ...context.spec, allowedFiles: allowlist.files },
      };
      const result = await build(isolatedContext);
      await assertProtectedInputsReadOnly(workspace, protectedInputs);
      await importAllowedFiles(workspace, root, allowlist.files);
      return result;
    } finally {
      await makeProtectedInputsRemovable(workspace, protectedInputs);
      await rm(temporary, { recursive: true, force: true });
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
      files.set(path, { sha256: await hashFile(join(root, path)), source: "trusted-configuration" });
      if (files.size > maximumProtectedFiles) throw new Error("Builder protected inputs exceed the file limit.");
    }
  }
  for (const [path, sha256] of Object.entries(protection.sealedFiles)) {
    assertExactRepositoryFile(path);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`Builder sealed artifact identity is malformed: ${path}`);
    const metadata = await assertSafeProtectedPath(root, path);
    if (!metadata.isFile()) throw new Error(`Builder sealed artifact is not a regular file: ${path}`);
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

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function importAllowedFiles(workspace: string, root: string, files: readonly string[]): Promise<void> {
  await assertSafeTargets(workspace, files);
  await assertSafeTargets(root, files);
  for (const file of files) {
    const source = join(workspace, file);
    const target = join(root, file);
    try {
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Builder produced an unsupported allowed-file target: ${file}`);
      }
      const temporary = join(dirname(target), `.daily-improver-builder-${randomUUID()}.tmp`);
      try {
        await copyFile(source, temporary);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rm(target, { force: true });
    }
  }
}
