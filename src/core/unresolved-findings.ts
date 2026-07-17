import { createHash } from "node:crypto";
import type { CandidateSelection } from "./candidate-scope.js";
import type { ImprovementCandidate, UnresolvedFindingState } from "../domain/model.js";
import { excludeCandidate, sortCandidateExclusions } from "./candidate-exclusion.js";

export function candidateFindingId(candidate: ImprovementCandidate): string {
  const identity = candidate.deduplication === undefined
    ? ["candidate-id/v1", candidate.kind, candidate.id]
    : [
        candidate.deduplication.schemaVersion,
        candidate.kind,
        candidate.deduplication.subsystem,
        candidate.deduplication.defect,
      ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function excludeUnresolvedFindings(
  selection: CandidateSelection,
  state: UnresolvedFindingState,
): CandidateSelection {
  const unresolved = new Set(state.findingIds);
  const matches = selection.candidates.filter((candidate) => unresolved.has(candidateFindingId(candidate)));
  return {
    ...selection,
    candidates: selection.candidates.filter((candidate) => !unresolved.has(candidateFindingId(candidate))),
    exclusions: sortCandidateExclusions([
      ...selection.exclusions,
      ...matches.map((candidate) => excludeCandidate(
        candidate,
        "unresolved-finding",
        undefined,
        candidateFindingId(candidate),
      )),
    ]),
  };
}
