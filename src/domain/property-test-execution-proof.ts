import { readFile, stat } from "node:fs/promises";

export const propertyTestExecutionProofSchemaVersion = "property-test-execution-proof/v1" as const;
export const minimumPropertyTestInputs = 32;
export const maximumPropertyTestInputs = 1_000;

export interface PropertyTestExecutionProof {
  readonly schemaVersion: typeof propertyTestExecutionProofSchemaVersion;
  readonly executionNonce: string;
  readonly testPath: string;
  readonly target: string;
  readonly invariant: string;
  readonly inputDigests: readonly string[];
  readonly targetExecutionCount: number;
  readonly invariantCheckCount: number;
  readonly failedInvariantCheckCount: number;
}

export interface PropertyTestExecutionExpectation {
  readonly executionNonce: string;
  readonly target: string;
  readonly approvedInvariants: readonly string[];
  readonly changedTestPaths: readonly string[];
  readonly baselineMustFail: boolean;
}

const digestPattern = /^[a-f0-9]{64}$/;
const noncePattern = /^[a-f0-9]{32}$/;
const safePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\x20-\x7e]+$/;

export async function readPropertyTestExecutionProof(
  path: string,
  expectation: PropertyTestExecutionExpectation,
): Promise<PropertyTestExecutionProof> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Generated property test did not emit an execution proof.");
    }
    throw error;
  }
  if (!metadata.isFile()) throw new Error("Property-test execution proof must be a regular file.");
  if (metadata.size > 80_000) throw new Error("Property-test execution proof exceeds 80000 bytes.");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Property-test execution proof is malformed JSON.");
  }
  return assertPropertyTestExecutionProof(value, expectation);
}

export function assertPropertyTestExecutionProof(
  value: unknown,
  expectation: PropertyTestExecutionExpectation,
): PropertyTestExecutionProof {
  const proof = exactRecord(value, [
    "schemaVersion",
    "executionNonce",
    "testPath",
    "target",
    "invariant",
    "inputDigests",
    "targetExecutionCount",
    "invariantCheckCount",
    "failedInvariantCheckCount",
  ]);
  if (proof.schemaVersion !== propertyTestExecutionProofSchemaVersion) {
    throw new Error(`Property-test execution proof must use ${propertyTestExecutionProofSchemaVersion}.`);
  }
  if (typeof proof.executionNonce !== "string" || !noncePattern.test(proof.executionNonce)) {
    throw new Error("Property-test execution proof nonce is malformed.");
  }
  if (proof.executionNonce !== expectation.executionNonce) {
    throw new Error("Property-test execution proof was not emitted by the current test execution.");
  }
  const testPath = boundedString(proof.testPath, "test path", 1_024);
  if (!safePathPattern.test(testPath) || !expectation.changedTestPaths.includes(testPath)) {
    throw new Error("Property-test execution proof does not identify an observed generated test.");
  }
  const target = boundedString(proof.target, "target", 1_024);
  if (!safePathPattern.test(target) || target !== expectation.target) {
    throw new Error("Property-test execution proof targets a file other than the selected target.");
  }
  const invariant = boundedString(proof.invariant, "invariant", 4_096);
  if (!expectation.approvedInvariants.includes(invariant)) {
    throw new Error("Property-test execution proof checks an unapproved invariant.");
  }
  if (!Array.isArray(proof.inputDigests)
    || proof.inputDigests.length < minimumPropertyTestInputs
    || proof.inputDigests.length > maximumPropertyTestInputs
    || proof.inputDigests.some((digest) => typeof digest !== "string" || !digestPattern.test(digest))) {
    throw new Error(`Property-test execution proof must contain ${minimumPropertyTestInputs}-${maximumPropertyTestInputs} input digests.`);
  }
  if (new Set(proof.inputDigests).size !== proof.inputDigests.length) {
    throw new Error("Property-test execution proof input space must contain unique generated inputs.");
  }
  const targetExecutionCount = boundedCount(proof.targetExecutionCount, "target execution count");
  const invariantCheckCount = boundedCount(proof.invariantCheckCount, "invariant check count");
  const failedInvariantCheckCount = boundedCount(proof.failedInvariantCheckCount, "failed invariant check count", 0);
  if (targetExecutionCount !== proof.inputDigests.length || invariantCheckCount !== proof.inputDigests.length) {
    throw new Error("Property-test execution proof must exercise the selected target and invariant once per generated input.");
  }
  if (failedInvariantCheckCount > invariantCheckCount) {
    throw new Error("Property-test execution proof contains an impossible failed invariant count.");
  }
  if (expectation.baselineMustFail && failedInvariantCheckCount < 1) {
    throw new Error("Defect property-test execution proof did not observe an invariant failure.");
  }
  if (!expectation.baselineMustFail && failedInvariantCheckCount !== 0) {
    throw new Error("Passing property-test baseline proof reported an invariant failure.");
  }
  return {
    schemaVersion: propertyTestExecutionProofSchemaVersion,
    executionNonce: proof.executionNonce,
    testPath,
    target,
    invariant,
    inputDigests: proof.inputDigests,
    targetExecutionCount,
    invariantCheckCount,
    failedInvariantCheckCount,
  };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Property-test execution proof must be an exact object.");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Property-test execution proof must have an exact schema.");
  }
  return record;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new Error(`Property-test execution proof ${name} is malformed.`);
  }
  return value;
}

function boundedCount(value: unknown, name: string, minimum = minimumPropertyTestInputs): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximumPropertyTestInputs) {
    throw new Error(`Property-test execution proof ${name} is out of bounds.`);
  }
  return value as number;
}
