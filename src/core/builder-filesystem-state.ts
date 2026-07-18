import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type BuilderFilesystemEntryType = "regular-file" | "directory" | "symbolic-link" | "unsupported";

interface BuilderFilesystemEntryBase {
  readonly path: string;
  readonly type: BuilderFilesystemEntryType;
  readonly mode: number;
  readonly hardLinkCount: number;
}

export interface BuilderFilesystemRegularFileEntry extends BuilderFilesystemEntryBase {
  readonly type: "regular-file";
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface BuilderFilesystemDirectoryEntry extends BuilderFilesystemEntryBase {
  readonly type: "directory";
}

export interface BuilderFilesystemSymbolicLinkEntry extends BuilderFilesystemEntryBase {
  readonly type: "symbolic-link";
  readonly targetBytes: number;
  readonly targetSha256: string;
}

export interface BuilderFilesystemUnsupportedEntry extends BuilderFilesystemEntryBase {
  readonly type: "unsupported";
  readonly unsupportedType: "block-device" | "character-device" | "fifo" | "socket" | "unknown";
}

export type BuilderFilesystemEntry =
  | BuilderFilesystemRegularFileEntry
  | BuilderFilesystemDirectoryEntry
  | BuilderFilesystemSymbolicLinkEntry
  | BuilderFilesystemUnsupportedEntry;

export interface BuilderFilesystemState {
  readonly schemaVersion: "builder-filesystem-state/v1";
  readonly entries: readonly BuilderFilesystemEntry[];
}

export interface BuilderFilesystemStateLimits {
  readonly schemaVersion: "builder-filesystem-state-limits/v1";
  readonly maxEntries: number;
  readonly maxPathBytes: number;
  readonly maxTotalPathBytes: number;
  readonly maxFileBytes: number;
  readonly maxTotalFileBytes: number;
  readonly maxSymlinkTargetBytes: number;
}

export interface BuilderFilesystemChange {
  readonly path: string;
  readonly change: "added" | "modified" | "deleted" | "type-changed";
  readonly beforeType?: BuilderFilesystemEntryType;
  readonly afterType?: BuilderFilesystemEntryType;
}

export interface BuilderFilesystemChangeSet {
  readonly schemaVersion: "builder-filesystem-change-set/v1";
  readonly changes: readonly BuilderFilesystemChange[];
}

interface BuilderFilesystemCaptureSynchronization {
  readonly betweenStableCaptures?: (root: string) => Promise<void>;
}

interface CaptureBudget {
  entries: number;
  pathBytes: number;
  fileBytes: number;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export const defaultBuilderFilesystemStateLimits: BuilderFilesystemStateLimits = Object.freeze({
  schemaVersion: "builder-filesystem-state-limits/v1",
  maxEntries: 100_000,
  maxPathBytes: 1_024,
  maxTotalPathBytes: 16 * 1024 * 1024,
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalFileBytes: 16 * 1024 * 1024 * 1024,
  maxSymlinkTargetBytes: 4_096,
});

export class BuilderFilesystemStateCapturer {
  private readonly limits: BuilderFilesystemStateLimits;

  constructor(
    limits: BuilderFilesystemStateLimits = defaultBuilderFilesystemStateLimits,
    private readonly synchronization: BuilderFilesystemCaptureSynchronization = {},
  ) {
    this.limits = validateBuilderFilesystemStateLimits(limits);
  }

