import type { ImprovementCandidate } from "../domain/model.js";

export function deduplicateCandidates(
  candidates: readonly ImprovementCandidate[],
): readonly ImprovementCandidate[] {
  const groups = new Map<string, ImprovementCandidate[]>();
  for (const candidate of candidates) {
    const key = deduplicationKey(candidate);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  return [...groups.values()]
    .map((group) => [...group].sort(compareEvidenceStrength)[0])
    .filter((candidate): candidate is ImprovementCandidate => candidate !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function deduplicationKey(candidate: ImprovementCandidate): string {
  const identity = candidate.deduplication;
  return identity
    ? JSON.stringify([identity.schemaVersion, identity.subsystem, identity.defect])
    : JSON.stringify(["candidate-id/v1", candidate.id]);
}

function compareEvidenceStrength(a: ImprovementCandidate, b: ImprovementCandidate): number {
  return (b.deduplication?.reproducibility ?? 0) - (a.deduplication?.reproducibility ?? 0)
    || b.confidence - a.confidence
    || b.impact - a.impact
    || a.effort - b.effort
    || a.risk - b.risk
    || a.id.localeCompare(b.id)
    || canonicalCandidate(a).localeCompare(canonicalCandidate(b));
}

function canonicalCandidate(candidate: ImprovementCandidate): string {
  return JSON.stringify([
    candidate.title,
    candidate.rationale,
    candidate.target ?? "",
    [...candidate.evidence],
    [...candidate.suggestedFiles],
    [...(candidate.deduplication?.provenance ?? [])],
  ]);
}
