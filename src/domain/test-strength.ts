import { createHash } from "node:crypto";

export const testStrengthPlanSchemaVersion = "test-strength-plan/v1" as const;
export const testStrengthResultSchemaVersion = "test-strength-result/v1" as const;
export const testStrengthComparisonSchemaVersion = "test-strength-comparison/v1" as const;

const maximumTests = 100_000;
const maximumExpectations = 1_000_000;
const maximumCases = 1_000_000;
const maximumTargetPaths = 32;
const maximumStrength = 1_000_000_000;
const statuses = ["disabled", "skipped", "executed"] as const;

export type TestExecutionStatus = (typeof statuses)[number];

export interface TestStrengthPlan {
  readonly schemaVersion: typeof testStrengthPlanSchemaVersion;
  readonly adapter: string;
  readonly policySha256: string;
  readonly targetScope: "adapter-test-sources";
  readonly targetPaths: readonly string[];
}

export interface TestExpectationStrength {
  readonly identitySha256: string;
  readonly strength: number;
}

export interface TestStrengthEntry {
  readonly identitySha256: string;
  readonly status: TestExecutionStatus;
  readonly expectations: readonly TestExpectationStrength[];
  readonly caseIdentities: readonly string[];
}

export interface TestStrengthResult {
  readonly schemaVersion: typeof testStrengthResultSchemaVersion;
  readonly adapter: string;
  readonly policySha256: string;
  readonly targetScope: "adapter-test-sources";
  readonly targetPaths: readonly string[];
  readonly testIdentitySemantics: string;
  readonly expectationIdentitySemantics: string;
  readonly caseIdentitySemantics: string;
  readonly tests: readonly TestStrengthEntry[];
  readonly inventorySha256: string;
}

export interface TestStrengthComparison {
  readonly schemaVersion: typeof testStrengthComparisonSchemaVersion;
  readonly adapter: string;
  readonly policySha256: string;
  readonly targetScope: "adapter-test-sources";
  readonly targetPaths: readonly string[];
  readonly testIdentitySemantics: string;
  readonly expectationIdentitySemantics: string;
  readonly caseIdentitySemantics: string;
  readonly baselineTestCount: number;
  readonly currentTestCount: number;
  readonly baselineExpectationCount: number;
  readonly currentExpectationCount: number;
  readonly baselineCaseCount: number;
  readonly currentCaseCount: number;
  readonly outcome: "clean" | "unchanged" | "strengthened";
}

export function assertTestStrengthPlan(value: unknown): TestStrengthPlan {
  const plan = exactRecord(value, ["adapter", "policySha256", "schemaVersion", "targetPaths", "targetScope"], "Test-strength plan");
  if (plan.schemaVersion !== testStrengthPlanSchemaVersion || plan.targetScope !== "adapter-test-sources") {
    throw new Error("Test-strength plan uses an unsupported schema or target scope.");
  }
  return Object.freeze({
    schemaVersion: testStrengthPlanSchemaVersion,
    adapter: identity(plan.adapter, "adapter"),
    policySha256: hash(plan.policySha256, "policy"),
    targetScope: "adapter-test-sources",
    targetPaths: paths(plan.targetPaths),
  });
}

