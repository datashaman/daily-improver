import type {
  CandidateKind,
  CandidateExclusion,
  HumanTaskRecommendation,
  ImprovementCandidate,
  RankedCandidate,
} from "../domain/model.js";
import { excludeCandidate, sortCandidateExclusions } from "./candidate-exclusion.js";
import { rankCandidatesWithExclusions } from "./ranking.js";
import type { CandidateScoreExplanation } from "../domain/candidate-score.js";

export interface AutonomousScopeLimits {
  readonly maxFiles: number;
  readonly maxChangedLines: number;
}

export interface CandidateSelection {
  readonly candidates: readonly RankedCandidate[];
  readonly scoreExplanations: readonly CandidateScoreExplanation[];
  readonly exclusions: readonly CandidateExclusion[];
  readonly humanTaskRecommendation?: HumanTaskRecommendation;
}

const maximumRecommendationFiles = 100;
const maximumCandidateIdLength = 160;
const maximumCandidateTitleLength = 240;

export function selectCandidatesByScope(
  candidates: readonly ImprovementCandidate[],
  priorities: readonly CandidateKind[],
  limits: AutonomousScopeLimits,
): CandidateSelection {
  const boundedScope = candidates.filter(hasBoundedScope);
  const ranking = rankCandidatesWithExclusions(boundedScope, priorities);
  const ranked = ranking.candidates;
  const autonomous = ranked.filter((candidate) => fits(candidate, limits));
  const oversized = ranked.find((candidate) => !fits(candidate, limits));

  return {
    candidates: autonomous,
    scoreExplanations: ranking.explanations,
    exclusions: sortCandidateExclusions([
      ...candidates.filter((candidate) => !hasBoundedScope(candidate))
        .map((candidate) => excludeCandidate(candidate, "malformed-scope")),
      ...ranking.exclusions,
      ...ranked.filter((candidate) => !fits(candidate, limits))
        .map((candidate) => excludeCandidate(candidate, "oversized-scope")),
    ]),
    ...(oversized === undefined ? {} : { humanTaskRecommendation: recommendation(oversized, limits) }),
  };
}

function hasBoundedScope(candidate: ImprovementCandidate): boolean {
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && candidate.id.length <= maximumCandidateIdLength
    && typeof candidate.title === "string"
    && candidate.title.length > 0
    && candidate.title.length <= maximumCandidateTitleLength
    && Array.isArray(candidate.suggestedFiles)
    && candidate.suggestedFiles.length <= maximumRecommendationFiles
    && candidate.suggestedFiles.every((path) => typeof path === "string" && path.length > 0 && path.length <= 240);
}

function estimatedFiles(candidate: RankedCandidate): number {
  return Math.max(1, new Set(candidate.suggestedFiles).size);
}

function fits(candidate: RankedCandidate, limits: AutonomousScopeLimits): boolean {
  return estimatedFiles(candidate) <= limits.maxFiles
    && candidate.estimatedDiffLines <= limits.maxChangedLines;
}

function recommendation(
  candidate: RankedCandidate,
  limits: AutonomousScopeLimits,
): HumanTaskRecommendation {
  const files = estimatedFiles(candidate);
  const exceeded = [
    ...(files > limits.maxFiles ? [`${files} estimated files exceed the ${limits.maxFiles}-file autonomous limit`] : []),
    ...(candidate.estimatedDiffLines > limits.maxChangedLines
      ? [`${candidate.estimatedDiffLines} estimated changed lines exceed the ${limits.maxChangedLines}-line autonomous limit`]
      : []),
  ];
  return {
    schemaVersion: "human-task-recommendation/v1",
    candidateId: candidate.id,
    candidateKind: candidate.kind,
    title: candidate.title,
    reason: `Route this credible candidate to human review because ${exceeded.join(" and ")}.`,
    estimatedScope: { files, changedLines: candidate.estimatedDiffLines },
    autonomousLimits: { maxFiles: limits.maxFiles, maxChangedLines: limits.maxChangedLines },
  };
}
