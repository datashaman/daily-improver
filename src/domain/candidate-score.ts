import { candidateKinds, type CandidateKind, type RankedCandidate } from "./model.js";

export const candidateScoreExplanationSchemaVersion = "candidate-score-explanation/v1" as const;

export const candidateScoreFactorNames = [
  "evidenceStrength",
  "confidence",
  "impact",
  "effort",
  "estimatedDiff",
  "changeRisk",
  "subsystemRisk",
  "testability",
] as const;

export type CandidateScoreFactorName = (typeof candidateScoreFactorNames)[number];

export type CandidateScoreFactors = Readonly<Record<CandidateScoreFactorName, number>>;

export const candidateScoreCategoryWeights = {
  "test-protection": { evidenceStrength: 0.12, confidence: 0.21, impact: 0.28, effort: -0.1, estimatedDiff: -0.05, changeRisk: -0.08, subsystemRisk: -0.06, testability: 0.1 },
  "static-analysis": { evidenceStrength: 0.12, confidence: 0.28, impact: 0.21, effort: -0.14, estimatedDiff: -0.05, changeRisk: -0.06, subsystemRisk: -0.06, testability: 0.08 },
  "mutation-testing": { evidenceStrength: 0.12, confidence: 0.245, impact: 0.21, effort: -0.175, estimatedDiff: -0.05, changeRisk: -0.06, subsystemRisk: -0.06, testability: 0.08 },
  "property-testing": { evidenceStrength: 0.12, confidence: 0.245, impact: 0.245, effort: -0.14, estimatedDiff: -0.05, changeRisk: -0.06, subsystemRisk: -0.06, testability: 0.08 },
  "dependency-vulnerability": { evidenceStrength: 0.14, confidence: 0.175, impact: 0.315, effort: -0.07, estimatedDiff: -0.04, changeRisk: -0.12, subsystemRisk: -0.08, testability: 0.06 },
  performance: { evidenceStrength: 0.12, confidence: 0.21, impact: 0.28, effort: -0.14, estimatedDiff: -0.05, changeRisk: -0.06, subsystemRisk: -0.07, testability: 0.08 },
  maintainability: { evidenceStrength: 0.12, confidence: 0.21, impact: 0.245, effort: -0.14, estimatedDiff: -0.05, changeRisk: -0.09, subsystemRisk: -0.07, testability: 0.07 },
  documentation: { evidenceStrength: 0.12, confidence: 0.28, impact: 0.175, effort: -0.14, estimatedDiff: -0.06, changeRisk: -0.09, subsystemRisk: -0.06, testability: 0.07 },
} satisfies Readonly<Record<CandidateKind, CandidateScoreFactors>>;

export interface CandidateScoreExplanation {
  readonly schemaVersion: typeof candidateScoreExplanationSchemaVersion;
  readonly candidateReference: string;
  readonly candidateKind: CandidateKind;
  readonly normalizedFactors: CandidateScoreFactors;
  readonly categoryWeights: CandidateScoreFactors;
  readonly rawWeightedContribution: number;
  readonly repositoryPriorityInfluence: number;
  readonly valueClassificationCap: number | null;
  readonly finalRoundedScore: number;
}