export function assertTestStrengthResult(value: unknown, plan: TestStrengthPlan): TestStrengthResult {
  const result = exactRecord(value, [
    "adapter", "caseIdentitySemantics", "expectationIdentitySemantics", "inventorySha256", "policySha256",
    "schemaVersion", "targetPaths", "targetScope", "testIdentitySemantics", "tests",
  ], "Test-strength result");
  if (result.schemaVersion !== testStrengthResultSchemaVersion || result.targetScope !== plan.targetScope) {
    throw new Error("Test-strength result uses an unsupported schema or target scope.");
  }
  if (result.adapter !== plan.adapter || result.policySha256 !== plan.policySha256
    || JSON.stringify(result.targetPaths) !== JSON.stringify(plan.targetPaths)) {
    throw new Error("Test-strength result identifies the wrong adapter, policy, or target paths.");
  }
  if (!Array.isArray(result.tests) || result.tests.length > maximumTests) {
    throw new Error("Test-strength inventory is malformed or excessive.");
  }
  let expectationCount = 0;
  let caseCount = 0;
  const tests = result.tests.map((value) => {
    const test = exactRecord(value, ["caseIdentities", "expectations", "identitySha256", "status"], "Test-strength entry");
    if (!statuses.includes(test.status as TestExecutionStatus)) throw new Error("Test execution status is malformed.");
    if (!Array.isArray(test.expectations)) throw new Error("Test expectations are malformed.");
    expectationCount += test.expectations.length;
    if (expectationCount > maximumExpectations) throw new Error("Test expectations are excessive.");
    const expectations = test.expectations.map((value) => {
      const expectation = exactRecord(value, ["identitySha256", "strength"], "Test expectation");
      if (!Number.isSafeInteger(expectation.strength) || (expectation.strength as number) < 1
        || (expectation.strength as number) > maximumStrength) {
        throw new Error("Test expectation strength is malformed or excessive.");
      }
      return Object.freeze({
        identitySha256: hash(expectation.identitySha256, "expectation"),
        strength: expectation.strength as number,
      });
    }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
    unique(expectations.map((expectation) => expectation.identitySha256), "Test expectation identities");
    if (!Array.isArray(test.caseIdentities)) throw new Error("Test case identities are malformed.");
    caseCount += test.caseIdentities.length;
    if (caseCount > maximumCases) throw new Error("Test case identities are excessive.");
    const caseIdentities = test.caseIdentities.map((value) => hash(value, "case")).sort();
    unique(caseIdentities, "Test case identities");
    return Object.freeze({
      identitySha256: hash(test.identitySha256, "test"),
      status: test.status as TestExecutionStatus,
      expectations: Object.freeze(expectations),
      caseIdentities: Object.freeze(caseIdentities),
    });
  }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  unique(tests.map((test) => test.identitySha256), "Test identities");
  const testIdentitySemantics = schemaIdentity(result.testIdentitySemantics, "test");
  const expectationIdentitySemantics = schemaIdentity(result.expectationIdentitySemantics, "expectation");
  const caseIdentitySemantics = schemaIdentity(result.caseIdentitySemantics, "case");
  const inventorySha256 = hash(result.inventorySha256, "inventory");
  if (inventorySha256 !== testStrengthHash(JSON.stringify([
    testIdentitySemantics, expectationIdentitySemantics, caseIdentitySemantics, tests,
  ]))) throw new Error("Test-strength inventory identity is inconsistent.");
  return Object.freeze({
    schemaVersion: testStrengthResultSchemaVersion,
    adapter: plan.adapter,
    policySha256: plan.policySha256,
    targetScope: plan.targetScope,
    targetPaths: plan.targetPaths,
    testIdentitySemantics,
    expectationIdentitySemantics,
    caseIdentitySemantics,
    tests: Object.freeze(tests),
    inventorySha256,
  });
}

export function compareTestStrength(baselineValue: unknown, currentValue: unknown): TestStrengthComparison {
  const baseline = comparableResult(baselineValue, "baseline");
  const current = comparableResult(currentValue, "current");
  assertComparable(baseline, current);
  const currentTests = new Map(current.tests.map((test) => [test.identitySha256, test]));
  let strengthened = current.tests.length > baseline.tests.length;
  for (const baselineTest of baseline.tests) {
    const currentTest = currentTests.get(baselineTest.identitySha256);
    if (!currentTest) throw new Error("Verification deleted a repository test.");
    if (statusStrength(currentTest.status) < statusStrength(baselineTest.status)) {
      throw new Error("Verification skipped or disabled a repository test.");
    }
    if (statusStrength(currentTest.status) > statusStrength(baselineTest.status)) strengthened = true;
    const currentExpectations = new Map(currentTest.expectations.map((expectation) => [expectation.identitySha256, expectation.strength]));
    for (const expectation of baselineTest.expectations) {
      const currentStrength = currentExpectations.get(expectation.identitySha256);
      if (currentStrength === undefined || currentStrength < expectation.strength) {
        throw new Error("Verification removed or weakened a test expectation.");
      }
      if (currentStrength > expectation.strength) strengthened = true;
    }
    if (currentTest.expectations.length > baselineTest.expectations.length) strengthened = true;
    const currentCases = new Set(currentTest.caseIdentities);
    if (baselineTest.caseIdentities.some((identity) => !currentCases.has(identity))) {
      throw new Error("Verification removed a test data case.");
    }
    if (currentTest.caseIdentities.length > baselineTest.caseIdentities.length) strengthened = true;
  }
  const baselineExpectationCount = countExpectations(baseline);
  const currentExpectationCount = countExpectations(current);
  const baselineCaseCount = countCases(baseline);
  const currentCaseCount = countCases(current);
  return Object.freeze({
    schemaVersion: testStrengthComparisonSchemaVersion,
    adapter: baseline.adapter,
    policySha256: baseline.policySha256,
    targetScope: baseline.targetScope,
    targetPaths: baseline.targetPaths,
    testIdentitySemantics: baseline.testIdentitySemantics,
    expectationIdentitySemantics: baseline.expectationIdentitySemantics,
    caseIdentitySemantics: baseline.caseIdentitySemantics,
    baselineTestCount: baseline.tests.length,
    currentTestCount: current.tests.length,
    baselineExpectationCount,
    currentExpectationCount,
    baselineCaseCount,
    currentCaseCount,
    outcome: baseline.tests.length === 0 && current.tests.length === 0 ? "clean" : strengthened ? "strengthened" : "unchanged",
  });
}

export function testStrengthHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparableResult(value: unknown, label: string): TestStrengthResult {
  const record = exactRecord(value, [
    "adapter", "caseIdentitySemantics", "expectationIdentitySemantics", "inventorySha256", "policySha256",
    "schemaVersion", "targetPaths", "targetScope", "testIdentitySemantics", "tests",
  ], `Test-strength ${label} result`);
  return assertTestStrengthResult(record, assertTestStrengthPlan({
    schemaVersion: testStrengthPlanSchemaVersion,
    adapter: record.adapter,
    policySha256: record.policySha256,
    targetScope: record.targetScope,
    targetPaths: record.targetPaths,
  }));
}

function assertComparable(baseline: TestStrengthResult, current: TestStrengthResult): void {
  if (baseline.adapter !== current.adapter || baseline.policySha256 !== current.policySha256
    || baseline.targetScope !== current.targetScope || JSON.stringify(baseline.targetPaths) !== JSON.stringify(current.targetPaths)) {
    throw new Error("Test-strength results are incomparable across adapter, policy, or target scope.");
  }
  if (baseline.testIdentitySemantics !== current.testIdentitySemantics
    || baseline.expectationIdentitySemantics !== current.expectationIdentitySemantics
    || baseline.caseIdentitySemantics !== current.caseIdentitySemantics) {
    throw new Error("Test-strength results use incomparable adapter semantics.");
  }
}

function countExpectations(result: TestStrengthResult): number {
  return result.tests.reduce((count, test) => count + test.expectations.length, 0);
}

function countCases(result: TestStrengthResult): number {
  return result.tests.reduce((count, test) => count + test.caseIdentities.length, 0);
}

function statusStrength(status: TestExecutionStatus): number {
  return statuses.indexOf(status);
}

function paths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumTargetPaths) {
    throw new Error("Test-strength target paths are malformed or excessive.");
  }
  const parsed = value.map((path) => {
    if (typeof path !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(path)
      || path === "." || path.split("/").includes("..")) {
      throw new Error("Test-strength target path is escaped or malformed.");
    }
    return path;
  });
  unique(parsed, "Test-strength target paths");
  if (parsed.some((path, index) => index > 0 && parsed[index - 1]! >= path)) {
    throw new Error("Test-strength target paths are unsorted.");
  }
  return Object.freeze(parsed);
}

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} contain duplicates.`);
}

function identity(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`Test-strength ${name} is malformed.`);
  }
  return value;
}

function schemaIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/v[1-9][0-9]{0,5}$/u.test(value)) {
    throw new Error(`Test-strength ${name} identity semantics are malformed.`);
  }
  return value;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Test-strength ${name} identity is malformed.`);
  }
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name} is extended or incomplete.`);
  return record;
}
