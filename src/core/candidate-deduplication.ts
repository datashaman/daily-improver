import type { ImprovementCandidate } from "../domain/model.js";

export interface CandidateDeduplicationResult {
  readonly candidates: readonly ImprovementCandidate[];
  readonly duplicates: readonly {
    readonly candidate: ImprovementCandidate;
    readonly retainedCandidate: ImprovementCandidate;
  }[];
}

export function deduplicateCandidates(
  candidates: readonly ImprovementCandidate[],
): readonly ImprovementCandidate[] {
  return deduplicateCandidatesWithDuplicates(candidates).candidates;
}

export function deduplicateCandidatesWithDuplicates(
  candidates: readonly ImprovementCandidate[],
): CandidateDeduplicationResult {
  const groups = new Map<string, ImprovementCandidate[]>();
  for (const candidate of candidates) {
    const key = deduplicationKey(candidate);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  const retained: ImprovementCandidate[] = [];
  const duplicates: { candidate: ImprovementCandidate; retainedCandidate: ImprovementCandidate }[] = [];
  for (const group of groups.values()) {
    const [retainedCandidate, ...rejected] = [...group].sort(compareEvidenceStrength);
    if (retainedCandidate === undefined) continue;
    retained.push(retainedCandidate);
    duplicates.push(...rejected.map((candidate) => ({ candidate, retainedCandidate })));
  }
  return {
    candidates: retained.sort((a, b) => a.id.localeCompare(b.id)),
    duplicates,
  };
}

function deduplicationKey(candidate: ImprovementCandidate): string {
  const identity = candidate.deduplication;
  return identity
    ? JSON.stringify([identity.schemaVersion, identity.subsystem, identity.defect])
    : JSON.stringify(["candidate-id/v1", candidate.id]);
}

function compareEvidenceStrength(a: ImprovementCandidate, b: ImprovementCandidate): number {
  return (b.reproducibility?.strength ?? 0) - (a.reproducibility?.strength ?? 0)
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
    [...(candidate.reproducibility?.provenance ?? [])],
  ]);
}
