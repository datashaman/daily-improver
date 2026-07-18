import { randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { minimatch } from "minimatch";
import type { AgentContext, BuilderExecution } from "../agents/agent-provider.js";

const maximumPathLength = 1_024;

export interface BuilderWriteAllowlist {
  readonly schemaVersion: "builder-write-allowlist/v1";
  readonly files: readonly string[];
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
    build: (isolatedContext: AgentContext) => Promise<BuilderExecution | void>,
  ): Promise<BuilderExecution | void> {
    const allowlist = deriveBuilderWriteAllowlist(context);
    const root = await realpath(context.repository);
    await assertSafeTargets(root, allowlist.files);
    await mkdir(this.workspaceBase, { recursive: true });
    const temporary = await mkdtemp(join(this.workspaceBase, "builder-filesystem-"));
    const workspace = join(temporary, "repository");
    try {
      await cp(root, workspace, {
        recursive: true,
        filter: (source) => relative(root, source).split("/")[0] !== ".git",
      });
      await assertSafeTargets(workspace, allowlist.files);
      const specPath = relative(root, await realpath(context.specPath));
      assertExactRepositoryFile(specPath);
      const isolatedContext: AgentContext = {
        ...context,
        repository: workspace,
        specPath: join(workspace, specPath),
        spec: { ...context.spec, allowedFiles: allowlist.files },
      };
      const result = await build(isolatedContext);
      await importAllowedFiles(workspace, root, allowlist.files);
      return result;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
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
