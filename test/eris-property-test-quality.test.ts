import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertErisPropertyTestQualityInspection,
  inspectErisPropertyTestQuality,
  requireAcceptedErisPropertyTestQuality,
} from "../src/adapters/eris-property-test-quality.js";
import { inspectPhpunitGeneratedTestQuality } from "../src/adapters/phpunit-generated-test-quality.js";
import { PhpAdapter } from "../src/adapters/php.js";
import type { GeneratedTestQualityInspectionRequest } from "../src/contracts.js";
import type { GeneratedTestLifecycleDecision } from "../src/domain/generated-test-lifecycle.js";
import type { PropertyTestExecutionProof } from "../src/domain/property-test-execution-proof.js";

test("accepts bounded Eris generators, execution, target invocation, and invariant checks", async () => {
  const request = await fixture(erisTest());
  const inspection = await inspectEris(request);

  assert.equal(inspection.outcome, "accepted");
  assert.equal(inspection.tests[0]?.testTraitCount, 1);
  assert.equal(inspection.tests[0]?.propertyCount, 1);
  assert.equal(inspection.tests[0]?.generatorCount, 2);
  assert.equal(inspection.tests[0]?.thenCount, 1);
  assert.equal(inspection.tests[0]?.executedInputCount, 32);
  assert.equal(inspection.tests[0]?.targetExecutionCount, 32);
  assert.equal(inspection.tests[0]?.invariantCheckCount, 32);
  assert.deepEqual(inspection.tests[0]?.signals, []);
  assert.doesNotMatch(JSON.stringify(inspection), /assertSame|allocate\(/);
  assert.doesNotThrow(() => requireAcceptedErisPropertyTestQuality(inspection));
});

test("rejects missing, malformed, bypassed, dynamic, and unbounded Eris structures", async () => {
  const cases = [
    [erisTest().replace("use \\Eris\\TestTrait;", ""), "missing-test-trait"],
    [erisTest().replace("Generators::choose(0, 100)", "$generator"), "unsupported-generator"],
    [erisTest().replace("Generators::choose(0, 100)", "Generators::inventValues()"), "unsupported-generator"],
    [erisTest().replace("->then(function", "->when(function"), "missing-property-execution"],
    [erisTest().replace("$this->forAll(", "$this->limitTo(10000); $this->forAll("), "unsupported-iteration-override"],
    [erisTest().replace("MoneyAllocator::allocate($total, $parts)", "$total"), "missing-target-invocation"],
    [erisTest().replace("$this->assertSame($total, array_sum($allocation));", "$allocation;"), "missing-invariant-check"],
  ] as const;
  for (const [source, signal] of cases) {
    const inspection = await inspectEris(await fixture(source));
    assert.equal(inspection.outcome, "rejected");
    assert.equal(inspection.tests[0]?.signals.includes(signal), true);
    assert.throws(() => requireAcceptedErisPropertyTestQuality(inspection), new RegExp(signal));
  }
});

test("fails closed for unsupported source and unbound exact Eris evidence", async () => {
  await assert.rejects(inspectEris(await fixture(`${erisTest()}${" ".repeat(256_001)}`)), /1-256000 bytes/);
  await assert.rejects(inspectEris(await fixture("<?php final class GeneratedTest extends TestCase {")), /malformed lexical structure/);

  const request = await fixture(erisTest());
  const inspection = await inspectEris(request);
  assert.throws(() => assertErisPropertyTestQualityInspection({ ...inspection, extra: true }, request), /exact schema/);
  assert.throws(() => assertErisPropertyTestQualityInspection({ ...inspection, target: "src/Other.php" }, request), /property execution proof/);
  assert.throws(() => assertErisPropertyTestQualityInspection({ ...inspection, invariant: "anything passes" }, request), /property execution proof/);
  assert.throws(() => assertErisPropertyTestQualityInspection({ ...inspection, selectedTestPath: "tests/Other.php" }, request), /selected proof test path/);
  assert.throws(() => assertErisPropertyTestQualityInspection({ ...inspection, lifecycleAttempts: 2 }, request), /baseline lifecycle/);
  assert.throws(() => assertErisPropertyTestQualityInspection({ ...inspection, tests: [{ ...inspection.tests[0]!, executedInputCount: 33 }] }, request), /property execution proof/);
  const { propertyProof: _propertyProof, ...withoutPropertyProof } = request;
  await assert.rejects(inspectEris(withoutPropertyProof), /exact bounded property execution proof/);
});

test("the PHP adapter preserves PHPUnit gates before sealing Eris evidence", async () => {
  const adapter = new PhpAdapter();
  const request = await fixture(erisTest());
  const accepted = await adapter.inspectGeneratedTestQuality(request);
  assert.equal(accepted?.framework, "eris");
  assert.equal(accepted?.outcome, "accepted");

  const skipped = await fixture(erisTest().replace("$this->forAll(", "$this->markTestSkipped(); $this->forAll("));
  await assert.rejects(adapter.inspectGeneratedTestQuality(skipped), /skipped-test/);
});

function erisTest(): string {
  return `<?php
use Eris\\Generators;
use PHPUnit\\Framework\\TestCase;

final class GeneratedTest extends TestCase
{
    use \\Eris\\TestTrait;

    public function testAllocationInvariant(): void
    {
        $this->forAll(
            Generators::choose(0, 100),
            Generators::choose(1, 10)
        )->then(function (int $total, int $parts): void {
            $allocation = MoneyAllocator::allocate($total, $parts);
            $this->assertSame($total, array_sum($allocation));
        });
    }
}
`;
}

async function inspectEris(request: GeneratedTestQualityInspectionRequest) {
  const runnerInspection = await inspectPhpunitGeneratedTestQuality(request);
  return inspectErisPropertyTestQuality(request, runnerInspection);
}

async function fixture(source: string): Promise<GeneratedTestQualityInspectionRequest> {
  const root = await mkdtemp(join(tmpdir(), "eris-property-test-quality-"));
  const path = "tests/Property/GeneratedTest.php";
  await mkdir(join(root, "tests", "Property"), { recursive: true });
  await writeFile(join(root, path), source);
  const sha256 = createHash("sha256").update(source).digest("hex");
  return {
    root,
    framework: "phpunit",
    propertyFramework: "eris",
    selectedTestPath: path,
    observedTestPaths: [path],
    baselineLifecycle: lifecycle(path, sha256),
    propertyProof: propertyProof(path),
  };
}

function lifecycle(path: string, sha256: string): GeneratedTestLifecycleDecision {
  const tests = [{ path, status: "executed" as const, assertionCount: 32, toleranceSha256: "a".repeat(64) }];
  return {
    schemaVersion: "generated-test-lifecycle-decision/v1",
    phase: "baseline",
    outcome: "accepted",
    command: ["vendor/bin/phpunit", "tests/Property"],
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

function propertyProof(path: string): PropertyTestExecutionProof {
  return {
    schemaVersion: "property-test-execution-proof/v1",
    executionNonce: "d".repeat(32),
    testPath: path,
    target: "app/Domain/MoneyAllocator.php",
    invariant: "sum(allocation) equals total",
    inputDigests: Array.from({ length: 32 }, (_, index) => createHash("sha256").update(String(index)).digest("hex")),
    targetExecutionCount: 32,
    invariantCheckCount: 32,
    failedInvariantCheckCount: 1,
  };
}
