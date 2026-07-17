import type { CandidateKind } from "./model.js";

export const improvementIntents = ["defect", "refactor", "performance", "maintainability"] as const;
export type ImprovementIntent = (typeof improvementIntents)[number];

export const baselineProofModes = [
  "defect-regression",
  "refactor-characterization",
  "performance-measurement",
  "maintainability-quality",
] as const;
export type BaselineProofMode = (typeof baselineProofModes)[number];

export interface ImprovementIntentContract {
  readonly schemaVersion: "improvement-intent/v1";
  readonly intent: ImprovementIntent;
  readonly baselineProof: BaselineProofMode;
}

const intentByCandidateKind = {
  "test-protection": "refactor",
  "static-analysis": "defect",
  "mutation-testing": "defect",
  "property-testing": "defect",
  "dependency-vulnerability": "defect",
  performance: "performance",
  maintainability: "maintainability",
  documentation: "maintainability",
} as const satisfies Readonly<Record<CandidateKind, ImprovementIntent>>;

const proofByIntent = {
  defect: "defect-regression",
  refactor: "refactor-characterization",
  performance: "performance-measurement",
  maintainability: "maintainability-quality",
} as const satisfies Readonly<Record<ImprovementIntent, BaselineProofMode>>;

export function classifyImprovementIntent(
  candidateKind: CandidateKind,
  declaredIntent?: ImprovementIntent,
): ImprovementIntentContract {
  const intent = declaredIntent ?? intentByCandidateKind[candidateKind];
  if (!intent) throw new Error(`Unsupported candidate kind for improvement intent: ${String(candidateKind)}.`);
  if (!isImprovementIntent(intent)) throw new Error(`Unsupported declared improvement intent: ${String(intent)}.`);
  return {
    schemaVersion: "improvement-intent/v1",
    intent,
    baselineProof: proofByIntent[intent],
  };
}

export function assertImprovementIntent(value: unknown): ImprovementIntentContract {
  if (!isExactRecord(value, ["schemaVersion", "intent", "baselineProof"])) {
    throw new Error("Improvement intent must use the exact improvement-intent/v1 schema.");
  }
  if (value.schemaVersion !== "improvement-intent/v1") {
    throw new Error("Improvement intent must use schema improvement-intent/v1.");
  }
  if (!isImprovementIntent(value.intent)) throw new Error("Improvement intent is unsupported.");
  if (!baselineProofModes.includes(value.baselineProof as BaselineProofMode)) {
    throw new Error("Improvement intent baseline proof is unsupported.");
  }
  if (value.baselineProof !== proofByIntent[value.intent]) {
    throw new Error(`Improvement intent ${value.intent} is inconsistent with baseline proof ${String(value.baselineProof)}.`);
  }
  return value as unknown as ImprovementIntentContract;
}

export function baselineMustFail(intent: ImprovementIntentContract): boolean {
  return assertImprovementIntent(intent).intent === "defect";
}

function isImprovementIntent(value: unknown): value is ImprovementIntent {
  return typeof value === "string" && improvementIntents.includes(value as ImprovementIntent);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
