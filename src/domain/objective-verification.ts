import { createHash } from "node:crypto";
import { assertImprovementIntent, type ImprovementIntentContract } from "./improvement-intent.js";

export const objectiveVerificationPlanSchemaVersion = "objective-verification-plan/v1" as const;
export const objectiveVerificationResultSchemaVersion = "objective-verification-result/v1" as const;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const maximumCriteria = 64;
const maximumTargets = 10_000;
const maximumChecks = 64;
const maximumSafetyGates = 32;

export interface ObjectiveBaselineEvidence {
  readonly improvementIntent: ImprovementIntentContract;
  readonly expected: "fail" | "pass";
  readonly outcome: "failed-as-expected" | "passed-as-expected";
  readonly artifactSha256: string;
}

export interface ObjectiveVerifierEvidence {
  readonly schemaVersion: "objective-verifier-evidence/v1";
  readonly baseline: ObjectiveBaselineEvidence;
  readonly patchSha256: string;
  readonly changeSetSha256: string;
  readonly productionTargetIdentities: readonly string[];
  readonly checkIdentities: readonly string[];
  readonly passingCheckCount: number;
  readonly safetyGateIdentities: readonly string[];
}

export interface ObjectiveVerificationPlan {
  readonly schemaVersion: typeof objectiveVerificationPlanSchemaVersion;
  readonly policyId: "sealed-objective-evidence-policy/v1";
  readonly evidenceSemantics: "sealed-baseline-authenticated-change-fresh-verification/v1";
  readonly objectiveSha256: string;
  readonly proposedImprovementSha256: string;
  readonly acceptanceCriterionIdentities: readonly string[];
  readonly productionTargetIdentities: readonly string[];
  readonly patchSha256: string;
  readonly verifierEvidenceSha256: string;
  readonly planSha256: string;
}

export interface ObjectiveVerificationResult {
  readonly schemaVersion: typeof objectiveVerificationResultSchemaVersion;
  readonly policyId: ObjectiveVerificationPlan["policyId"];
  readonly evidenceSemantics: ObjectiveVerificationPlan["evidenceSemantics"];
  readonly planSha256: string;
  readonly verifierEvidenceSha256: string;
  readonly patchSha256: string;
  readonly productionTargetIdentities: readonly string[];
  readonly satisfiedAcceptanceCriterionIdentities: readonly string[];
  readonly outcome: "matched";
}

export function assertObjectiveVerifierEvidence(value: unknown): ObjectiveVerifierEvidence {
  const evidence = exactRecord(value, [
    "baseline", "changeSetSha256", "checkIdentities", "passingCheckCount", "patchSha256",
    "productionTargetIdentities", "safetyGateIdentities", "schemaVersion",
  ], "Objective verifier evidence");
  if (evidence.schemaVersion !== "objective-verifier-evidence/v1") {
    throw new Error("Objective verifier evidence uses an unsupported schema.");
  }
  const baselineValue = exactRecord(evidence.baseline, ["artifactSha256", "expected", "improvementIntent", "outcome"], "Objective baseline evidence");
  const assertedIntent = assertImprovementIntent(baselineValue.improvementIntent);
  const improvementIntent: ImprovementIntentContract = Object.freeze({
    schemaVersion: "improvement-intent/v1",
    intent: assertedIntent.intent,
    baselineProof: assertedIntent.baselineProof,
  });
  const expected = improvementIntent.intent === "defect" ? "fail" : "pass";
  const outcome = expected === "fail" ? "failed-as-expected" : "passed-as-expected";
  if (baselineValue.expected !== expected || baselineValue.outcome !== outcome) {
    throw new Error("Objective baseline evidence is inconsistent with the sealed improvement intent.");
  }
  const productionTargetIdentities = identities(evidence.productionTargetIdentities, maximumTargets, "production target", true);
  const checkIdentities = identities(evidence.checkIdentities, maximumChecks, "fresh verification check", true);
  const safetyGateIdentities = identities(evidence.safetyGateIdentities, maximumSafetyGates, "safety gate", true);
  if (!Number.isSafeInteger(evidence.passingCheckCount)
    || evidence.passingCheckCount !== checkIdentities.length) {
    throw new Error("Objective fresh verification evidence is incomplete or inconsistent.");
  }
  return Object.freeze({
    schemaVersion: "objective-verifier-evidence/v1",
    baseline: Object.freeze({
      improvementIntent,
      expected,
      outcome,
      artifactSha256: identity(baselineValue.artifactSha256, "baseline artifact"),
    }),
    patchSha256: identity(evidence.patchSha256, "patch"),
    changeSetSha256: identity(evidence.changeSetSha256, "change set"),
    productionTargetIdentities,
    checkIdentities,
    passingCheckCount: checkIdentities.length,
    safetyGateIdentities,
  });
}

