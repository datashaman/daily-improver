import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { ImprovementSpec } from "../domain/model.js";
import { assertImprovementIntent } from "../domain/improvement-intent.js";
import {
  assertObjectiveVerificationPlan,
  assertObjectiveVerificationResult,
  assertObjectiveVerifierEvidence,
  hashObjectiveValue,
  type ObjectiveVerificationPlan,
  type ObjectiveVerificationResult,
  type ObjectiveBaselineEvidence,
  type ObjectiveVerifierEvidence,
} from "../domain/objective-verification.js";
import { readArtifact, runDirectory } from "./artifacts.js";
import type { VerifierExecutionInputs } from "./verifier-execution-inputs.js";

export async function createObjectiveVerifierEvidence(
  root: string,
  inputs: VerifierExecutionInputs,
  checks: readonly { readonly command: string; readonly exitCode: number; readonly durationMs: number }[],
  gates: Readonly<Record<string, unknown>>,
): Promise<ObjectiveVerifierEvidence> {
  const baseline = await objectiveBaselineEvidence(root, inputs);
  const specificationScope = gates.specificationScope as { readonly changeSetSha256?: unknown; readonly productionChanges?: unknown };
  const patchLimits = gates.patchLimits as { readonly patchSha256?: unknown };
  if (typeof specificationScope.changeSetSha256 !== "string"
    || !Array.isArray(specificationScope.productionChanges)
    || typeof patchLimits.patchSha256 !== "string") {
    throw new Error("Objective verification requires authenticated production-change and patch evidence.");
  }
  const productionTargetIdentities = specificationScope.productionChanges.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || typeof (value as { readonly pathSha256?: unknown }).pathSha256 !== "string") {
      throw new Error("Objective verification production-target evidence is malformed.");
    }
    return (value as { readonly pathSha256: string }).pathSha256;
  }).sort();
  const checkIdentities = checks.map((check) => hashObjectiveValue({
    schemaVersion: "objective-fresh-check/v1",
    commandSha256: hashObjectiveValue(check.command),
    exitCode: check.exitCode,
  })).sort();
  const safetyGateIdentities = Object.entries(gates).map(([gate, evidence]) => hashObjectiveValue({
    schemaVersion: "objective-safety-gate/v1",
    gate,
    evidence,
  })).sort();
  return {
    schemaVersion: "objective-verifier-evidence/v1",
    baseline,
    patchSha256: patchLimits.patchSha256,
    changeSetSha256: specificationScope.changeSetSha256,
    productionTargetIdentities,
    checkIdentities,
    passingCheckCount: checks.filter((check) => check.exitCode === 0).length,
    safetyGateIdentities,
  };
}

export function prepareObjectiveVerificationPlan(
  specification: Pick<ImprovementSpec, "objective" | "proposedImprovement" | "acceptanceCriteria">,
  evidenceValue: ObjectiveVerifierEvidence,
): ObjectiveVerificationPlan {
  const objective = boundedStatement(specification.objective, "objective");
  const proposedImprovement = boundedStatement(specification.proposedImprovement, "proposed improvement");
  const acceptanceCriteria = boundedStatements(specification.acceptanceCriteria, "acceptance criteria");
  const evidence = assertObjectiveVerifierEvidence(evidenceValue);
  const unsigned = {
    schemaVersion: "objective-verification-plan/v1" as const,
    policyId: "sealed-objective-evidence-policy/v1" as const,
    evidenceSemantics: "sealed-baseline-authenticated-change-fresh-verification/v1" as const,
    objectiveSha256: hash(objective),
    proposedImprovementSha256: hash(proposedImprovement),
    acceptanceCriterionIdentities: acceptanceCriteria.map(hash).sort(),
    productionTargetIdentities: evidence.productionTargetIdentities,
    patchSha256: evidence.patchSha256,
    verifierEvidenceSha256: hashObjectiveValue(evidence),
  };
  return assertObjectiveVerificationPlan({ ...unsigned, planSha256: hashObjectiveValue(unsigned) });
}

