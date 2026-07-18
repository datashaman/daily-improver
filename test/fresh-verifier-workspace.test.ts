import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { FreshVerifierWorkspace } from "../src/core/fresh-verifier-workspace.js";
import type { VerifierExecutionInputs } from "../src/core/verifier-execution-inputs.js";
import { CommandRunner, type CommandResult } from "../src/infra/command-runner.js";

test("creates a fresh exact-SHA verifier with only the approved patch and sealed inputs", async () => {
  const fixture = await createFixture();
  const manager = new FreshVerifierWorkspace(join(fixture.sandbox, "runner-workspaces"), fixture.runner);
  const workspace = await manager.create(fixture.repository, fixture.generated, fixture.inputs);
  try {
    assert.equal(await readFile(join(workspace.path, "src", "value.php"), "utf8"), "<?php return 2;\n");
    assert.equal(await readFile(join(workspace.path, "tests", "generated.php"), "utf8"), "<?php assert(true);\n");
    await assert.rejects(readFile(join(workspace.path, "builder-only.txt"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(workspace.path, ".daily-improver", "cache.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(workspace.path, ".ai", "runs", "2026-07-18", "build-agent-rationale.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(workspace.path, ".ai", "runs", "2026-07-18", "test-agent-rationale.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(workspace.path, ".git", "builder-marker"), "utf8"), /ENOENT/);
    const head = await fixture.runner.run(["git", "rev-parse", "HEAD"], workspace.path);
    assert.equal(head.stdout.trim(), fixture.inputs.expectedBaseSha);
    const diff = await fixture.runner.run(["git", "diff", "--name-only", fixture.inputs.expectedBaseSha], workspace.path);
    assert.deepEqual(diff.stdout.trim().split("\n").filter(Boolean).sort(), [
      ".ai/runs/2026-07-18/test-manifest.json",
      "src/value.php",
      "tests/generated.php",
    ]);
  } finally {
    await workspace.cleanup();
  }
});

test("rejects missing, advanced, non-commit, and ambiguously resolved baselines before cloning", async () => {
  const missing = await createFixture();
  await assert.rejects(
    new FreshVerifierWorkspace(join(missing.sandbox, "missing-workspaces"), missing.runner).create(
      missing.repository,
      missing.generated,
      { ...missing.inputs, expectedBaseSha: "0".repeat(40) },
    ),
    /missing or is not a commit/,
  );

  const advanced = await createFixture();
  await writeFile(join(advanced.repository, "advanced.txt"), "advanced\n");
  await git(advanced.runner, advanced.repository, ["add", "advanced.txt"]);
  await git(advanced.runner, advanced.repository, ["commit", "-m", "advance main"]);
  await assert.rejects(
    new FreshVerifierWorkspace(join(advanced.sandbox, "advanced-workspaces"), advanced.runner).create(
      advanced.repository,
      advanced.generated,
      advanced.inputs,
    ),
    /advanced or no longer matches/,
  );

  const nonCommit = await createFixture();
  const blob = await nonCommit.runner.run(["git", "hash-object", "src/value.php"], nonCommit.repository);
  await assert.rejects(
    new FreshVerifierWorkspace(join(nonCommit.sandbox, "blob-workspaces"), nonCommit.runner).create(
      nonCommit.repository,
      nonCommit.generated,
      { ...nonCommit.inputs, expectedBaseSha: blob.stdout.trim() },
    ),
    /missing or is not a commit/,
  );

  const ambiguous = await createFixture();
  const runner = new AmbiguousHeadRunner(ambiguous.inputs.expectedBaseSha);
  await assert.rejects(
    new FreshVerifierWorkspace(join(ambiguous.sandbox, "ambiguous-workspaces"), runner).create(
      ambiguous.repository,
      ambiguous.generated,
      ambiguous.inputs,
    ),
    /one unambiguous commit/,
  );
  await assert.rejects(readFile(join(ambiguous.sandbox, "ambiguous-workspaces", "clone-was-run")), /ENOENT/);
});

class AmbiguousHeadRunner extends CommandRunner {
  constructor(private readonly sha: string) { super(); }

  override async run(command: readonly string[], cwd: string, timeoutMs?: number, environment?: Readonly<Record<string, string>>): Promise<CommandResult> {
    if (command[0] === "git" && command[1] === "cat-file") {
      return result(command, "commit\n");
    }
    if (command[0] === "git" && command[1] === "rev-parse") {
      return result(command, `${this.sha}\n${this.sha}\n`);
    }
    if (command[0] === "git" && command[1] === "clone") {
      await writeFile(join(dirname(cwd), "clone-was-run"), "unexpected");
    }
    return await super.run(command, cwd, timeoutMs, environment);
  }
}

async function createFixture(): Promise<{
  readonly sandbox: string;
  readonly repository: string;
  readonly generated: string;
  readonly runner: CommandRunner;
  readonly inputs: VerifierExecutionInputs;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-fresh-verifier-"));
  const repository = join(sandbox, "repository");
  const generated = join(sandbox, "generated");
  const runner = new CommandRunner();
  await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(join(repository, "tests"), { recursive: true });
  await writeFile(join(repository, "src", "value.php"), "<?php return 1;\n");
  await writeFile(join(repository, "tests", "baseline.php"), "<?php assert(true);\n");
  await git(runner, repository, ["init", "-b", "main"]);
  await git(runner, repository, ["config", "user.email", "improver@example.test"]);
  await git(runner, repository, ["config", "user.name", "Daily Improver Test"]);
  await git(runner, repository, ["add", "."]);
  await git(runner, repository, ["commit", "-m", "baseline"]);
  const head = await runner.run(["git", "rev-parse", "HEAD"], repository);
  const expectedBaseSha = head.stdout.trim();

  await cp(repository, generated, { recursive: true });
  await writeFile(join(generated, "src", "value.php"), "<?php return 2;\n");
  await writeFile(join(generated, "tests", "generated.php"), "<?php assert(true);\n");
  await writeFile(join(generated, "builder-only.txt"), "do not transfer\n");
  await mkdir(join(generated, ".daily-improver"), { recursive: true });
  await writeFile(join(generated, ".daily-improver", "cache.json"), "{}\n");
  await writeFile(join(generated, ".git", "builder-marker"), "do not transfer\n");
  const runRoot = join(generated, ".ai", "runs", "2026-07-18");
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(runRoot, "build-agent-rationale.json"), "{\"trust\":\"untrusted-model-output\"}\n");
  const testRationaleSource = Buffer.from("{\"trust\":\"untrusted-model-output\"}\n");
  await writeFile(join(runRoot, "test-agent-rationale.json"), testRationaleSource);
  const sealedSource = await readFile(join(generated, "tests", "generated.php"));
  const manifest = {
    schemaVersion: "test-manifest/v2" as const,
    generatedAt: "2026-07-18T00:00:00.000Z",
    files: {
      "tests/generated.php": sha256(sealedSource),
      ".ai/runs/2026-07-18/test-agent-rationale.json": sha256(testRationaleSource),
    },
    signature: "a".repeat(64),
  };
  const manifestSource = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(runRoot, "test-manifest.json"), manifestSource);
  const inputs: VerifierExecutionInputs = {
    schemaVersion: "verifier-execution-inputs/v3",
    expectedBaseSha,
    specification: {
      id: "candidate",
      improvementIntent: { schemaVersion: "improvement-intent/v1", intent: "defect", baselineProof: "defect-regression" },
      title: "Correct value",
      objective: "Correct the returned value.",
      currentBehaviour: "Returns one.",
      proposedImprovement: "Return two.",
      allowedFiles: ["src/value.php"],
      behavioursToPreserve: [],
      acceptanceCriteria: ["Returns two."],
      propertyInvariants: [],
      exclusions: [],
      verification: ["test"],
      constraints: { maxFiles: 1, maxChangedLines: 10, maxCostUsd: 1 },
      evidence: ["fixture"],
    },
    specificationSha256: "b".repeat(64),
    configurationSha256: "absent",
    commands: ["php tests/generated.php"],
    mutationMode: "off",
    protectedPaths: ["tests/**"],
    commandEnvironment: {
      schemaVersion: "verifier-command-environment/v1",
      isolation: "fresh-process-and-storage-per-command",
      shell: "/bin/sh",
      path: "/usr/bin:/bin",
      inheritedVariables: [],
    },
    outputArtifact: ".ai/runs/2026-07-18/verification.json",
    trustedArtifacts: [
      ".ai/runs/2026-07-18/build-agent-usage.json",
      ".ai/runs/2026-07-18/build-agent-rationale.json",
    ],
    manifest,
    manifestArtifactSha256: sha256(manifestSource),
    integritySha256: "c".repeat(64),
  };
  return { sandbox, repository, generated, runner, inputs };
}

async function git(runner: CommandRunner, root: string, args: readonly string[]): Promise<void> {
  const command = ["git", ...args];
  const execution = await runner.run(command, root);
  assert.equal(execution.exitCode, 0, execution.stderr);
}

function result(command: readonly string[], stdout: string): CommandResult {
  return { command, exitCode: 0, stdout, stderr: "", durationMs: 0 };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
