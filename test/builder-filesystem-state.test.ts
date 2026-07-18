import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  BuilderFilesystemStateCapturer,
  defaultBuilderFilesystemStateLimits,
  deriveBuilderFilesystemChangeSet,
} from "../src/core/builder-filesystem-state.js";
import type { BuilderFilesystemState } from "../src/core/builder-filesystem-state.js";

const executeFile = promisify(execFile);

test("captures bounded source-free filesystem state and derives every change kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-filesystem-state-"));
  await write(root, "src/modified.ts", "secret baseline source\n");
  await write(root, "src/deleted.ts", "deleted source\n");
  await write(root, "outside-allowlist.txt", "outside baseline\n");
  await write(root, "type-target", "regular before\n");
  await symlink("src/modified.ts", join(root, "source-link"));
  await executeFile("mkfifo", [join(root, "builder.fifo")]);

  const capturer = new BuilderFilesystemStateCapturer();
  const before = await capturer.capture(root);
  const symbolicLink = before.entries.find((entry) => entry.path === "source-link");
  const unsupported = before.entries.find((entry) => entry.path === "builder.fifo");
  assert.equal(symbolicLink?.type, "symbolic-link");
  assert.equal(unsupported?.type, "unsupported");
  if (unsupported?.type === "unsupported") assert.equal(unsupported.unsupportedType, "fifo");
  assert.doesNotMatch(JSON.stringify(before), /secret baseline source|deleted source|regular before/);

  await writeFile(join(root, "src/modified.ts"), "modified source\n");
  await rm(join(root, "src/deleted.ts"));
  await write(root, "src/added.ts", "added source\n");
  await writeFile(join(root, "outside-allowlist.txt"), "outside changed\n");
  await rm(join(root, "type-target"));
  await mkdir(join(root, "type-target"));

  const after = await capturer.capture(root);
  assert.deepEqual(deriveBuilderFilesystemChangeSet(before, after).changes, [
    { path: "outside-allowlist.txt", change: "modified", beforeType: "regular-file", afterType: "regular-file" },
    { path: "src/added.ts", change: "added", afterType: "regular-file" },
    { path: "src/deleted.ts", change: "deleted", beforeType: "regular-file" },
    { path: "src/modified.ts", change: "modified", beforeType: "regular-file", afterType: "regular-file" },
    { path: "type-target", change: "type-changed", beforeType: "regular-file", afterType: "directory" },
  ]);
});

test("fails closed on excessive, unreadable, malformed, traversing, and unstable filesystem state", async () => {
  const excessiveRoot = await mkdtemp(join(tmpdir(), "daily-improver-filesystem-excessive-"));
  await write(excessiveRoot, "one", "1");
  await write(excessiveRoot, "two", "2");
  await assert.rejects(
    new BuilderFilesystemStateCapturer({ ...defaultBuilderFilesystemStateLimits, maxEntries: 1 }).capture(excessiveRoot),
    /entry limit/,
  );

  const unreadableRoot = await mkdtemp(join(tmpdir(), "daily-improver-filesystem-unreadable-"));
  await write(unreadableRoot, "unreadable.txt", "private\n");
  await chmod(join(unreadableRoot, "unreadable.txt"), 0o000);
  await assert.rejects(new BuilderFilesystemStateCapturer().capture(unreadableRoot), /regular file is unreadable/);
  await chmod(join(unreadableRoot, "unreadable.txt"), 0o600);

  const malformedRoot = await mkdtemp(join(tmpdir(), "daily-improver-filesystem-malformed-"));
  await write(malformedRoot, "bad\\path", "malformed\n");
  await assert.rejects(new BuilderFilesystemStateCapturer().capture(malformedRoot), /malformed or traversing path/);

  const unstableRoot = await mkdtemp(join(tmpdir(), "daily-improver-filesystem-unstable-"));
  await write(unstableRoot, "changing.txt", "before\n");
  const unstable = new BuilderFilesystemStateCapturer(defaultBuilderFilesystemStateLimits, {
    betweenStableCaptures: async () => await writeFile(join(unstableRoot, "changing.txt"), "after\n"),
  });
  await assert.rejects(unstable.capture(unstableRoot), /unstable during capture/);

  const malformedState = {
    schemaVersion: "builder-filesystem-state/v1",
    entries: [{ path: "../escape", type: "directory", mode: 0o755 }],
  } as unknown as BuilderFilesystemState;
  assert.throws(() => deriveBuilderFilesystemChangeSet(malformedState, malformedState), /malformed or traversing path/);
  const nonStringPathState = {
    schemaVersion: "builder-filesystem-state/v1",
    entries: [{ path: 42, type: "directory", mode: 0o755 }],
  } as unknown as BuilderFilesystemState;
  assert.throws(() => deriveBuilderFilesystemChangeSet(nonStringPathState, nonStringPathState), /malformed path/);
});

test("rejects malformed and unsupported filesystem-state limit contracts", () => {
  assert.throws(
    () => new BuilderFilesystemStateCapturer({ ...defaultBuilderFilesystemStateLimits, schemaVersion: "other/v1" as "builder-filesystem-state-limits/v1" }),
    /exact versioned value/,
  );
  assert.throws(
    () => new BuilderFilesystemStateCapturer({ ...defaultBuilderFilesystemStateLimits, maxPathBytes: 0 }),
    /path limit/,
  );
});

async function write(root: string, path: string, contents: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}
