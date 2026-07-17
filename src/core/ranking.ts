import type { ImprovementCandidate, RankedCandidate } from "../domain/model.js";
import { deduplicateCandidates } from "./candidate-deduplication.js";
import { rejectCandidatesWithoutReproducibleEvidence } from "./candidate-reproducibility.js";

export function rankCandidates(
  candidates: readonly ImprovementCandidate[],
): readonly RankedCandidate[] {
  return deduplicateCandidates(rejectCandidatesWithoutReproducibleEvidence(candidates))
    .map((candidate) => ({
      ...candidate,
      score: round(
        candidate.impact * 0.35 +
          candidate.confidence * 0.3 -
          candidate.effort * 0.2 -
          candidate.risk * 0.15,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