  async capture(root: string): Promise<BuilderFilesystemState> {
    if (!isAbsolute(root) || root.includes("\0")) {
      throw new Error("Builder filesystem state requires an absolute repository root.");
    }
    const first = await captureBuilderFilesystemStateOnce(root, this.limits);
    await this.synchronization.betweenStableCaptures?.(root);
    const second = await captureBuilderFilesystemStateOnce(root, this.limits);
    if (!sameState(first, second)) throw new Error("Builder filesystem state was unstable during capture.");
    return second;
  }
}

export function deriveBuilderFilesystemChangeSet(
  before: BuilderFilesystemState,
  after: BuilderFilesystemState,
): BuilderFilesystemChangeSet {
  validateBuilderFilesystemState(before);
  validateBuilderFilesystemState(after);
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();
  const changes: BuilderFilesystemChange[] = [];
  for (const path of paths) {
    const previous = beforeByPath.get(path);
    const next = afterByPath.get(path);
    if (previous === undefined && next !== undefined) {
      changes.push({ path, change: "added", afterType: next.type });
    } else if (previous !== undefined && next === undefined) {
      changes.push({ path, change: "deleted", beforeType: previous.type });
    } else if (previous !== undefined && next !== undefined && previous.type !== next.type) {
      changes.push({ path, change: "type-changed", beforeType: previous.type, afterType: next.type });
    } else if (previous !== undefined && next !== undefined && JSON.stringify(previous) !== JSON.stringify(next)) {
      changes.push({ path, change: "modified", beforeType: previous.type, afterType: next.type });
    }
  }
  return { schemaVersion: "builder-filesystem-change-set/v1", changes };
}

export function validateBuilderFilesystemStateLimits(value: BuilderFilesystemStateLimits): BuilderFilesystemStateLimits {
  if (!isExactObject(value, [
    "schemaVersion", "maxEntries", "maxPathBytes", "maxTotalPathBytes", "maxFileBytes",
    "maxTotalFileBytes", "maxSymlinkTargetBytes",
  ]) || value.schemaVersion !== "builder-filesystem-state-limits/v1") {
    throw new Error("Builder filesystem state limits must be an exact versioned value.");
  }
  assertBoundedInteger(value.maxEntries, 1, defaultBuilderFilesystemStateLimits.maxEntries, "entry");
  assertBoundedInteger(value.maxPathBytes, 1, defaultBuilderFilesystemStateLimits.maxPathBytes, "path");
  assertBoundedInteger(value.maxTotalPathBytes, value.maxPathBytes, defaultBuilderFilesystemStateLimits.maxTotalPathBytes, "total path");
  assertBoundedInteger(value.maxFileBytes, 1, defaultBuilderFilesystemStateLimits.maxFileBytes, "file byte");
  assertBoundedInteger(value.maxTotalFileBytes, value.maxFileBytes, defaultBuilderFilesystemStateLimits.maxTotalFileBytes, "total file byte");
  assertBoundedInteger(value.maxSymlinkTargetBytes, 1, defaultBuilderFilesystemStateLimits.maxSymlinkTargetBytes, "symbolic-link target");
  return Object.freeze({ ...value });
}

function assertBoundedInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Builder filesystem state ${name} limit is outside its supported bounds.`);
  }
}

async function captureBuilderFilesystemStateOnce(
  root: string,
  limits: BuilderFilesystemStateLimits,
): Promise<BuilderFilesystemState> {
  const budget: CaptureBudget = { entries: 0, pathBytes: 0, fileBytes: 0 };
  const entries: BuilderFilesystemEntry[] = [];
  const rootBefore = await safeLstat(root, "repository root");
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error("Builder filesystem state repository root is not a directory.");
  }
  await captureDirectory(root, "", entries, budget, limits);
  const rootAfter = await safeLstat(root, "repository root");
  if (!sameStableIdentity(rootBefore, rootAfter)) {
    throw new Error("Builder filesystem state repository root was unstable during capture.");
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const state: BuilderFilesystemState = { schemaVersion: "builder-filesystem-state/v1", entries };
  validateBuilderFilesystemState(state, limits);
  return state;
}

async function captureDirectory(
  root: string,
  parent: string,
  output: BuilderFilesystemEntry[],
  budget: CaptureBudget,
  limits: BuilderFilesystemStateLimits,
): Promise<void> {
  const absoluteParent = parent === "" ? root : join(root, parent);
  const directoryBefore = await safeLstat(absoluteParent, parent || "repository root");
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()
    || (Number(directoryBefore.mode) & 0o444) === 0 || (Number(directoryBefore.mode) & 0o111) === 0) {
    throw new Error(`Builder filesystem state directory is unreadable: ${parent || "."}`);
  }
  const names = await readDirectoryNames(absoluteParent, parent);
  for (const name of names) {
    const path = parent === "" ? name : `${parent}/${name}`;
    assertStatePath(path, limits);
    budget.entries += 1;
    budget.pathBytes += Buffer.byteLength(path);
    if (budget.entries > limits.maxEntries) throw new Error("Builder filesystem state exceeds its entry limit.");
    if (budget.pathBytes > limits.maxTotalPathBytes) throw new Error("Builder filesystem state exceeds its total path limit.");
    const absolute = join(root, path);
    const before = await safeLstat(absolute, path);
    if (before.isFile()) {
      if ((Number(before.mode) & 0o444) === 0) throw new Error(`Builder filesystem state regular file is unreadable: ${path}`);
      const size = safeNumber(before.size, `Builder filesystem state file size is unsupported: ${path}`);
      budget.fileBytes += size;
      if (size > limits.maxFileBytes) throw new Error(`Builder filesystem state file exceeds its byte limit: ${path}`);
      if (budget.fileBytes > limits.maxTotalFileBytes) throw new Error("Builder filesystem state exceeds its total file byte limit.");
      const { sha256, final: openedAfter } = await hashStableRegularFile(absolute, before, path);
      const pathAfter = await safeLstat(absolute, path);
      if (!sameStableIdentity(before, openedAfter) || !sameStableIdentity(before, pathAfter)) {
        throw new Error(`Builder filesystem state entry was unstable during capture: ${path}`);
      }
      output.push({ path, type: "regular-file", mode: permissionMode(before), hardLinkCount: linkCount(before, path), sizeBytes: size, sha256 });
    } else if (before.isDirectory()) {
      output.push({ path, type: "directory", mode: permissionMode(before), hardLinkCount: linkCount(before, path) });
      await captureDirectory(root, path, output, budget, limits);
      const after = await safeLstat(absolute, path);
      if (!sameStableIdentity(before, after)) throw new Error(`Builder filesystem state entry was unstable during capture: ${path}`);
    } else if (before.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: "buffer" });
      const targetBytes = target.byteLength;
      if (targetBytes > limits.maxSymlinkTargetBytes) {
        throw new Error(`Builder filesystem state symbolic-link target exceeds its byte limit: ${path}`);
      }
      const after = await safeLstat(absolute, path);
      if (!sameStableIdentity(before, after)) throw new Error(`Builder filesystem state entry was unstable during capture: ${path}`);
      output.push({
        path,
        type: "symbolic-link",
        mode: permissionMode(before),
        hardLinkCount: linkCount(before, path),
        targetBytes,
        targetSha256: createHash("sha256").update(target).digest("hex"),
      });
    } else {
      const after = await safeLstat(absolute, path);
      if (!sameStableIdentity(before, after)) throw new Error(`Builder filesystem state entry was unstable during capture: ${path}`);
      output.push({
        path,
        type: "unsupported",
        mode: permissionMode(before),
        hardLinkCount: linkCount(before, path),
        unsupportedType: unsupportedType(before),
      });
    }
  }
  const namesAfter = await readDirectoryNames(absoluteParent, parent);
  const directoryAfter = await safeLstat(absoluteParent, parent || "repository root");
  if (JSON.stringify(names) !== JSON.stringify(namesAfter) || !sameStableIdentity(directoryBefore, directoryAfter)) {
    throw new Error(`Builder filesystem state directory was unstable during capture: ${parent || "."}`);
  }
}

async function readDirectoryNames(path: string, displayPath: string): Promise<readonly string[]> {
  let names: Buffer[];
  try { names = await readdir(path, { encoding: "buffer" }); }
  catch { throw new Error(`Builder filesystem state directory is unreadable: ${displayPath || "."}`); }
  return names.map((name) => {
    try { return utf8.decode(name); }
    catch { throw new Error(`Builder filesystem state contains a malformed path below: ${displayPath || "."}`); }
  }).sort();
}

async function hashStableRegularFile(
  path: string,
  expected: BigIntStats,
  displayPath: string,
): Promise<{ readonly sha256: string; readonly final: BigIntStats }> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error(`Builder filesystem state regular file is unreadable: ${displayPath}`); }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStableIdentity(expected, opened)) {
      throw new Error(`Builder filesystem state entry was unstable during capture: ${displayPath}`);
    }
    const size = safeNumber(opened.size, `Builder filesystem state file size is unsupported: ${displayPath}`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead === 0) throw new Error(`Builder filesystem state entry was unstable during capture: ${displayPath}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return { sha256: hash.digest("hex"), final: await handle.stat({ bigint: true }) };
  } finally {
    await handle.close();
  }
}

