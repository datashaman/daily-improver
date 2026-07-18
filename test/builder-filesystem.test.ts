import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import type { AgentContext } from "../src/agents/agent-provider.js";
import { CommandAgentProvider, createCommandAgentRuntimeEnvironment } from "../src/agents/command-agent-provider.js";
import {
  assertProtectedInputsReadOnly,
  deriveBuilderProtectedInputs,
  deriveBuilderWriteAllowlist,
  IsolatedBuilderFilesystem,
} from "../src/core/builder-filesystem.js";
import type { ImprovementSpec } from "../src/domain/model.js";

test("derives an exact language-neutral production allowlist and imports only approved writes", async () => {
  const root = await fixtureRepository();
  const context = fixtureContext(root);
  let capturedChanges: readonly { readonly path: string; readonly change: string }[] = [];
  assert.deepEqual(deriveBuilderWriteAllowlist(context), {
    schemaVersion: "builder-write-allowlist/v1",
    files: ["src/Service.ts"],
  });

  await new IsolatedBuilderFilesystem(join(root, "../sandboxes"), {
    afterStateCapture: async ({ changes }) => { capturedChanges = changes.changes; },
  }).execute(context, await fixtureProtection(root), async (isolated) => {
    assert.notEqual(isolated.repository, root);
    assert.deepEqual(isolated.spec.allowedFiles, ["src/Service.ts"]);
    for (const path of [
      "tests/Service.test.ts",
      ".ai/runs/2026-07-18/spec.json",
      ".ai/policies/safety.md",
      ".github/workflows/daily.yml",
      "database/migrations/001_create_records.php",
    ]) {
      const protectedPath = join(isolated.repository, path);
      const content = await readFile(protectedPath, "utf8");
      assert.ok(content.length > 0, path);
      await assert.rejects(writeFile(protectedPath, `${content}modified\n`), /EACCES|EPERM/, path);
    }
    const protectedTest = join(isolated.repository, "tests/Service.test.ts");
    await assert.rejects(rename(protectedTest, `${protectedTest}.renamed`), /EACCES|EPERM/);
    await assert.rejects(rm(protectedTest), /EACCES|EPERM/);
    await assert.rejects(writeFile(`${protectedTest}.replacement`, "replacement\n"), /EACCES|EPERM/);
    await writeFile(join(isolated.repository, "src/Service.ts"), "approved\n");
    await writeFile(join(isolated.repository, "README.md"), "builder changed unrelated file\n");
  });

  assert.equal(await readFile(join(root, "src/Service.ts"), "utf8"), "approved\n");
  assert.equal(await readFile(join(root, "tests/Service.test.ts"), "utf8"), "sealed test\n");
  assert.equal(await readFile(join(root, "README.md"), "utf8"), "original readme\n");
  assert.deepEqual(capturedChanges.map(({ path, change }) => ({ path, change })), [
    { path: "README.md", change: "modified" },
    { path: "src/Service.ts", change: "modified" },
  ]);
});

test("captures post-builder filesystem state before propagating a builder failure", async () => {
  const root = await fixtureRepository();
  let capturedChanges: readonly { readonly path: string; readonly change: string }[] = [];
  const filesystem = new IsolatedBuilderFilesystem(join(root, "../sandboxes"), {
    afterStateCapture: async ({ changes }) => { capturedChanges = changes.changes; },
  });
  await assert.rejects(
    filesystem.execute(fixtureContext(root), await fixtureProtection(root), async (isolated) => {
      await writeFile(join(isolated.repository, "src/Service.ts"), "failed builder write\n");
      throw new Error("deliberate builder failure");
    }),
    /deliberate builder failure/,
  );
  assert.deepEqual(capturedChanges.map(({ path, change }) => ({ path, change })), [
    { path: "src/Service.ts", change: "modified" },
  ]);
  assert.equal(await readFile(join(root, "src/Service.ts"), "utf8"), "original\n");
});