export function verifyImplementationObjective(
  specification: Pick<ImprovementSpec, "objective" | "proposedImprovement" | "acceptanceCriteria">,
  evidenceValue: ObjectiveVerifierEvidence,
  planValue: ObjectiveVerificationPlan,
): ObjectiveVerificationResult {
  const evidence = assertObjectiveVerifierEvidence(evidenceValue);
  const plan = assertObjectiveVerificationPlan(planValue);
  const independentlyPrepared = prepareObjectiveVerificationPlan(specification, evidence);
  if (independentlyPrepared.planSha256 !== plan.planSha256) {
    throw new Error("Objective-verification plan does not match the sealed specification and verifier evidence.");
  }
  return assertObjectiveVerificationResult({
    schemaVersion: "objective-verification-result/v1",
    policyId: plan.policyId,
    evidenceSemantics: plan.evidenceSemantics,
    planSha256: plan.planSha256,
    verifierEvidenceSha256: plan.verifierEvidenceSha256,
    patchSha256: evidence.patchSha256,
    productionTargetIdentities: evidence.productionTargetIdentities,
    satisfiedAcceptanceCriterionIdentities: plan.acceptanceCriterionIdentities,
    outcome: "matched",
  }, plan);
}

function boundedStatements(values: readonly string[], name: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64 || new Set(values).size !== values.length) {
    throw new Error(`Objective ${name} are missing, duplicated, or excessive.`);
  }
  return values.map((value) => boundedStatement(value, name));
}

async function objectiveBaselineEvidence(root: string, inputs: VerifierExecutionInputs): Promise<ObjectiveBaselineEvidence> {
  const testPlanPath = relative(root, `${runDirectory(root)}/test-plan.json`);
  const artifactSha256 = inputs.manifest.files[testPlanPath];
  if (!artifactSha256) throw new Error("Objective verification requires one sealed baseline test plan.");
  const value = await readArtifact<unknown>(root, "test-plan.json");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Objective baseline test plan is malformed.");
  const plan = value as Record<string, unknown>;
  const allowedKeys = [
    "adapterQualityInspection", "baseline", "command", "generatedTestLifecycle", "improvementIntent",
    "implementationInspection", "knownMutationExecutionProof", "propertyInvariants", "propertyTestExecutionProof", "schemaVersion",
  ];
  if (plan.schemaVersion !== "test-plan/v7" || Object.keys(plan).some((key) => !allowedKeys.includes(key))) {
    throw new Error("Objective baseline test plan uses an unsupported or extended schema.");
  }
  const improvementIntent = assertImprovementIntent(plan.improvementIntent);
  if (improvementIntent.intent !== inputs.specification.improvementIntent.intent
    || improvementIntent.baselineProof !== inputs.specification.improvementIntent.baselineProof) {
    throw new Error("Objective baseline proof does not match the sealed improvement intent.");
  }
  if (typeof plan.baseline !== "object" || plan.baseline === null || Array.isArray(plan.baseline)) {
    throw new Error("Objective baseline proof is malformed.");
  }
  const proof = plan.baseline as Record<string, unknown>;
  const expected = improvementIntent.intent === "defect" ? "fail" : "pass";
  const outcome = expected === "fail" ? "failed-as-expected" : "passed-as-expected";
  const expectedKeys = expected === "fail" ? ["classification", "expected", "outcome"] : ["expected", "outcome"];
  if (JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(expectedKeys.sort())
    || proof.expected !== expected || proof.outcome !== outcome
    || (expected === "fail" && (typeof proof.classification !== "string" || proof.classification.length === 0 || proof.classification.length > 256))) {
    throw new Error("Objective baseline proof is missing, malformed, or inconsistent.");
  }
  return { improvementIntent, expected, outcome, artifactSha256 };
}

function boundedStatement(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.trim() !== value || value.includes("\0")) {
    throw new Error(`Objective ${name} is malformed or unbounded.`);
  }
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
