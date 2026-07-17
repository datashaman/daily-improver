import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPropertyTestExecutionProof,
  readPropertyTestExecutionProof,
} from "../src/domain/property-test-execution-proof.js";
import { createSpec } from "../src/core/specification.js";
import type { RankedCandidate, RepositoryProfile } from "../src/domain/model.js";

const nonce = "a".repeat(32);
const target = "app/Domain/MoneyAllocator.php";
const invariant = "Every allocation sums to its requested total.";
const testPath = "tests/Property/MoneyAllocatorInvariantTest.php";
const inputDigests = Array.from({ length: 32 }, (_, index) => createHash("sha256").update(`input:${index}`).digest("hex"));
const expectation = {
  executionNonce: nonce,
  target,
  approvedInvariants: [invariant],
  changedTestPaths: [testPath],
  baselineMustFail: true,
} as const;

function proof(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "property-test-execution-proof/v1",
    executionNonce: nonce,
    testPath,
    target,
    invariant,
    inputDigests,
    targetExecutionCount: inputDigests.length,
    invariantCheckCount: inputDigests.length,
    failedInvariantCheckCount: 1,
    ...overrides,
  };
}

test("accepts a current execution proof over a bounded unique input space", () => {
  const validated = assertPropertyTestExecutionProof(proof(), expectation);
  assert.equal(validated.inputDigests.length, 32);
  assert.equal(validated.target, target);
  assert.equal(validated.invariant, invariant);
});

test("rejects malformed, unexecuted, and trivial property-test proof", () => {
  assert.throws(() => assertPropertyTestExecutionProof({ ...proof(), extra: true }, expectation), /exact schema/);
  assert.throws(() => assertPropertyTestExecutionProof(proof({ executionNonce: "b".repeat(32) }), expectation), /current test execution/);
  assert.throws(() => assertPropertyTestExecutionProof(proof({
    inputDigests: [inputDigests[0]],
    targetExecutionCount: 1,
    invariantCheckCount: 1,
  }), expectation), /32-1000 input digests/);
  assert.throws(() => assertPropertyTestExecutionProof(proof({
    inputDigests: Array.from({ length: 32 }, () => inputDigests[0]),
  }), expectation), /unique generated inputs/);
  assert.throws(() => assertPropertyTestExecutionProof(proof({ targetExecutionCount: 33 }), expectation), /once per generated input/);
});

test("rejects wrong generated test, selected target, and approved invariant", () => {
  assert.throws(() => assertPropertyTestExecutionProof(proof({ testPath: "tests/Property/Unobserved.php" }), expectation), /observed generated test/);
  assert.throws(() => assertPropertyTestExecutionProof(proof({ target: "app/Domain/Other.php" }), expectation), /selected target/);
  assert.throws(() => assertPropertyTestExecutionProof(proof({ invariant: "The result is non-empty." }), expectation), /unapproved invariant/);
  assert.throws(() => assertPropertyTestExecutionProof(proof({ failedInvariantCheckCount: 0 }), expectation), /did not observe an invariant failure/);
});

test("fails closed when the executed test omits or malforms its proof artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "property-proof-"));
  const path = join(root, "proof.json");
  await assert.rejects(readPropertyTestExecutionProof(path, expectation), /did not emit an execution proof/);
  await writeFile(path, "not-json", "utf8");
  await assert.rejects(readPropertyTestExecutionProof(path, expectation), /malformed JSON/);
});

test("specification binds property proof to one evidence-backed approved target", () => {
  const candidate: RankedCandidate = {
    id: "property-money-allocator",
    kind: "property-testing",
    title: "Protect allocation totals",
    rationale: "Exercise the stable allocation invariant.",
    confidence: 0.9,
    impact: 0.8,
    effort: 0.3,
    risk: 0.2,
    subsystemRisk: 0.2,
    testability: 0.95,
    evidence: ["Escaped allocation mutation"],
    suggestedFiles: [target, "tests/Property"],
    target,
    estimatedDiffLines: 60,
    propertyInvariants: [invariant],
    knownMutation: {
      schemaVersion: "known-mutation/v1",
      id: "known-remainder-mutation",
      target,
      operator: "Arithmetic/RemainderAllocation",
      executionMode: "baseline-known-mutant",
      criterion: { kind: "property-invariant", statement: invariant },
    },
    score: 0.8,
  };
  const profile: RepositoryProfile = {
    root: "/repository",
    adapter: "php",
    language: "php",
    frameworks: ["laravel"],
    signals: [],
    capabilities: new Map([["test", { kind: "test", command: ["php", "tests/run.php"], source: "manifest" }]]),
  };
  const spec = createSpec(candidate, profile, { maxFiles: 2, maxChangedLines: 80, maxCostUsd: 1 });
  assert.equal(spec.propertyTestTarget, target);
  assert.equal(spec.knownMutation?.criterion.statement, invariant);
  const { target: selectedTarget, ...candidateWithoutTarget } = candidate;
  assert.equal(selectedTarget, target);
  assert.throws(() => createSpec(candidateWithoutTarget, profile, {
    maxFiles: 2,
    maxChangedLines: 80,
    maxCostUsd: 1,
  }), /evidence-backed selected target/);
  assert.throws(() => createSpec({ ...candidate, target: "../outside.php", suggestedFiles: ["../outside.php"] }, profile, {
    maxFiles: 2,
    maxChangedLines: 80,
    maxCostUsd: 1,
  }), /approved repository-relative file/);
});
