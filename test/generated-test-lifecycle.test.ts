import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decideGeneratedTestLifecycle,
  readGeneratedTestLifecycleReport,
  type GeneratedTestLifecycleDecision,
  type TestCommandOutcome,
} from "../src/domain/generated-test-lifecycle.js";

const path = "tests/GeneratedTest.php";
const hash = "a".repeat(64);

test("accepts three stable executed lifecycle attempts without retaining raw output", () => {
  const decision = decideGeneratedTestLifecycle({
    phase: "baseline",
    command: ["vendor/bin/phpunit"],
    testSha256: { [path]: hash },
    attempts: attempts(1),
    expectedExit: "nonzero",
  });
  assert.equal(decision.outcome, "accepted");
  assert.equal(decision.attempts.length, 3);
  assert.deepEqual(Object.keys(decision.attempts[0]!), ["attempt", "exitCode", "durationMs", "stdoutSha256", "stderrSha256", "tests"]);
});

test("rejects skipped, disabled, absent, and assertion-free generated tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-lifecycle-"));
  const reportPath = join(root, "report.json");
  for (const status of ["skipped", "disabled"] as const) {
    await writeFile(reportPath, JSON.stringify(report("1".repeat(32), status, 1)));
    await assert.rejects(readGeneratedTestLifecycleReport(reportPath, "1".repeat(32), [path]), new RegExp(status));
  }
  await writeFile(reportPath, JSON.stringify(report("1".repeat(32), "executed", 0)));
  await assert.rejects(readGeneratedTestLifecycleReport(reportPath, "1".repeat(32), [path]), /no assertions/);
  await writeFile(reportPath, JSON.stringify({ ...report("1".repeat(32), "executed", 1), tests: [] }));
  await assert.rejects(readGeneratedTestLifecycleReport(reportPath, "1".repeat(32), [path]), /invalid test collection/);
});

test("quarantines varying outcomes and rejects weakened verification metrics", () => {
  assert.throws(() => decideGeneratedTestLifecycle({
    phase: "baseline",
    command: ["php", "tests/run.php"],
    testSha256: { [path]: hash },
    attempts: attempts(1).map((attempt, index) => ({ ...attempt, exitCode: index === 1 ? 0 : 1 })),
    expectedExit: "nonzero",
  }), /newly flaky.*command-outcome-varied/);

  const baseline = baselineDecision();
  assert.throws(() => decideGeneratedTestLifecycle({
    phase: "verification",
    command: baseline.command,
    testSha256: baseline.testSha256,
    attempts: attempts(0, 0),
    expectedExit: "zero",
    baseline,
  }), /observably weakened/);
});

function baselineDecision(): GeneratedTestLifecycleDecision {
  return decideGeneratedTestLifecycle({ phase: "baseline", command: ["php", "tests/run.php"], testSha256: { [path]: hash }, attempts: attempts(1), expectedExit: "nonzero" });
}

function attempts(exitCode: number, assertionCount = 10): readonly TestCommandOutcome[] {
  return [1, 2, 3].map((attempt) => ({
    attempt,
    exitCode,
    durationMs: 10 + attempt,
    stdoutSha256: "b".repeat(64),
    stderrSha256: "c".repeat(64),
    tests: [{ path, status: "executed", assertionCount, toleranceSha256: "d".repeat(64) }],
  }));
}

function report(nonce: string, status: "executed" | "skipped" | "disabled", assertionCount: number) {
  return { schemaVersion: "generated-test-lifecycle-report/v1", executionNonce: nonce, tests: [{ path, status, assertionCount, toleranceSha256: "d".repeat(64) }] };
}
