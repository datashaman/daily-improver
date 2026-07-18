import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectPhpTargetedMutation, preparePhpTargetedMutation } from "../src/adapters/php-targeted-mutation.js";
import {
  assertTargetedMutationPlan,
  assertTargetedMutationResult,
  compareTargetedMutationScores,
  type TargetedMutationPlan,
} from "../src/domain/targeted-mutation.js";
import { CommandRunner } from "../src/infra/command-runner.js";
import { createVerifierCommandEnvironmentDecision, runVerifierCommand } from "../src/core/verifier-command-environment.js";
import { assertVerifierMutationStateUnchanged, captureVerifierMutationState } from "../src/core/verifier-mutation-state.js";

const target = "app/Domain/MoneyAllocator.php";
const plan = {
  schemaVersion: "targeted-mutation-plan/v1",
  adapter: "php",
  tool: "infection",
  mode: "targeted",
  targets: [target],
  command: ["vendor/bin/infection", "--filter=app/Domain/MoneyAllocator.php"],
  timeoutMs: 600_000,
  reportArtifact: ".daily-improver/verifier-targeted-infection-report.json",
} as const;

test("validates one exact bounded language-neutral targeted-mutation plan and result", () => {
  const validated = assertTargetedMutationPlan(plan, [target]);
  const result = assertTargetedMutationResult({
    schemaVersion: "targeted-mutation-result/v2",
    adapter: "php",
    tool: "infection",
    mode: "targeted",
    targets: [target],
    outcome: "completed",
    inventorySemantics: "php-infection-mutator-location/v1",
    inventorySha256: "d".repeat(64),
    mutants: { total: 4, killed: 3, escaped: 1, notCovered: 0 },
    durationMs: 100,
    stdoutSha256: "a".repeat(64),
    stderrSha256: "b".repeat(64),
    reportSha256: "c".repeat(64),
  }, validated);
  assert.deepEqual(result.targets, [target]);
  assert.deepEqual(result.mutants, { total: 4, killed: 3, escaped: 1, notCovered: 0 });
  assert.equal(JSON.stringify(result).includes("source"), false);
});

test("rejects missing, extended, unsupported, escaped, untargeted, and excessive mutation decisions", () => {
  assert.throws(() => assertTargetedMutationPlan(undefined, [target]), /malformed/);
  assert.throws(() => assertTargetedMutationPlan({ ...plan, extra: true }, [target]), /extended/);
  assert.throws(() => assertTargetedMutationPlan({ ...plan, schemaVersion: "targeted-mutation-plan/v2" }, [target]), /unsupported/);
  assert.throws(() => assertTargetedMutationPlan({ ...plan, reportArtifact: "../report.json" }, [target]), /escaped/);
  assert.throws(() => assertTargetedMutationPlan({ ...plan, targets: ["src/Other.php"] }, [target]), /untargeted/);
  assert.throws(() => assertTargetedMutationPlan({ ...plan, targets: Array.from({ length: 65 }, (_, index) => `src/T${index}.php`) }, [target]), /excessive/);
  assert.throws(() => assertTargetedMutationPlan({ ...plan, command: [] }, [target]), /missing or excessive/);
  assert.throws(() => assertTargetedMutationPlan({ ...plan, timeoutMs: 30 * 60_000 + 1 }, [target]), /excessive/);
});

test("rejects malformed, extended, unsupported, untargeted, and excessive mutation outputs", () => {
  const validated = assertTargetedMutationPlan(plan, [target]);
  const result = {
    schemaVersion: "targeted-mutation-result/v2",
    adapter: "php",
    tool: "infection",
    mode: "targeted",
    targets: [target],
    outcome: "completed",
    inventorySemantics: "php-infection-mutator-location/v1",
    inventorySha256: "d".repeat(64),
    mutants: { total: 1, killed: 1, escaped: 0, notCovered: 0 },
    durationMs: 100,
    stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64), reportSha256: "c".repeat(64),
  } as const;
  assert.throws(() => assertTargetedMutationResult({ ...result, extra: true }, validated), /extended/);
  assert.throws(() => assertTargetedMutationResult({ ...result, schemaVersion: "targeted-mutation-result/v1" }, validated), /unsupported/);
  assert.throws(() => assertTargetedMutationResult({ ...result, targets: ["src/Other.php"] }, validated), /untargeted/);
  assert.throws(() => assertTargetedMutationResult({ ...result, mutants: { ...result.mutants, total: 100_001 } }, validated), /excessive/);
  assert.throws(() => assertTargetedMutationResult({ ...result, mutants: { ...result.mutants, killed: 2 } }, validated), /inconsistent/);
  assert.throws(() => assertTargetedMutationResult({ ...result, mutants: { ...result.mutants, total: 2 } }, validated), /inconsistent or incomplete/);
  assert.throws(() => assertTargetedMutationResult({ ...result, reportSha256: "raw-output" }, validated), /identity/);
});

