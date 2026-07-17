import type { CandidateKind, ImprovementCandidate, RankedCandidate } from "../domain/model.js";
import { deduplicateCandidates } from "./candidate-deduplication.js";
import { rejectCandidatesWithoutReproducibleEvidence } from "./candidate-reproducibility.js";

interface ScoringWeights {
  readonly impact: number;
  readonly confidence: number;
  readonly effort: number;
  readonly risk: number;
}

const categoryScoringWeights = {
  "test-protection": { impact: 0.4, confidence: 0.3, effort: 0.15, risk: 0.15 },
  "static-analysis": { impact: 0.3, confidence: 0.4, effort: 0.2, risk: 0.1 },
  "mutation-testing": { impact: 0.3, confidence: 0.35, effort: 0.25, risk: 0.1 },
  "property-testing": { impact: 0.35, confidence: 0.35, effort: 0.2, risk: 0.1 },
  "dependency-vulnerability": { impact: 0.45, confidence: 0.25, effort: 0.1, risk: 0.2 },
  performance: { impact: 0.4, confidence: 0.3, effort: 0.2, risk: 0.1 },
  maintainability: { impact: 0.35, confidence: 0.3, effort: 0.2, risk: 0.15 },
  documentation: { impact: 0.25, confidence: 0.4, effort: 0.2, risk: 0.15 },
} satisfies Readonly<Record<CandidateKind, ScoringWeights>>;

export function rankCandidates(
  candidates: readonly ImprovementCandidate[],
): readonly RankedCandidate[] {
  return deduplicateCandidates(rejectCandidatesWithoutReproducibleEvidence(candidates))
    .map((candidate) => scoreCandidate(candidate))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function scoreCandidate(candidate: ImprovementCandidate): RankedCandidate {
  const weights = categoryScoringWeights[candidate.kind];
  return {
    ...candidate,
    score: round(
      candidate.impact * weights.impact +
        candidate.confidence * weights.confidence -
        candidate.effort * weights.effort -
        candidate.risk * weights.risk,
    ),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