export function assertObjectiveVerificationPlan(value: unknown): ObjectiveVerificationPlan {
  const plan = exactRecord(value, [
    "acceptanceCriterionIdentities", "evidenceSemantics", "objectiveSha256", "patchSha256", "planSha256",
    "policyId", "productionTargetIdentities", "proposedImprovementSha256", "schemaVersion", "verifierEvidenceSha256",
  ], "Objective-verification plan");
  if (plan.schemaVersion !== objectiveVerificationPlanSchemaVersion
    || plan.policyId !== "sealed-objective-evidence-policy/v1"
    || plan.evidenceSemantics !== "sealed-baseline-authenticated-change-fresh-verification/v1") {
    throw new Error("Objective-verification plan uses an unsupported schema, policy, or semantics.");
  }
  const validated = {
    schemaVersion: objectiveVerificationPlanSchemaVersion,
    policyId: "sealed-objective-evidence-policy/v1",
    evidenceSemantics: "sealed-baseline-authenticated-change-fresh-verification/v1",
    objectiveSha256: identity(plan.objectiveSha256, "objective"),
    proposedImprovementSha256: identity(plan.proposedImprovementSha256, "proposed improvement"),
    acceptanceCriterionIdentities: identities(plan.acceptanceCriterionIdentities, maximumCriteria, "acceptance criterion", true),
    productionTargetIdentities: identities(plan.productionTargetIdentities, maximumTargets, "production target", true),
    patchSha256: identity(plan.patchSha256, "patch"),
    verifierEvidenceSha256: identity(plan.verifierEvidenceSha256, "verifier evidence"),
  } as const;
  const planSha256 = identity(plan.planSha256, "plan");
  if (hash(JSON.stringify(validated)) !== planSha256) throw new Error("Objective-verification plan identity is inconsistent.");
  return Object.freeze({ ...validated, planSha256 });
}

export function assertObjectiveVerificationResult(
  value: unknown,
  plan: ObjectiveVerificationPlan,
): ObjectiveVerificationResult {
  const exactPlan = assertObjectiveVerificationPlan(plan);
  const result = exactRecord(value, [
    "evidenceSemantics", "outcome", "patchSha256", "planSha256", "policyId", "productionTargetIdentities",
    "satisfiedAcceptanceCriterionIdentities", "schemaVersion", "verifierEvidenceSha256",
  ], "Objective-verification result");
  if (result.schemaVersion !== objectiveVerificationResultSchemaVersion
    || result.policyId !== exactPlan.policyId || result.evidenceSemantics !== exactPlan.evidenceSemantics
    || result.planSha256 !== exactPlan.planSha256 || result.verifierEvidenceSha256 !== exactPlan.verifierEvidenceSha256
    || result.outcome !== "matched") {
    throw new Error("Objective-verification result is not bound to its exact plan or uses an unsupported outcome.");
  }
  const productionTargetIdentities = identities(result.productionTargetIdentities, maximumTargets, "production target", true);
  const satisfiedAcceptanceCriterionIdentities = identities(
    result.satisfiedAcceptanceCriterionIdentities,
    maximumCriteria,
    "satisfied acceptance criterion",
    true,
  );
  if (JSON.stringify(productionTargetIdentities) !== JSON.stringify(exactPlan.productionTargetIdentities)
    || JSON.stringify(satisfiedAcceptanceCriterionIdentities) !== JSON.stringify(exactPlan.acceptanceCriterionIdentities)
    || result.patchSha256 !== exactPlan.patchSha256) {
    throw new Error("Objective-verification result is inconsistent with the sealed objective plan.");
  }
  return Object.freeze({
    schemaVersion: objectiveVerificationResultSchemaVersion,
    policyId: exactPlan.policyId,
    evidenceSemantics: exactPlan.evidenceSemantics,
    planSha256: exactPlan.planSha256,
    verifierEvidenceSha256: exactPlan.verifierEvidenceSha256,
    patchSha256: identity(result.patchSha256, "patch"),
    productionTargetIdentities,
    satisfiedAcceptanceCriterionIdentities,
    outcome: "matched",
  });
}

export function hashObjectiveValue(value: unknown): string {
  return hash(JSON.stringify(value));
}

function identities(value: unknown, maximum: number, name: string, nonempty: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || (nonempty && value.length === 0)) {
    throw new Error(`Objective ${name} identities are malformed or excessive.`);
  }
  const values = value.map((item) => identity(item, name));
  if (new Set(values).size !== values.length || JSON.stringify(values) !== JSON.stringify([...values].sort())) {
    throw new Error(`Objective ${name} identities are duplicated or unsorted.`);
  }
  return Object.freeze(values);
}

function identity(value: unknown, name: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new Error(`Objective ${name} identity is malformed.`);
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name} is extended or malformed.`);
  return record;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
