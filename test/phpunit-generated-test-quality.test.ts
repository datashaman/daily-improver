import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPhpunitGeneratedTestQualityInspection,
  inspectPhpunitGeneratedTestQuality,
  requireAcceptedPhpunitGeneratedTestQuality,
} from "../src/adapters/phpunit-generated-test-quality.js";
import { PhpAdapter } from "../src/adapters/php.js";
import type { GeneratedTestQualityInspectionRequest } from "../src/contracts.js";
import type { GeneratedTestLifecycleDecision } from "../src/domain/generated-test-lifecycle.js";

test("accepts focused PHPUnit discovery with assertions and locally provable providers", async () => {
  const source = `<?php
use PHPUnit\\Framework\\Attributes\\DataProvider;
use PHPUnit\\Framework\\Attributes\\Test;
use PHPUnit\\Framework\\TestCase;

final class GeneratedTest extends TestCase
{
    public function testConvention(): void
    {
        self::assertTrue(true);
    }

    #[Test]
    #[DataProvider('totals')]
    public function preservesTotals(int $total): void
    {
        $this->assertGreaterThanOrEqual(0, $total);
    }

    public static function totals(): array
    {
        return [[0], [10], [11]];
    }
}
`;
  const request = await fixture(source, 4);
  const inspection = await inspectPhpunitGeneratedTestQuality(request);

  assert.equal(inspection.outcome, "accepted");
  assert.equal(inspection.tests[0]?.declarationCount, 2);
  assert.equal(inspection.tests[0]?.conventionDeclarationCount, 1);
  assert.equal(inspection.tests[0]?.attributeDeclarationCount, 1);
  assert.equal(inspection.tests[0]?.dataProviderCount, 1);
  assert.equal(inspection.tests[0]?.dataProviderCaseCount, 3);
  assert.deepEqual(inspection.tests[0]?.signals, []);
  assert.doesNotMatch(JSON.stringify(inspection), /preservesTotals|assertGreaterThanOrEqual/);
  assert.doesNotThrow(() => requireAcceptedPhpunitGeneratedTestQuality(inspection));
});

test("accepts docblock discovery and bounded generator providers", async () => {
  const source = `<?php
use PHPUnit\\Framework\\TestCase;
final class GeneratedTest extends TestCase {
    /** @test @dataProvider cases */
    public function preserves_value(int $value): void { $this->assertIsInt($value); }
    public static function cases(): iterable { yield [1]; yield [2]; }
}
`;
  const inspection = await inspectPhpunitGeneratedTestQuality(await fixture(source, 2));
  assert.equal(inspection.outcome, "accepted");
  assert.equal(inspection.tests[0]?.docblockDeclarationCount, 1);
  assert.equal(inspection.tests[0]?.dataProviderCaseCount, 2);
});

test("rejects skipped, incomplete, and assertion-free PHPUnit tests", async () => {
  const cases = [
    ["$this->markTestSkipped('later'); $this->assertTrue(true);", "skipped-test", 1],
    ["$this->markTestIncomplete('later'); $this->assertTrue(true);", "incomplete-test", 1],
    ["return;", "assertion-free-test", 0],
  ] as const;
  for (const [body, signal, assertions] of cases) {
    const inspection = await inspectPhpunitGeneratedTestQuality(await fixture(testClass(`public function testGenerated(): void { ${body} }`), assertions));
    assert.equal(inspection.outcome, "rejected");
    assert.equal(inspection.tests[0]?.signals.includes(signal), true);
    assert.throws(() => requireAcceptedPhpunitGeneratedTestQuality(inspection), new RegExp(signal));
  }
});

