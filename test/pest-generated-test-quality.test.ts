import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPestGeneratedTestQualityInspection,
  inspectPestGeneratedTestQuality,
  requireAcceptedPestGeneratedTestQuality,
} from "../src/adapters/pest-generated-test-quality.js";
import { PhpAdapter } from "../src/adapters/php.js";
import type { GeneratedTestQualityInspectionRequest } from "../src/contracts.js";
import type { GeneratedTestLifecycleDecision } from "../src/domain/generated-test-lifecycle.js";

test("accepts bounded focused Pest discovery with assertions and inline provider coverage", async () => {
  const source = `<?php
it('preserves totals', function (int $total, int $parts) {
    expect($total)->toBeGreaterThanOrEqual(0);
})->with([[0, 1], [10, 2], [11, 3]]);
`;
  const request = await fixture(source, 3);
  const inspection = await inspectPestGeneratedTestQuality(request);

  assert.equal(inspection.outcome, "accepted");
  assert.equal(inspection.selectedTestPath, request.selectedTestPath);
  assert.equal(inspection.tests[0]?.declarationCount, 1);
  assert.equal(inspection.tests[0]?.dataProviderCount, 1);
  assert.equal(inspection.tests[0]?.dataProviderCaseCount, 3);
  assert.equal(inspection.tests[0]?.dataProviderCoverage, "covered");
  assert.deepEqual(inspection.tests[0]?.signals, []);
  assert.doesNotMatch(JSON.stringify(inspection), /preserves totals|toBeGreaterThanOrEqual/);
  assert.doesNotThrow(() => requireAcceptedPestGeneratedTestQuality(inspection));
});

test("rejects focused, skipped, todo, and assertion-free Pest tests", async () => {
  const cases = [
    ["it('x', function () { expect(true)->toBeTrue(); })->only();", "focused-test"],
    ["it('x', function () { expect(true)->toBeTrue(); })->skip();", "skipped-test"],
    ["it('x', function () { expect(true)->toBeTrue(); })->todo();", "todo-test"],
    ["it('x', function () { return true; });", "assertion-free-test"],
  ] as const;
  for (const [source, signal] of cases) {
    const inspection = await inspectPestGeneratedTestQuality(await fixture(`<?php\n${source}\n`, signal === "assertion-free-test" ? 0 : 1));
    assert.equal(inspection.outcome, "rejected");
    assert.equal(inspection.tests[0]?.signals.includes(signal), true);
    assert.throws(() => requireAcceptedPestGeneratedTestQuality(inspection), new RegExp(signal));
  }
});

test("rejects empty, dynamic, and named Pest data providers", async () => {
  const providers = ["[]", "$cases", "'named-cases'"];
  for (const provider of providers) {
    const request = await fixture(`<?php
test('x', function ($value) { expect($value)->toBeInt(); })->with(${provider});
`, 1);
    const inspection = await inspectPestGeneratedTestQuality(request);
    assert.equal(inspection.outcome, "rejected");
    assert.equal(inspection.tests[0]?.signals.some((signal) => signal === "empty-data-provider" || signal === "unsupported-data-provider"), true);
  }
});

test("fails closed for unsupported syntax, unbounded input, and unbound exact evidence", async () => {
  const unsupported = await fixture("<?php\nfunction ordinaryHelper(): void {}\n", 1);
  await assert.rejects(inspectPestGeneratedTestQuality(unsupported), /unsupported discovery syntax/);

  const unbounded = await fixture(`<?php\nit('x', function () { expect(true)->toBeTrue(); });\n${" ".repeat(256_001)}`, 1);
  await assert.rejects(inspectPestGeneratedTestQuality(unbounded), /1-256000 bytes/);

  const request = await fixture("<?php\nit('x', function () { expect(true)->toBeTrue(); });\n", 1);
  const inspection = await inspectPestGeneratedTestQuality(request);
  assert.throws(() => assertPestGeneratedTestQualityInspection({ ...inspection, extra: true }, request), /exact schema/);
  assert.throws(() => assertPestGeneratedTestQualityInspection({ ...inspection, selectedTestPath: "tests/Other.php" }, request), /selected test path/);
  assert.throws(() => assertPestGeneratedTestQualityInspection({ ...inspection, lifecycleAttempts: 2 }, request), /baseline lifecycle/);
  assert.throws(() => assertPestGeneratedTestQualityInspection({ ...inspection, outcome: "rejected" }, request), /outcome is inconsistent/);
});

test("the PHP adapter gates Pest evidence and leaves other test frameworks unchanged", async () => {
  const adapter = new PhpAdapter();
  const accepted = await fixture("<?php\nit('x', function () { expect(true)->toBeTrue(); });\n", 1);
  assert.equal((await adapter.inspectGeneratedTestQuality(accepted))?.outcome, "accepted");

  const focused = await fixture("<?php\nit('x', function () { expect(true)->toBeTrue(); })->only();\n", 1);
  await assert.rejects(adapter.inspectGeneratedTestQuality(focused), /focused-test/);
  assert.equal(await adapter.inspectGeneratedTestQuality({ ...accepted, framework: "phpunit" }), undefined);
});

async function fixture(source: string, assertionCount: number): Promise<GeneratedTestQualityInspectionRequest> {
  const root = await mkdtemp(join(tmpdir(), "pest-generated-test-quality-"));
  const path = "tests/Feature/GeneratedTest.php";
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "tests", "Feature"), { recursive: true }));
  await writeFile(join(root, path), source);
  const sha256 = createHash("sha256").update(source).digest("hex");
  return {
    root,
    framework: "pest",
    selectedTestPath: path,
    observedTestPaths: [path],
    baselineLifecycle: lifecycle(path, sha256, assertionCount),
  };
}

function lifecycle(path: string, sha256: string, assertionCount: number): GeneratedTestLifecycleDecision {
  const tests = [{ path, status: "executed" as const, assertionCount, toleranceSha256: "a".repeat(64) }];
  return {
    schemaVersion: "generated-test-lifecycle-decision/v1",
    phase: "baseline",
    outcome: "accepted",
    command: ["vendor/bin/pest"],
    testSha256: { [path]: sha256 },
    attempts: [1, 2, 3].map((attempt) => ({
      attempt,
      exitCode: 1,
      durationMs: 1,
      stdoutSha256: "b".repeat(64),
      stderrSha256: "c".repeat(64),
      tests,
    })),
  };
}