export function assertScoreExplanations(
  candidates: readonly RankedCandidate[],
  explanations: readonly CandidateScoreExplanation[],
  priorities?: readonly CandidateKind[],
): void {
  if (!Array.isArray(explanations) || explanations.length > 1_000) {
    throw new Error("Candidate score explanations must be a bounded list.");
  }
  const identities = new Set<string>();
  for (const explanation of explanations) {
    replayScoreExplanation(explanation);
    const identity = `${explanation.candidateReference}\u0000${explanation.candidateKind}`;
    if (identities.has(identity)) throw new Error("Candidate score explanations contain duplicate identities.");
    identities.add(identity);
    if (priorities !== undefined) {
      const priorityIndex = priorities.indexOf(explanation.candidateKind);
      const expectedInfluence = priorityIndex === -1
        ? 0
        : 0.05 * ((priorities.length - priorityIndex) / priorities.length);
      if (explanation.repositoryPriorityInfluence !== expectedInfluence) {
        throw new Error("Candidate score explanation priority influence is inconsistent with repository configuration.");
      }
    }
  }
  for (let index = 1; index < explanations.length; index += 1) {
    const previous = explanations[index - 1];
    const current = explanations[index];
    if (!previous || !current) throw new Error("Candidate score explanation ordering is incomplete.");
    if (previous.finalRoundedScore < current.finalRoundedScore
      || (previous.finalRoundedScore === current.finalRoundedScore
        && previous.candidateReference.localeCompare(current.candidateReference) > 0)) {
      throw new Error("Candidate score explanations do not agree with deterministic ranking order.");
    }
  }
  for (const candidate of candidates) {
    const explanation = explanations.find((item) =>
      item.candidateReference === candidate.id && item.candidateKind === candidate.kind);
    if (!explanation || explanation.finalRoundedScore !== candidate.score) {
      throw new Error(`Candidate score explanation does not agree with persisted score for ${candidate.id}.`);
    }
    const expectedFactors: CandidateScoreFactors = {
      evidenceStrength: candidate.reproducibility?.strength ?? 0,
      confidence: candidate.confidence,
      impact: candidate.impact,
      effort: candidate.effort,
      estimatedDiff: Math.min(candidate.estimatedDiffLines / 250, 1),
      changeRisk: candidate.risk,
      subsystemRisk: candidate.subsystemRisk,
      testability: candidate.testability,
    };
    if (candidateScoreFactorNames.some((factor) =>
      explanation.normalizedFactors[factor] !== expectedFactors[factor])) {
      throw new Error(`Candidate score explanation factors do not agree with ${candidate.id}.`);
    }
    const expectedCap = candidate.valueClassification?.classification === "cosmetic-only" ? 0.01 : null;
    if (explanation.valueClassificationCap !== expectedCap) {
      throw new Error(`Candidate score explanation cap does not agree with ${candidate.id}.`);
    }
  }
  const candidateOrder = candidates.map(({ id, kind }) => `${id}\u0000${kind}`);
  const candidateKeys = new Set(candidateOrder);
  const explainedOrder = explanations
    .map(({ candidateReference, candidateKind }) => `${candidateReference}\u0000${candidateKind}`)
    .filter((key) => candidateKeys.has(key));
  if (candidateOrder.length !== explainedOrder.length
    || candidateOrder.some((key, index) => key !== explainedOrder[index])) {
    throw new Error("Candidate scores do not agree with deterministic ranking order.");
  }
}

export function replayScoreExplanation(explanation: CandidateScoreExplanation): number {
  if (!isExactRecord(explanation, [
    "schemaVersion",
    "candidateReference",
    "candidateKind",
    "normalizedFactors",
    "categoryWeights",
    "rawWeightedContribution",
    "repositoryPriorityInfluence",
    "valueClassificationCap",
    "finalRoundedScore",
  ]) || explanation.schemaVersion !== candidateScoreExplanationSchemaVersion
    || typeof explanation.candidateReference !== "string"
    || explanation.candidateReference.length === 0
    || explanation.candidateReference.length > 160
    || !candidateKinds.some((kind) => kind === explanation.candidateKind)) {
    throw new Error("Candidate score explanation is malformed or unbounded.");
  }
  const factors = factorRecord(explanation.normalizedFactors, true);
  const weights = factorRecord(explanation.categoryWeights, false);
  const expectedWeights = candidateScoreCategoryWeights[explanation.candidateKind];
  if (candidateScoreFactorNames.some((factor) => weights[factor] !== expectedWeights[factor])) {
    throw new Error("Candidate score explanation category weights are inconsistent.");
  }
  const rawWeightedContribution = candidateScoreFactorNames.reduce(
    (total, factor) => total + factors[factor] * weights[factor],
    0,
  );
  if (!Number.isFinite(explanation.rawWeightedContribution)
    || rawWeightedContribution !== explanation.rawWeightedContribution) {
    throw new Error("Candidate score explanation raw contribution is inconsistent.");
  }
  if (!Number.isFinite(explanation.repositoryPriorityInfluence)
    || explanation.repositoryPriorityInfluence < 0
    || explanation.repositoryPriorityInfluence > 0.05) {
    throw new Error("Candidate score explanation priority influence is unbounded.");
  }
  if (explanation.valueClassificationCap !== null && explanation.valueClassificationCap !== 0.01) {
    throw new Error("Candidate score explanation value cap is malformed.");
  }
  const weightedScore = round(rawWeightedContribution + explanation.repositoryPriorityInfluence);
  const replayed = explanation.valueClassificationCap === null
    ? weightedScore
    : Math.min(weightedScore, explanation.valueClassificationCap);
  if (!Number.isFinite(explanation.finalRoundedScore) || replayed !== explanation.finalRoundedScore) {
    throw new Error("Candidate score explanation final score is inconsistent.");
  }
  return replayed;
}

function factorRecord(value: unknown, unitInterval: boolean): CandidateScoreFactors {
  if (!isExactRecord(value, candidateScoreFactorNames)) {
    throw new Error("Candidate score explanation factors or weights are incomplete.");
  }
  for (const factor of candidateScoreFactorNames) {
    const item = value[factor];
    if (typeof item !== "number" || !Number.isFinite(item)
      || (unitInterval && (item < 0 || item > 1))
      || (!unitInterval && (item < -1 || item > 1))) {
      throw new Error("Candidate score explanation factors or weights are unbounded.");
    }
  }
  return value as CandidateScoreFactors;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