test("compares only exact completed comparable mutation inventories and requires an improved score", () => {
  const baseline = mutationResult({ total: 1, killed: 0, escaped: 1, notCovered: 0 }, "a");
  const current = mutationResult({ total: 1, killed: 1, escaped: 0, notCovered: 0 }, "b");
  const comparison = compareTargetedMutationScores(baseline, current);
  assert.deepEqual(comparison.baseline, { mutants: baseline.mutants, scoreBasisPoints: 0, inventorySha256: "a".repeat(64) });
  assert.deepEqual(comparison.current, { mutants: current.mutants, scoreBasisPoints: 10_000, inventorySha256: "b".repeat(64) });
  assert.equal(comparison.outcome, "improved");
  assert.equal(JSON.stringify(comparison).includes("source"), false);

  assert.throws(() => compareTargetedMutationScores(undefined, current), /malformed/);
  assert.throws(() => compareTargetedMutationScores(baseline, undefined), /malformed/);
  assert.throws(() => compareTargetedMutationScores({ ...baseline, extra: true }, current), /extended/);
  assert.throws(() => compareTargetedMutationScores({ ...baseline, schemaVersion: "targeted-mutation-result/v1" }, current), /unsupported/);
  assert.throws(() => compareTargetedMutationScores({ ...baseline, targets: ["../escaped.php"] }, current), /escaped/);
  assert.throws(() => compareTargetedMutationScores({ ...baseline, adapter: "other" }, current), /incomparable/);
  assert.throws(() => compareTargetedMutationScores({ ...baseline, tool: "other" }, current), /incomparable/);
  assert.throws(() => compareTargetedMutationScores({ ...baseline, inventorySemantics: "other/v1" }, current), /incomparable inventory semantics/);
  assert.throws(() => compareTargetedMutationScores({ ...baseline, mutants: { ...baseline.mutants, total: 0 } }, current), /zero-mutant/);
  assert.throws(() => compareTargetedMutationScores(current, baseline), /regressed or did not improve/);
  assert.throws(() => compareTargetedMutationScores(current, current), /regressed or did not improve/);
});

test("PHP adapter runs Infection against only the changed MoneyAllocator target in a clean verifier command environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-targeted-mutation-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), root, { recursive: true });
  await chmod(join(root, "vendor/bin/infection"), 0o755);
  const prepared = assertTargetedMutationPlan(await preparePhpTargetedMutation(root, [target]), [target]);
  assert.equal(prepared.command.includes("--filter=app/Domain/MoneyAllocator.php"), true);
  const runner = new CommandRunner();
  const execution = await runVerifierCommand(runner, createVerifierCommandEnvironmentDecision(process.env), prepared.command, root, prepared.timeoutMs);
  const result = assertTargetedMutationResult(await inspectPhpTargetedMutation(root, prepared, execution), prepared);
  assert.deepEqual(result.targets, [target]);
  assert.deepEqual(result.mutants, { total: 1, killed: 0, escaped: 1, notCovered: 0 });
  assert.equal(result.inventorySemantics, "php-infection-mutator-location/v1");
  await assert.rejects(readFile(join(root, prepared.reportArtifact)), /ENOENT/);
});

