import assert from "node:assert/strict";
import test from "node:test";
import type { ImprovementSpec } from "../src/domain/model.js";
import {
  assertObjectiveVerificationPlan,
  assertObjectiveVerificationResult,
  assertObjectiveVerifierEvidence,
  hashObjectiveValue,
  type ObjectiveVerifierEvidence,
} from "../src/domain/objective-verification.js";
import { prepareObjectiveVerificationPlan, verifyImplementationObjective } from "../src/core/objective-verification.js";

const targetIdentity = "a".repeat(64);

test("binds a matching implementation to the sealed objective and source-free verifier evidence", () => {
  const specification = fixtureSpecification();
  const evidence = fixtureEvidence();
  const plan = prepareObjectiveVerificationPlan(specification, evidence);
  const result = verifyImplementationObjective(specification, evidence, plan);

  assert.equal(result.outcome, "matched");
  assert.deepEqual(result.productionTargetIdentities, [targetIdentity]);
  assert.equal(result.satisfiedAcceptanceCriterionIdentities.length, 2);
  assert.doesNotMatch(JSON.stringify({ plan, result }), /allocator|remainder|sum invariant|MoneyAllocator/iu);
});

test("rejects mismatching, missing, malformed, extended, unsupported, unbounded, and adversarial objective decisions", () => {
  const specification = fixtureSpecification();
  const evidence = fixtureEvidence();
  const plan = prepareObjectiveVerificationPlan(specification, evidence);
  const result = verifyImplementationObjective(specification, evidence, plan);

  assert.throws(() => verifyImplementationObjective(
    { ...specification, proposedImprovement: "Implement a different behavior." },
    evidence,
    plan,
  ), /does not match/);
  assert.throws(() => assertObjectiveVerifierEvidence(undefined), /malformed/);
  assert.throws(() => assertObjectiveVerifierEvidence({ ...evidence, extra: true }), /extended/);
  assert.throws(() => assertObjectiveVerifierEvidence({ ...evidence, schemaVersion: "objective-verifier-evidence/v2" }), /unsupported/);
  assert.throws(() => assertObjectiveVerifierEvidence({ ...evidence, productionTargetIdentities: [] }), /malformed/);
  assert.throws(() => assertObjectiveVerifierEvidence({ ...evidence, passingCheckCount: 0 }), /incomplete/);
  assert.throws(() => assertObjectiveVerifierEvidence({
    ...evidence,
    baseline: { ...evidence.baseline, outcome: "passed-as-expected" },
  }), /inconsistent/);
  assert.throws(() => prepareObjectiveVerificationPlan({ ...specification, objective: "x".repeat(4_097) }, evidence), /unbounded/);
  assert.throws(() => assertObjectiveVerificationPlan({ ...plan, extra: "builder decision" }), /extended/);
  assert.throws(() => assertObjectiveVerificationPlan({ ...plan, verifierEvidenceSha256: "0".repeat(64) }), /inconsistent/);
  assert.throws(() => assertObjectiveVerificationResult({ ...result, outcome: "matched-by-builder" }, plan), /unsupported/);
  assert.throws(() => assertObjectiveVerificationResult({ ...result, patchSha256: "f".repeat(64) }, plan), /inconsistent/);
  assert.throws(() => assertObjectiveVerificationResult({
    ...result,
    productionTargetIdentities: ["b".repeat(64)],
  }, plan), /inconsistent/);
});

function fixtureEvidence(): ObjectiveVerifierEvidence {
  return {
    schemaVersion: "objective-verifier-evidence/v1",
    baseline: {
      improvementIntent: {
        schemaVersion: "improvement-intent/v1",
        intent: "defect",
        baselineProof: "defect-regression",
      },
      expected: "fail",
      outcome: "failed-as-expected",
      artifactSha256: "b".repeat(64),
    },
    patchSha256: "c".repeat(64),
    changeSetSha256: "d".repeat(64),
    productionTargetIdentities: [targetIdentity],
    checkIdentities: [hashObjectiveValue({ command: "sealed", exitCode: 0 })],
    passingCheckCount: 1,
    safetyGateIdentities: [hashObjectiveValue({ gate: "authenticated", outcome: "accepted" })],
  };
}

function fixtureSpecification(): ImprovementSpec {
  return {
    id: "spec-objective",
    improvementIntent: {
      schemaVersion: "improvement-intent/v1",
      intent: "defect",
      baselineProof: "defect-regression",
    },
    title: "Preserve allocated money",
    objective: "Correct remainder allocation in the allocator.",
    currentBehaviour: "The allocator loses the remainder.",
    proposedImprovement: "Distribute the remainder while preserving the sum invariant.",
    allowedFiles: ["app/Domain/MoneyAllocator.php"],
    behavioursToPreserve: ["Other allocations remain unchanged."],
    acceptanceCriteria: ["The allocated sum equals the input.", "Existing behavior remains green."],
    propertyInvariants: ["The allocated sum equals the input."],
    propertyTestTarget: "app/Domain/MoneyAllocator.php",
    exclusions: [],
    verification: ["test"],
    constraints: { maxFiles: 1, maxChangedLines: 20, maxCostUsd: 1 },
    evidence: ["A generated regression reproduces the defect."],
  };
}
