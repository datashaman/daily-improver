import assert from "node:assert/strict";
import test from "node:test";
import {
  assertKnownMutationExecutionProof,
  assertKnownMutationRequirement,
  createKnownMutationExecutionProof,
  type KnownMutationRequirement,
} from "../src/domain/known-mutation-execution-proof.js";

const target = "app/Domain/MoneyAllocator.php";
const invariant = "Every allocation sums to its requested total.";
const testPath = "tests/Property/MoneyAllocatorInvariantTest.php";
const command = ["php", "tests/run.php"] as const;
const requirement: KnownMutationRequirement = {
  schemaVersion: "known-mutation/v1",
  id: "infection-arithmetic-remainder-24",
  target,
  operator: "Arithmetic/RemainderAllocation",
  executionMode: "baseline-known-mutant",
  criterion: { kind: "property-invariant", statement: invariant },
};
const expectation = {
  requirement,
  approvedPropertyInvariants: [invariant],
  approvedAcceptanceCriteria: ["The selected behavior is protected."],
  changedTestPaths: [testPath],
  relevantTestPath: testPath,
  command,
} as const;

test("records a relevant behavioral failure under a known mutation without raw source or output", () => {
  const proof = createKnownMutationExecutionProof({
    exitCode: 1,
    stdout: "raw generated-test failure",
    stderr: "raw source must not persist",
    durationMs: 17,
    classification: "property-invariant-violation",
  }, expectation);

  assert.equal(proof.mutationId, requirement.id);
  assert.equal(proof.testPath, testPath);
  assert.equal(proof.target, target);
  assert.equal(proof.criterion.statement, invariant);
  assert.deepEqual(proof.command, command);
  assert.equal(proof.outcome.status, "failed-as-required");
  assert.match(proof.outcome.stdoutSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(proof), /raw generated-test failure|raw source must not persist/);
});

test("rejects missing, malformed, unexecuted, survived, wrong-target, wrong-test, and wrong-criterion mutation proof", () => {
  const proof = createKnownMutationExecutionProof({
    exitCode: 1,
    stdout: "",
    stderr: "failure",
    durationMs: 10,
    classification: "test-assertion",
  }, expectation);
  assert.throws(() => assertKnownMutationExecutionProof(undefined, expectation), /exact object/);
  assert.throws(() => assertKnownMutationExecutionProof({
    ...proof,
    outcome: { ...proof.outcome, status: "not-run" },
  }, expectation), /survived/);
  assert.throws(() => createKnownMutationExecutionProof({
    exitCode: 0,
    stdout: "passed",
    stderr: "",
    durationMs: 10,
    classification: "unknown",
  }, expectation), /survived/);
  assert.throws(() => assertKnownMutationExecutionProof({ ...proof, extra: true }, expectation), /exact schema/);
  assert.throws(() => assertKnownMutationExecutionProof({ ...proof, target: "app/Domain/Other.php" }, expectation), /wrong target/);
  assert.throws(() => assertKnownMutationExecutionProof({ ...proof, testPath: "tests/Property/Other.php" }, expectation), /wrong generated test/);
  assert.throws(() => assertKnownMutationExecutionProof({
    ...proof,
    criterion: { kind: "property-invariant", statement: "The result is non-empty." },
  }, expectation), /wrong approved criterion/);
  assert.throws(() => assertKnownMutationExecutionProof({
    ...proof,
    outcome: { ...proof.outcome, classification: "syntax" },
  }, expectation), /non-behavioral reason/);
});

test("binds an exact known mutation requirement to the selected target and approved criterion", () => {
  assert.deepEqual(assertKnownMutationRequirement(requirement, [invariant], [], target), requirement);
  assert.throws(() => assertKnownMutationRequirement({ ...requirement, extra: true }, [invariant], [], target), /exact schema/);
  assert.throws(() => assertKnownMutationRequirement({ ...requirement, target: "src/Other.php" }, [invariant], [], target), /selected production file/);
  assert.throws(() => assertKnownMutationRequirement({
    ...requirement,
    criterion: { kind: "property-invariant", statement: "Unapproved" },
  }, [invariant], [], target), /not approved/);
});
