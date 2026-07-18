import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentContext } from "../src/agents/agent-provider.js";
import { deriveBuilderWriteAllowlist, IsolatedBuilderFilesystem } from "../src/core/builder-filesystem.js";
import type { ImprovementSpec } from "../src/domain/model.js";

test("derives an exact language-neutral production allowlist and imports only approved writes", async () => {
  const root = await fixtureRepository();
  const context = fixtureContext(root);
  assert.deepEqual(deriveBuilderWriteAllowlist(context), {
    schemaVersion: "builder-write-allowlist/v1",
    files: ["src/Service.ts"],
  });

  await new IsolatedBuilderFilesystem(join(root, "../sandboxes")).execute(context, async (isolated) => {
    assert.notEqual(isolated.repository, root);
    assert.deepEqual(isolated.spec.allowedFiles, ["src/Service.ts"]);
    await writeFile(join(isolated.repository, "src/Service.ts"), "approved\n");
    await writeFile(join(isolated.repository, "tests/Service.test.ts"), "builder changed protected test\n");
    await writeFile(join(isolated.repository, "README.md"), "builder changed unrelated file\n");
  });

  assert.equal(await readFile(join(root, "src/Service.ts"), "utf8"), "approved\n");
  assert.equal(await readFile(join(root, "tests/Service.test.ts"), "utf8"), "sealed test\n");
  assert.equal(await readFile(join(root, "README.md"), "utf8"), "original readme\n");
});

test("rejects malformed, traversing, absolute, wildcard, duplicate, and unbounded allowlists before builder execution", async () => {
  const root = await fixtureRepository();
  const invalid = ["", "../outside.ts", "src/../outside.ts", "/tmp/outside.ts", "src\\outside.ts", "src/*.ts", "src//Service.ts"];
  for (const path of invalid) {
    let called = false;
    await assert.rejects(
      new IsolatedBuilderFilesystem(join(root, "../sandboxes")).execute(fixtureContext(root, [path]), async () => { called = true; }),
      /Builder write allowlist/,
    );
    assert.equal(called, false, path);
  }

  assert.throws(() => deriveBuilderWriteAllowlist(fixtureContext(root, ["src/Service.ts", "src/Service.ts"])), /duplicate/);
  assert.throws(() => deriveBuilderWriteAllowlist({
    ...fixtureContext(root),
    spec: { ...fixtureSpec(["src/Service.ts", "README.md"]), constraints: { maxFiles: 1, maxChangedLines: 10, maxCostUsd: 1 } },
  }), /file limit/);
});

test("rejects protected, non-file, missing-parent, and symlink-escaping allowlists before builder execution", async () => {
  const root = await fixtureRepository();
  assert.throws(() => deriveBuilderWriteAllowlist(fixtureContext(root, ["tests/Service.test.ts"])), /protected path/);

  for (const [path, message] of [["src", /regular file/], ["missing/Service.ts", /parent does not exist/]] as const) {
    let invalidTargetCalled = false;
    await assert.rejects(
      new IsolatedBuilderFilesystem(join(root, "../sandboxes")).execute(fixtureContext(root, [path]), async () => { invalidTargetCalled = true; }),
      message,
    );
    assert.equal(invalidTargetCalled, false, path);
  }

  const outside = join(root, "../outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "escaped.ts"), "outside\n");
  await symlink(outside, join(root, "linked"));
  let called = false;
  await assert.rejects(
    new IsolatedBuilderFilesystem(join(root, "../sandboxes")).execute(fixtureContext(root, ["linked/escaped.ts"]), async () => { called = true; }),
    /symbolic link/,
  );
  assert.equal(called, false);
  assert.equal(await readFile(join(outside, "escaped.ts"), "utf8"), "outside\n");
});

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-builder-filesystem-"));
  for (const [path, content] of [
    ["src/Service.ts", "original\n"],
    ["tests/Service.test.ts", "sealed test\n"],
    ["README.md", "original readme\n"],
    [".ai/runs/2026-07-18/spec.json", "{}\n"],
  ] as const) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function fixtureContext(root: string, allowedFiles: readonly string[] = ["src/Service.ts"]): AgentContext {
  return {
    repository: root,
    spec: fixtureSpec(allowedFiles),
    specPath: join(root, ".ai/runs/2026-07-18/spec.json"),
    inputs: {
      repository: { language: "typescript", frameworks: [] },
      allowedTestPaths: ["tests"],
      protectedFiles: ["tests/**", ".ai/runs/**/spec.json", ".ai/policies/**"],
      commands: [],
      testConventions: [],
      builderConventions: [],
    },
  };
}

function fixtureSpec(allowedFiles: readonly string[]): ImprovementSpec {
  return {
    id: "spec-builder-filesystem",
    improvementIntent: { schemaVersion: "improvement-intent/v1", intent: "maintainability", baselineProof: "maintainability-quality" },
    title: "Improve service",
    objective: "Improve the selected service.",
    currentBehaviour: "The service is harder to maintain.",
    proposedImprovement: "Simplify the service.",
    allowedFiles,
    behavioursToPreserve: ["Preserve behavior."],
    acceptanceCriteria: ["Verification passes."],
    propertyInvariants: [],
    exclusions: ["Unrelated changes."],
    verification: [],
    constraints: { maxFiles: 5, maxChangedLines: 10, maxCostUsd: 1 },
    evidence: ["bounded evidence"],
  };
}
