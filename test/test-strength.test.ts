import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectPhpTestStrength, preparePhpTestStrength } from "../src/adapters/php-test-strength.js";
import {
  assertTestStrengthPlan,
  assertTestStrengthResult,
  compareTestStrength,
  testStrengthHash,
  type TestStrengthEntry,
} from "../src/domain/test-strength.js";

const plan = {
  schemaVersion: "test-strength-plan/v1",
  adapter: "php",
  policySha256: "a".repeat(64),
  targetScope: "adapter-test-sources",
  targetPaths: ["tests"],
} as const;

test("validates exact bounded source-free test-strength plans and results", () => {
  const validated = assertTestStrengthPlan(plan);
  assertTestStrengthResult(inventory([]), validated);
  assert.throws(() => assertTestStrengthPlan(undefined), /malformed/);
  assert.throws(() => assertTestStrengthPlan({ ...plan, extra: true }), /extended/);
  assert.throws(() => assertTestStrengthPlan({ ...plan, schemaVersion: "test-strength-plan/v2" }), /unsupported/);
  assert.throws(() => assertTestStrengthPlan({ ...plan, targetPaths: ["../tests"] }), /escaped|malformed/);
  assert.throws(() => assertTestStrengthResult({ ...inventory([]), extra: true }, validated), /extended/);
  const malformedEntry = { ...entry("raw", "executed", [], []), identitySha256: "raw test" };
  assert.throws(() => assertTestStrengthResult(inventory([malformedEntry]), validated), /identity/);
  assert.throws(() => assertTestStrengthResult({ ...inventory([]), inventorySha256: "f".repeat(64) }, validated), /inconsistent/);
});

test("accepts unchanged and strengthened repository tests", () => {
  const baseline = inventory([entry("test", "executed", [["expectation", 500]], ["case-a"])]);
  assert.equal(compareTestStrength(baseline, baseline).outcome, "unchanged");
  const strengthened = inventory([
    entry("test", "executed", [["expectation", 1_000], ["new-expectation", 1]], ["case-a", "case-b"]),
    entry("new-test", "executed", [["expectation", 1]], []),
  ]);
  assert.deepEqual(compareTestStrength(baseline, strengthened), {
    schemaVersion: "test-strength-comparison/v1",
    adapter: "php",
    policySha256: "a".repeat(64),
    targetScope: "adapter-test-sources",
    targetPaths: ["tests"],
    testIdentitySemantics: "php-test-declaration/v1",
    expectationIdentitySemantics: "php-test-expectation-position/v1",
    caseIdentitySemantics: "php-test-data-case/v1",
    baselineTestCount: 1,
    currentTestCount: 2,
    baselineExpectationCount: 1,
    currentExpectationCount: 3,
    baselineCaseCount: 1,
    currentCaseCount: 2,
    outcome: "strengthened",
  });
});

test("rejects deleted, skipped, and weakened repository tests", () => {
  const baseline = inventory([entry("test", "executed", [["expectation", 500]], ["case-a"])]);
  assert.throws(() => compareTestStrength(baseline, inventory([])), /deleted/);
  assert.throws(() => compareTestStrength(baseline, inventory([entry("test", "skipped", [["expectation", 500]], ["case-a"])])), /skipped|disabled/);
  assert.throws(() => compareTestStrength(baseline, inventory([entry("test", "executed", [], ["case-a"])])), /expectation/);
  assert.throws(() => compareTestStrength(baseline, inventory([entry("test", "executed", [["expectation", 100]], ["case-a"])])), /weakened/);
  assert.throws(() => compareTestStrength(baseline, inventory([entry("test", "executed", [["expectation", 500]], [])])), /data case/);
  const incomparable = {
    ...baseline,
    testIdentitySemantics: "other/v1",
    inventorySha256: testStrengthHash(JSON.stringify([
      "other/v1", baseline.expectationIdentitySemantics, baseline.caseIdentitySemantics, baseline.tests,
    ])),
  };
  assert.throws(() => compareTestStrength(baseline, incomparable), /incomparable/);
});

