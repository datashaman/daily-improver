import { candidateKinds, type CandidateExclusion, type CandidateKind, type ImprovementCandidate, type RankedCandidate } from "../domain/model.js";
import {
  assertScoreExplanations,
  candidateScoreCategoryWeights,
  candidateScoreExplanationSchemaVersion,
  type CandidateScoreExplanation,
  type CandidateScoreFactors,
} from "../domain/candidate-score.js";
import { isCandidateValueClassification } from "../domain/candidate-value.js";
import { deduplicateCandidatesWithDuplicates } from "./candidate-deduplication.js";
import { excludeCandidate, sortCandidateExclusions } from "./candidate-exclusion.js";
import { hasReproducibleEvidence } from "./candidate-reproducibility.js";

const maximumEstimatedDiffLines = 10_000;
const scoringDiffLineReference = 250;
const cosmeticOnlyMaximumScore = 0.01;
const maximumPriorityInfluence = 0.05;

export function rankCandidates(
  candidates: readonly ImprovementCandidate[],
  priorities: readonly CandidateKind[] = [],
): readonly RankedCandidate[] {
  return rankCandidatesWithExclusions(candidates, priorities).candidates;
}

export function rankCandidatesWithExclusions(
  candidates: readonly ImprovementCandidate[],
  priorities: readonly CandidateKind[] = [],
): {
  readonly candidates: readonly RankedCandidate[];
  readonly explanations: readonly CandidateScoreExplanation[];
  readonly exclusions: readonly CandidateExclusion[];
} {
  const evidenceAccepted = candidates.filter(hasReproducibleEvidence);
  const scoringAccepted = evidenceAccepted.filter(hasBoundedScoringFactors);
  const deduplicated = deduplicateCandidatesWithDuplicates(scoringAccepted);
  const scored = deduplicated.candidates
    .map((candidate) => scoreCandidate(candidate, priorities))
    .sort((a, b) => b.candidate.score - a.candidate.score || a.candidate.id.localeCompare(b.candidate.id));
  const ranked = scored.map(({ candidate }) => candidate);
  const explanations = scored.map(({ explanation }) => explanation);
  assertScoreExplanations(ranked, explanations, priorities);
  return {
    candidates: ranked,
    explanations,
    exclusions: sortCandidateExclusions([
      ...candidates.filter((candidate) => !hasReproducibleEvidence(candidate))
        .map((candidate) => excludeCandidate(candidate, "evidence")),
      ...evidenceAccepted.filter((candidate) => !hasBoundedScoringFactors(candidate))
        .map((candidate) => excludeCandidate(candidate, "scoring")),
      ...deduplicated.duplicates.map(({ candidate, retainedCandidate }) =>
        excludeCandidate(candidate, "semantic-deduplication", retainedCandidate)),
    ]),
  };
}

function scoreCandidate(
  candidate: ImprovementCandidate,
  priorities: readonly CandidateKind[],
): { readonly candidate: RankedCandidate; readonly explanation: CandidateScoreExplanation } {
  const categoryWeights = candidateScoreCategoryWeights[candidate.kind];
  const normalizedFactors: CandidateScoreFactors = {
    evidenceStrength: candidate.reproducibility?.strength ?? 0,
    confidence: candidate.confidence,
    impact: candidate.impact,
    effort: candidate.effort,
    estimatedDiff: Math.min(candidate.estimatedDiffLines / scoringDiffLineReference, 1),
    changeRisk: candidate.risk,
    subsystemRisk: candidate.subsystemRisk,
    testability: candidate.testability,
  };
  const rawWeightedContribution = Object.keys(normalizedFactors).reduce(
    (total, factor) => total + normalizedFactors[factor as keyof CandidateScoreFactors]
      * categoryWeights[factor as keyof CandidateScoreFactors],
    0,
  );
  const priorityIndex = priorities.indexOf(candidate.kind);
  const priorityInfluence = priorityIndex === -1
    ? 0
    : maximumPriorityInfluence * ((priorities.length - priorityIndex) / priorities.length);
  const weightedScore = round(rawWeightedContribution + priorityInfluence);
  const valueClassificationCap = candidate.valueClassification?.classification === "cosmetic-only"
    ? cosmeticOnlyMaximumScore
    : null;
  const score = valueClassificationCap === null ? weightedScore : Math.min(weightedScore, valueClassificationCap);
  return { candidate: {
    ...candidate,
    score,
  }, explanation: {
    schemaVersion: candidateScoreExplanationSchemaVersion,
    candidateReference: candidate.id,
    candidateKind: candidate.kind,
    normalizedFactors,
    categoryWeights,
    rawWeightedContribution,
    repositoryPriorityInfluence: priorityInfluence,
    valueClassificationCap,
    finalRoundedScore: score,
  } };
}

function hasBoundedScoringFactors(candidate: ImprovementCandidate): boolean {
  return candidateKinds.some((kind) => kind === candidate.kind)
    && [
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