test("PHP adapter fails closed when Infection is unavailable, escaped, or produces malformed output", async () => {
  const missing = await mkdtemp(join(tmpdir(), "daily-improver-targeted-missing-"));
  await writeFile(join(missing, "composer.json"), JSON.stringify({ require: { php: "^8.2" } }));
  await assert.rejects(preparePhpTargetedMutation(missing, [target]), /not manifest-declared/);

  const unavailable = await mkdtemp(join(tmpdir(), "daily-improver-targeted-unavailable-"));
  await writeFile(join(unavailable, "composer.json"), JSON.stringify({ "require-dev": { "infection/infection": "^0.30" } }));
  await assert.rejects(preparePhpTargetedMutation(unavailable, [target]), /unavailable/);

  const malformed = await mkdtemp(join(tmpdir(), "daily-improver-targeted-malformed-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), malformed, { recursive: true });
  await chmod(join(malformed, "vendor/bin/infection"), 0o755);
  const prepared = await preparePhpTargetedMutation(malformed, [target]);
  await writeFile(join(malformed, prepared.reportArtifact), "{\"stats\":{\"totalMutantsCount\":100001}}\n");
  await assert.rejects(inspectPhpTargetedMutation(malformed, prepared, execution()), /excessive|malformed/);

  const escapedRoot = await mkdtemp(join(tmpdir(), "daily-improver-targeted-escaped-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), escapedRoot, { recursive: true });
  await chmod(join(escapedRoot, "vendor/bin/infection"), 0o755);
  const escapedPlan = await preparePhpTargetedMutation(escapedRoot, [target]);
  const redirected: TargetedMutationPlan = { ...escapedPlan, reportArtifact: "../outside.json" };
  await assert.rejects(inspectPhpTargetedMutation(escapedRoot, redirected, execution()), /redirected/);

  const untargetedRoot = await mkdtemp(join(tmpdir(), "daily-improver-targeted-output-escape-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), untargetedRoot, { recursive: true });
  await chmod(join(untargetedRoot, "vendor/bin/infection"), 0o755);
  const untargetedPlan = await preparePhpTargetedMutation(untargetedRoot, [target]);
  const mutation = { mutator: { originalFilePath: "src/Other.php" } };
  await writeFile(join(untargetedRoot, untargetedPlan.reportArtifact), JSON.stringify({
    stats: { totalMutantsCount: 1, killedCount: 1, escapedCount: 0, notCoveredCount: 0, errorCount: 0, syntaxErrorCount: 0, timeOutCount: 0 },
    killed: [mutation], escaped: [], uncovered: [], errored: [], syntaxErrors: [], timeouted: [],
  }));
  await assert.rejects(inspectPhpTargetedMutation(untargetedRoot, untargetedPlan, execution()), /escaped the exact changed production targets/);
});

test("rejects any tracked or untracked checkout change made by the targeted mutation command", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-targeted-state-"));
  const runner = new CommandRunner();
  await writeFile(join(root, "source.php"), "<?php return 1;\n");
  for (const args of [["init", "-b", "main"], ["config", "user.email", "improver@example.test"], ["config", "user.name", "Daily Improver Test"], ["add", "."], ["commit", "-m", "baseline"]]) {
    const result = await runner.run(["git", ...args], root);
    assert.equal(result.exitCode, 0, result.stderr);
  }
  const before = await captureVerifierMutationState(root, "HEAD", runner);
  await writeFile(join(root, "source.php"), "<?php return 2;\n");
  await assert.rejects(assertVerifierMutationStateUnchanged(root, "HEAD", before, runner), /changed the fresh verifier checkout/);

  await writeFile(join(root, "source.php"), "<?php return 1;\n");
  const restored = await captureVerifierMutationState(root, "HEAD", runner);
  await writeFile(join(root, "mutation-cache.json"), "{}\n");
  await assert.rejects(assertVerifierMutationStateUnchanged(root, "HEAD", restored, runner), /changed the fresh verifier checkout/);
});

function execution() {
  return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
}

function mutationResult(
  mutants: { readonly total: number; readonly killed: number; readonly escaped: number; readonly notCovered: number },
  inventoryHash: string,
) {
  return {
    schemaVersion: "targeted-mutation-result/v2" as const,
    adapter: "php",
    tool: "infection",
    mode: "targeted" as const,
    targets: [target],
    outcome: "completed" as const,
    inventorySemantics: "php-infection-mutator-location/v1",
    inventorySha256: inventoryHash.repeat(64),
    mutants,
    durationMs: 100,
    stdoutSha256: "c".repeat(64),
    stderrSha256: "d".repeat(64),
    reportSha256: "e".repeat(64),
  };
}