test("PHP adapter inventories unchanged, strengthened, skipped, and weakened PHPUnit and Pest tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-test-strength-"));
  await mkdir(join(root, "tests"));
  const phpunit = join(root, "tests", "AllocationTest.php");
  const pest = join(root, "tests", "AllocationPest.php");
  await writeFile(phpunit, phpunitSource("0.10", "[1, 2], [3, 4]"));
  await writeFile(pest, pestSource("toEqual", "['a'], ['b']"));
  const prepared = assertTestStrengthPlan(await preparePhpTestStrength());
  const baseline = assertTestStrengthResult(await inspectPhpTestStrength(root, prepared), prepared);
  assert.equal(baseline.tests.length, 2);
  assert.equal(baseline.tests.flatMap((entry) => entry.expectations).length, 2);
  assert.equal(baseline.tests.flatMap((entry) => entry.caseIdentities).length, 4);
  assert.doesNotMatch(JSON.stringify(baseline), /allocates money|testAllocation|\[1, 2\]|0\.10/);

  await writeFile(phpunit, phpunitSource("0.05", "[1, 2], [3, 4], [5, 6]"));
  await writeFile(pest, pestSource("toBe", "['a'], ['b'], ['c']"));
  const strengthened = assertTestStrengthResult(await inspectPhpTestStrength(root, prepared), prepared);
  assert.equal(compareTestStrength(baseline, strengthened).outcome, "strengthened");

  await writeFile(pest, pestSource("toBe", "['a'], ['b'], ['c']", "->skip()"));
  const skipped = assertTestStrengthResult(await inspectPhpTestStrength(root, prepared), prepared);
  assert.throws(() => compareTestStrength(baseline, skipped), /skipped/);

  await writeFile(pest, pestSource("toEqual", "['a'], ['b']"));
  await writeFile(phpunit, phpunitSource("0.20", "[1, 2], [3, 4]"));
  const weakened = assertTestStrengthResult(await inspectPhpTestStrength(root, prepared), prepared);
  assert.throws(() => compareTestStrength(baseline, weakened), /weakened/);
});

function entry(
  seed: string,
  status: TestStrengthEntry["status"],
  expectations: readonly (readonly [string, number])[],
  cases: readonly string[],
): TestStrengthEntry {
  return {
    identitySha256: digest(seed),
    status,
    expectations: expectations.map(([identity, strength]) => ({ identitySha256: digest(identity), strength })),
    caseIdentities: cases.map(digest),
  };
}

function inventory(tests: readonly TestStrengthEntry[]) {
  const sorted = [...tests].sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  return {
    schemaVersion: "test-strength-result/v1" as const,
    adapter: "php",
    policySha256: "a".repeat(64),
    targetScope: "adapter-test-sources" as const,
    targetPaths: ["tests"],
    testIdentitySemantics: "php-test-declaration/v1",
    expectationIdentitySemantics: "php-test-expectation-position/v1",
    caseIdentitySemantics: "php-test-data-case/v1",
    tests: sorted,
    inventorySha256: testStrengthHash(JSON.stringify([
      "php-test-declaration/v1", "php-test-expectation-position/v1", "php-test-data-case/v1", sorted,
    ])),
  };
}

function digest(value: string): string {
  return testStrengthHash(value);
}

function phpunitSource(delta: string, cases: string): string {
  return `<?php
use PHPUnit\\Framework\\TestCase;
final class AllocationTest extends TestCase {
    #[\\PHPUnit\\Framework\\Attributes\\DataProvider('allocations')]
    public function testAllocation(int $input, int $expected): void {
        self::assertEquals($expected, $input, '', ${delta});
    }
    public static function allocations(): array { return [${cases}]; }
}
`;
}

function pestSource(matcher: string, cases: string, suffix = ""): string {
  return `<?php
it('allocates money', function (string $value): void {
    expect($value)->${matcher}($value);
})->with([${cases}])${suffix};
`;
}
