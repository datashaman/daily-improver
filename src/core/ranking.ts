import type { CandidateKind, ImprovementCandidate, RankedCandidate } from "../domain/model.js";
import { isCandidateValueClassification } from "../domain/candidate-value.js";
import { deduplicateCandidates } from "./candidate-deduplication.js";
import { rejectCandidatesWithoutReproducibleEvidence } from "./candidate-reproducibility.js";

interface ScoringWeights {
  readonly impact: number;
  readonly confidence: number;
  readonly effort: number;
  readonly risk: number;
  readonly evidenceStrength: number;
  readonly estimatedDiff: number;
  readonly subsystemRisk: number;
  readonly testability: number;
}

const categoryScoringWeights = {
  "test-protection": { impact: 0.28, confidence: 0.21, effort: 0.1, risk: 0.08, evidenceStrength: 0.12, estimatedDiff: 0.05, subsystemRisk: 0.06, testability: 0.1 },
  "static-analysis": { impact: 0.21, confidence: 0.28, effort: 0.14, risk: 0.06, evidenceStrength: 0.12, estimatedDiff: 0.05, subsystemRisk: 0.06, testability: 0.08 },
  "mutation-testing": { impact: 0.21, confidence: 0.245, effort: 0.175, risk: 0.06, evidenceStrength: 0.12, estimatedDiff: 0.05, subsystemRisk: 0.06, testability: 0.08 },
  "property-testing": { impact: 0.245, confidence: 0.245, effort: 0.14, risk: 0.06, evidenceStrength: 0.12, estimatedDiff: 0.05, subsystemRisk: 0.06, testability: 0.08 },
  "dependency-vulnerability": { impact: 0.315, confidence: 0.175, effort: 0.07, risk: 0.12, evidenceStrength: 0.14, estimatedDiff: 0.04, subsystemRisk: 0.08, testability: 0.06 },
  performance: { impact: 0.28, confidence: 0.21, effort: 0.14, risk: 0.06, evidenceStrength: 0.12, estimatedDiff: 0.05, subsystemRisk: 0.07, testability: 0.08 },
  maintainability: { impact: 0.245, confidence: 0.21, effort: 0.14, risk: 0.09, evidenceStrength: 0.12, estimatedDiff: 0.05, subsystemRisk: 0.07, testability: 0.07 },
  documentation: { impact: 0.175, confidence: 0.28, effort: 0.14, risk: 0.09, evidenceStrength: 0.12, estimatedDiff: 0.06, subsystemRisk: 0.06, testability: 0.07 },
} satisfies Readonly<Record<CandidateKind, ScoringWeights>>;

const maximumEstimatedDiffLines = 250;
const cosmeticOnlyMaximumScore = 0.01;
const maximumPriorityInfluence = 0.05;

export function rankCandidates(
  candidates: readonly ImprovementCandidate[],
  priorities: readonly CandidateKind[] = [],
): readonly RankedCandidate[] {
  return deduplicateCandidates(
    rejectCandidatesWithoutReproducibleEvidence(candidates).filter(hasBoundedScoringFactors),
  )
    .map((candidate) => scoreCandidate(candidate, priorities))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function scoreCandidate(candidate: ImprovementCandidate, priorities: readonly CandidateKind[]): RankedCandidate {
  const weights = categoryScoringWeights[candidate.kind];
  const evidenceStrength = candidate.reproducibility?.strength ?? 0;
  const estimatedDiff = candidate.estimatedDiffLines / maximumEstimatedDiffLines;
  const categoryScore =
    candidate.impact * weights.impact +
      candidate.confidence * weights.confidence -
      candidate.effort * weights.effort -
      candidate.risk * weights.risk +
      evidenceStrength * weights.evidenceStrength -
      estimatedDiff * weights.estimatedDiff -
      candidate.subsystemRisk * weights.subsystemRisk +
      candidate.testability * weights.testability;
  const priorityIndex = priorities.indexOf(candidate.kind);
  const priorityInfluence = priorityIndex === -1
    ? 0
    : maximumPriorityInfluence * ((priorities.length - priorityIndex) / priorities.length);
  const weightedScore = round(categoryScore + priorityInfluence);
  return {
    ...candidate,
    score: candidate.valueClassification?.classification === "cosmetic-only"
      ? Math.min(weightedScore, cosmeticOnlyMaximumScore)
      : weightedScore,
  };
}

function hasBoundedScoringFactors(candidate: ImprovementCandidate): boolean {
  return [
    candidate.impact,
    candidate.confidence,
    candidate.effort,
    candidate.risk,
    candidate.subsystemRisk,
    candidate.testability,
  ].every(isUnitInterval)
    && (candidate.valueClassification === undefined || isCandidateValueClassification(candidate.valueClassification))
    && Number.isInteger(candidate.estimatedDiffLines)
    && candidate.estimatedDiffLines > 0
    && candidate.estimatedDiffLines <= maximumEstimatedDiffLines;
}

function isUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