test("rejects malformed, traversing, absolute, wildcard, duplicate, and unbounded allowlists before builder execution", async () => {
  const root = await fixtureRepository();
  const invalid = ["", "../outside.ts", "src/../outside.ts", "/tmp/outside.ts", "src\\outside.ts", "src/*.ts", "src//Service.ts"];
  for (const path of invalid) {
    let called = false;
    await assert.rejects(
      new IsolatedBuilderFilesystem(join(root, "../sandboxes")).execute(fixtureContext(root, [path]), await fixtureProtection(root), async () => { called = true; }),
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
      new IsolatedBuilderFilesystem(join(root, "../sandboxes")).execute(fixtureContext(root, [path]), await fixtureProtection(root), async () => { invalidTargetCalled = true; }),
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
    new IsolatedBuilderFilesystem(join(root, "../sandboxes")).execute(fixtureContext(root, ["linked/escaped.ts"]), await fixtureProtection(root), async () => { called = true; }),
    /symbolic link/,
  );
  assert.equal(called, false);
  assert.equal(await readFile(join(outside, "escaped.ts"), "utf8"), "outside\n");
});

test("rejects pre-existing and builder-created hard links without changing either linked target", async () => {
  const preExistingRoot = await fixtureRepository();
  const preExistingExternal = join(preExistingRoot, "../pre-existing-external.ts");
  await writeFile(preExistingExternal, "external unchanged\n");
  await rm(join(preExistingRoot, "src/Service.ts"));
  await link(preExistingExternal, join(preExistingRoot, "src/Service.ts"));
  let preExistingCalled = false;
  await assert.rejects(
    new IsolatedBuilderFilesystem(join(preExistingRoot, "../sandboxes")).execute(
      fixtureContext(preExistingRoot),
      await fixtureProtection(preExistingRoot),
      async () => { preExistingCalled = true; },
    ),
    /multiple hard links/,
  );
  assert.equal(preExistingCalled, false);
  assert.equal(await readFile(preExistingExternal, "utf8"), "external unchanged\n");

  const builderRoot = await fixtureRepository();
  const builderExternal = join(builderRoot, "../builder-external.ts");
  await writeFile(builderExternal, "builder external unchanged\n");
  await assert.rejects(
    new IsolatedBuilderFilesystem(join(builderRoot, "../sandboxes")).execute(
      fixtureContext(builderRoot),
      await fixtureProtection(builderRoot),
      async (isolated) => {
        const allowed = join(isolated.repository, "src/Service.ts");
        await rm(allowed);
        await link(builderExternal, allowed);
      },
    ),
    /multiple hard links/,
  );
  assert.equal(await readFile(builderExternal, "utf8"), "builder external unchanged\n");
  assert.equal(await readFile(join(builderRoot, "src/Service.ts"), "utf8"), "original\n");
});

test("rejects builder-created symlinks and parent replacements without importing a change", async () => {
  const symlinkRoot = await fixtureRepository();
  const external = join(symlinkRoot, "../symlink-external.ts");
  await writeFile(external, "symlink external unchanged\n");
  await assert.rejects(
    new IsolatedBuilderFilesystem(join(symlinkRoot, "../sandboxes")).execute(
      fixtureContext(symlinkRoot),
      await fixtureProtection(symlinkRoot),
      async (isolated) => {
        const allowed = join(isolated.repository, "src/Service.ts");
        await rm(allowed);
        await symlink(external, allowed);
      },
    ),
    /unsupported allowed-file target/,
  );
  assert.equal(await readFile(external, "utf8"), "symlink external unchanged\n");
  assert.equal(await readFile(join(symlinkRoot, "src/Service.ts"), "utf8"), "original\n");

  const parentRoot = await fixtureRepository();
  await assert.rejects(
    new IsolatedBuilderFilesystem(join(parentRoot, "../sandboxes")).execute(
      fixtureContext(parentRoot),
      await fixtureProtection(parentRoot),
      async (isolated) => {
        await rename(join(isolated.repository, "src"), join(isolated.repository, "replaced-src"));
        await mkdir(join(isolated.repository, "src"));
        await writeFile(join(isolated.repository, "src/Service.ts"), "redirected\n");
      },
    ),
    /parent was replaced/,
  );
  assert.equal(await readFile(join(parentRoot, "src/Service.ts"), "utf8"), "original\n");
});

test("revalidates the staged target immediately before import and rejects a TOCTOU replacement", async () => {
  const root = await fixtureRepository();
  const external = join(root, "../toctou-external.ts");
  await writeFile(external, "TOCTOU external unchanged\n");
  const filesystem = new IsolatedBuilderFilesystem(join(root, "../sandboxes"), {
    beforeImport: async (workspace) => {
      const allowed = join(workspace, "src/Service.ts");
      await rm(allowed);
      await symlink(external, allowed);
    },
  });
  await assert.rejects(
    filesystem.execute(fixtureContext(root), await fixtureProtection(root), async (isolated) => {
      await writeFile(join(isolated.repository, "src/Service.ts"), "approved but raced\n");
    }),
    /unsupported allowed-file target/,
  );
  assert.equal(await readFile(external, "utf8"), "TOCTOU external unchanged\n");
  assert.equal(await readFile(join(root, "src/Service.ts"), "utf8"), "original\n");
});

test("rejects missing, mutable, replaced, non-regular, and symlink-crossing protected inputs before builder execution", async () => {
  const root = await fixtureRepository();
  const protection = await fixtureProtection(root);
  const inputs = await deriveBuilderProtectedInputs(root, protection);
  await assert.rejects(assertProtectedInputsReadOnly(root, inputs), /mutable/);

  for (const [path, hash, message] of [
    ["tests/missing.test.ts", "0".repeat(64), /missing/],
    ["tests/Service.test.ts", "0".repeat(64), /replaced/],
    ["tests", "0".repeat(64), /regular file/],
  ] as const) {
    let called = false;
    await assert.rejects(
      new IsolatedBuilderFilesystem(join(root, "../sandboxes")).execute(
        fixtureContext(root),
        { trustedPatterns: [], sealedFiles: { [path]: hash } },
        async () => { called = true; },
      ),
      message,
    );
    assert.equal(called, false, path);
  }

  const outside = join(root, "../protected-outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "sealed.txt"), "sealed\n");
  await symlink(outside, join(root, "tests/linked"));
  let called = false;
  await assert.rejects(
    new IsolatedBuilderFilesystem(join(root, "../sandboxes")).execute(
      fixtureContext(root),
      { trustedPatterns: [], sealedFiles: { "tests/linked/sealed.txt": await sha256(join(outside, "sealed.txt")) } },
      async () => { called = true; },
    ),
    /symbolic link/,
  );
  assert.equal(called, false);

  const hardLinkedRoot = await fixtureRepository();
  const protectedExternal = join(hardLinkedRoot, "../protected-hard-link.txt");
  await writeFile(protectedExternal, "protected external unchanged\n");
  await rm(join(hardLinkedRoot, "tests/Service.test.ts"));
  await link(protectedExternal, join(hardLinkedRoot, "tests/Service.test.ts"));
  let hardLinkedCalled = false;
  await assert.rejects(
    new IsolatedBuilderFilesystem(join(hardLinkedRoot, "../sandboxes")).execute(
      fixtureContext(hardLinkedRoot),
      await fixtureProtection(hardLinkedRoot),
      async () => { hardLinkedCalled = true; },
    ),
    /multiple hard links/,
  );
  assert.equal(hardLinkedCalled, false);
  assert.equal(await readFile(protectedExternal, "utf8"), "protected external unchanged\n");
});

test("denies builder connections while preserving protected reads and one approved production write", async () => {
  const root = await fixtureRepository();
  const scriptPath = join(root, ".ai", "builder-network-proof.cjs");
  const server = createServer((socket) => socket.end("reachable"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(scriptPath, [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "if (fs.readFileSync('tests/Service.test.ts', 'utf8') !== 'sealed test\\n') process.exit(7);",
    `const socket = net.connect(${address.port}, '127.0.0.1');`,
    "socket.setTimeout(1000);",
    "socket.on('connect', () => process.exit(8));",
    "socket.on('timeout', () => process.exit(9));",
    "socket.on('error', () => fs.writeFileSync('src/Service.ts', 'network denied\\n'));",
  ].join("\n"));
  const context = fixtureContext(root);
  const provider = new CommandAgentProvider({
    testCommand: "true",
    buildCommand: `${process.execPath} .ai/builder-network-proof.cjs`,
    runtimeEnvironment: createCommandAgentRuntimeEnvironment(process.env),
    builderResourceLimits: {
      schemaVersion: "builder-resource-limits/v1",
      cpuTimeMs: 5_000,
      memoryBytes: 256 * 1024 * 1024,
      diskBytes: 16 * 1024 * 1024,
      outputBytes: 64 * 1024,
      wallClockMs: 10_000,
    },
  });

  try {
    await new IsolatedBuilderFilesystem(join(root, "../sandboxes")).execute(
      context,
      { trustedPatterns: [".ai/**", ".github/workflows/**", "database/migrations/**"], sealedFiles: (await fixtureProtection(root)).sealedFiles },
      async (isolated) => await provider.build(isolated),
    );
    assert.equal(await readFile(join(root, "src/Service.ts"), "utf8"), "network denied\n");
    assert.equal(await readFile(join(root, "tests/Service.test.ts"), "utf8"), "sealed test\n");
  } catch (error) {
    assert.match(String(error), /Builder outbound network denial is unavailable or could not be verified|unavailable on this runner platform/);
    assert.equal(await readFile(join(root, "src/Service.ts"), "utf8"), "original\n");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-builder-filesystem-"));
  for (const [path, content] of [
    ["src/Service.ts", "original\n"],
    ["tests/Service.test.ts", "sealed test\n"],
    ["README.md", "original readme\n"],
    [".ai/runs/2026-07-18/spec.json", "{}\n"],
    [".ai/policies/safety.md", "deny unsafe changes\n"],
    [".github/workflows/daily.yml", "name: daily\n"],
    ["database/migrations/001_create_records.php", "<?php\n"],
  ] as const) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function fixtureProtection(root: string) {
  return {
    trustedPatterns: [".ai/policies/**", ".github/workflows/**", "database/migrations/**"],
    sealedFiles: {
      "tests/Service.test.ts": await sha256(join(root, "tests/Service.test.ts")),
      ".ai/runs/2026-07-18/spec.json": await sha256(join(root, ".ai/runs/2026-07-18/spec.json")),
    },
  } as const;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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