test("rejects empty, missing, dynamic, and external PHPUnit data providers", async () => {
  const sources = [
    testClass("#[\\PHPUnit\\Framework\\Attributes\\DataProvider('cases')] public function testGenerated(int $value): void { $this->assertIsInt($value); } public static function cases(): array { return []; }"),
    testClass("#[\\PHPUnit\\Framework\\Attributes\\DataProvider('missing')] public function testGenerated(int $value): void { $this->assertIsInt($value); }"),
    testClass("#[\\PHPUnit\\Framework\\Attributes\\DataProvider('cases')] public function testGenerated(int $value): void { $this->assertIsInt($value); } public static function cases(): array { return self::dynamicCases(); }"),
    testClass("#[\\PHPUnit\\Framework\\Attributes\\DataProviderExternal(Other::class, 'cases')] public function testGenerated(int $value): void { $this->assertIsInt($value); }"),
    testClass("#[\\PHPUnit\\Framework\\Attributes\\TestWithJson('[1]')] public function testGenerated(int $value): void { $this->assertIsInt($value); }"),
    testClass("#[\\PHPUnit\\Framework\\Attributes\\DataProvider('cases')] public function testGenerated(int $value): void { $this->assertIsInt($value); } public static function cases(): iterable { yield from self::dynamicCases(); }"),
  ];
  for (const source of sources) {
    const inspection = await inspectPhpunitGeneratedTestQuality(await fixture(source, 1));
    assert.equal(inspection.outcome, "rejected");
    assert.equal(inspection.tests[0]?.signals.some((signal) => signal === "empty-data-provider" || signal === "unsupported-data-provider"), true);
  }
});

test("fails closed for unsupported discovery, malformed or unbounded source, and unbound evidence", async () => {
  await assert.rejects(inspectPhpunitGeneratedTestQuality(await fixture("<?php function helper(): void {}", 1)), /test-class discovery/);
  await assert.rejects(inspectPhpunitGeneratedTestQuality(await fixture("<?php class EmptyTest extends TestCase {} class Helper { public function testFake(): void { self::assertTrue(true); } }", 1)), /test-method discovery/);
  await assert.rejects(inspectPhpunitGeneratedTestQuality(await fixture(testClass("private function testHidden(): void { self::assertTrue(true); }"), 1)), /non-public/);
  await assert.rejects(inspectPhpunitGeneratedTestQuality(await fixture(`${testClass("public function testX(): void { self::assertTrue(true); }")} ${" ".repeat(256_001)}`, 1)), /1-256000 bytes/);
  await assert.rejects(inspectPhpunitGeneratedTestQuality(await fixture("<?php final class X extends TestCase { public function testX(): void {", 1)), /malformed lexical structure/);

  const request = await fixture(testClass("public function testX(): void { self::assertTrue(true); }"), 1);
  const inspection = await inspectPhpunitGeneratedTestQuality(request);
  assert.throws(() => assertPhpunitGeneratedTestQualityInspection({ ...inspection, extra: true }, request), /exact schema/);
  assert.throws(() => assertPhpunitGeneratedTestQualityInspection({ ...inspection, selectedTestPath: "tests/Other.php" }, request), /selected test path/);
  assert.throws(() => assertPhpunitGeneratedTestQualityInspection({ ...inspection, lifecycleAttempts: 2 }, request), /baseline lifecycle/);
  assert.throws(() => assertPhpunitGeneratedTestQualityInspection({ ...inspection, outcome: "rejected" }, request), /outcome is inconsistent/);
  assert.throws(() => assertPhpunitGeneratedTestQualityInspection({ ...inspection, tests: [{ ...inspection.tests[0]!, lifecycleAssertionCount: 2 }] }, request), /lifecycle assertions/);
});

test("the PHP adapter gates PHPUnit evidence and leaves unknown frameworks unchanged", async () => {
  const adapter = new PhpAdapter();
  const accepted = await fixture(testClass("public function testX(): void { self::assertTrue(true); }"), 1);
  assert.equal((await adapter.inspectGeneratedTestQuality(accepted))?.outcome, "accepted");

  const skipped = await fixture(testClass("public function testX(): void { $this->markTestSkipped(); self::assertTrue(true); }"), 1);
  await assert.rejects(adapter.inspectGeneratedTestQuality(skipped), /skipped-test/);
  assert.equal(await adapter.inspectGeneratedTestQuality({ ...accepted, framework: "codeception" }), undefined);
});

function testClass(body: string): string {
  return `<?php
use PHPUnit\\Framework\\TestCase;
final class GeneratedTest extends TestCase { ${body} }
`;
}

async function fixture(source: string, assertionCount: number): Promise<GeneratedTestQualityInspectionRequest> {
  const root = await mkdtemp(join(tmpdir(), "phpunit-generated-test-quality-"));
  const path = "tests/Feature/GeneratedTest.php";
  await mkdir(join(root, "tests", "Feature"), { recursive: true });
  await writeFile(join(root, path), source);
  const sha256 = createHash("sha256").update(source).digest("hex");
  return {
    root,
    framework: "phpunit",
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
    command: ["vendor/bin/phpunit"],
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