async function safeLstat(path: string, displayPath: string): Promise<BigIntStats> {
  try { return await lstat(path, { bigint: true }); }
  catch { throw new Error(`Builder filesystem state entry is unreadable or missing: ${displayPath}`); }
}

function sameStableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}

function permissionMode(metadata: BigIntStats): number {
  return Number(metadata.mode & 0o7777n);
}

function linkCount(metadata: BigIntStats, path: string): number {
  return safeNumber(metadata.nlink, `Builder filesystem state hard-link count is unsupported: ${path}`);
}

function unsupportedType(metadata: BigIntStats): BuilderFilesystemUnsupportedEntry["unsupportedType"] {
  if (metadata.isBlockDevice()) return "block-device";
  if (metadata.isCharacterDevice()) return "character-device";
  if (metadata.isFIFO()) return "fifo";
  if (metadata.isSocket()) return "socket";
  return "unknown";
}

function safeNumber(value: bigint, message: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(message);
  return number;
}

function assertStatePath(path: unknown, limits: BuilderFilesystemStateLimits): asserts path is string {
  if (typeof path !== "string") throw new Error("Builder filesystem state contains a malformed path.");
  const bytes = Buffer.byteLength(path);
  if (path.length === 0 || bytes > limits.maxPathBytes || isAbsolute(path) || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Builder filesystem state contains a malformed or traversing path: ${path}`);
  }
}

function validateBuilderFilesystemState(
  state: BuilderFilesystemState,
  limits: BuilderFilesystemStateLimits = defaultBuilderFilesystemStateLimits,
): void {
  if (!isExactObject(state, ["schemaVersion", "entries"]) || state.schemaVersion !== "builder-filesystem-state/v1"
    || !Array.isArray(state.entries)) {
    throw new Error("Builder filesystem state is malformed or has an unsupported version.");
  }
  if (state.entries.length > limits.maxEntries) throw new Error("Builder filesystem state exceeds its entry limit.");
  let previous = "";
  let totalPathBytes = 0;
  let totalFileBytes = 0;
  const types = new Map<string, BuilderFilesystemEntryType>();
  for (const entry of state.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Builder filesystem state entry is malformed.");
    assertStatePath(entry.path, defaultBuilderFilesystemStateLimits);
    const pathBytes = Buffer.byteLength(entry.path);
    if (pathBytes > limits.maxPathBytes) throw new Error(`Builder filesystem state path exceeds its byte limit: ${entry.path}`);
    totalPathBytes += pathBytes;
    if (totalPathBytes > limits.maxTotalPathBytes) throw new Error("Builder filesystem state exceeds its total path limit.");
    if (entry.path <= previous) throw new Error("Builder filesystem state entries must be uniquely and deterministically ordered.");
    previous = entry.path;
    const separator = entry.path.lastIndexOf("/");
    if (separator >= 0 && types.get(entry.path.slice(0, separator)) !== "directory") {
      throw new Error(`Builder filesystem state parent hierarchy is malformed: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) {
      throw new Error(`Builder filesystem state mode is malformed: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.hardLinkCount) || entry.hardLinkCount < 1) {
      throw new Error(`Builder filesystem state hard-link count is malformed: ${entry.path}`);
    }
    if (entry.type === "regular-file") {
      if (!isExactObject(entry, ["path", "type", "mode", "hardLinkCount", "sizeBytes", "sha256"])
        || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !sha256Pattern.test(entry.sha256)) {
        throw new Error(`Builder filesystem regular-file state is malformed: ${entry.path}`);
      }
      if (entry.sizeBytes > limits.maxFileBytes) throw new Error(`Builder filesystem state file exceeds its byte limit: ${entry.path}`);
      totalFileBytes += entry.sizeBytes;
      if (totalFileBytes > limits.maxTotalFileBytes) throw new Error("Builder filesystem state exceeds its total file byte limit.");
    } else if (entry.type === "directory") {
      if (!isExactObject(entry, ["path", "type", "mode", "hardLinkCount"])) throw new Error(`Builder filesystem directory state is malformed: ${entry.path}`);
    } else if (entry.type === "symbolic-link") {
      if (!isExactObject(entry, ["path", "type", "mode", "hardLinkCount", "targetBytes", "targetSha256"])
        || !Number.isSafeInteger(entry.targetBytes) || entry.targetBytes < 0 || !sha256Pattern.test(entry.targetSha256)) {
        throw new Error(`Builder filesystem symbolic-link state is malformed: ${entry.path}`);
      }
      if (entry.targetBytes > limits.maxSymlinkTargetBytes) {
        throw new Error(`Builder filesystem state symbolic-link target exceeds its byte limit: ${entry.path}`);
      }
    } else if (entry.type === "unsupported") {
      if (!isExactObject(entry, ["path", "type", "mode", "hardLinkCount", "unsupportedType"])
        || !["block-device", "character-device", "fifo", "socket", "unknown"].includes(entry.unsupportedType)) {
        throw new Error(`Builder filesystem unsupported-entry state is malformed: ${entry.path}`);
      }
    } else {
      throw new Error(`Builder filesystem entry type is unsupported: ${entry.path}`);
    }
    types.set(entry.path, entry.type);
  }
}

function sameState(left: BuilderFilesystemState, right: BuilderFilesystemState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isExactObject(value: unknown, keys: readonly string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
