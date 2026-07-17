import { createHash } from "node:crypto";
import {
  candidateKinds,
  type CandidateExclusion,
  type CandidateExclusionReason,
  type ImprovementCandidate,
} from "../domain/model.js";

const maximumCandidateReferenceLength = 160;

export function excludeCandidate(
  candidate: ImprovementCandidate,
  reason: CandidateExclusionReason,
  retainedCandidate?: ImprovementCandidate,
  findingId?: string,
): CandidateExclusion {
  const candidateKind = candidateKinds.find((kind) => kind === candidate.kind);
  return {
    schemaVersion: "candidate-exclusion/v2",
    candidateReference: candidateReference(candidate),
    ...(candidateKind === undefined ? {} : { candidateKind }),
    reason,
    ...(retainedCandidate === undefined
      ? {}
      : { retainedCandidateReference: candidateReference(retainedCandidate) }),
    ...(findingId === undefined ? {} : { findingId }),
  };
}

export function sortCandidateExclusions(
  exclusions: readonly CandidateExclusion[],
): readonly CandidateExclusion[] {
  return [...exclusions].sort((a, b) =>
    a.candidateReference.localeCompare(b.candidateReference)
      || a.reason.localeCompare(b.reason)
      || (a.retainedCandidateReference ?? "").localeCompare(b.retainedCandidateReference ?? "")
      || (a.findingId ?? "").localeCompare(b.findingId ?? "")
      || (a.candidateKind ?? "").localeCompare(b.candidateKind ?? ""));
}

function candidateReference(candidate: ImprovementCandidate): string {
  if (typeof candidate.id === "string"
    && candidate.id.length > 0
    && candidate.id.length <= maximumCandidateReferenceLength) return candidate.id;
  const unsafeId = typeof candidate.id === "string" ? candidate.id : typeof candidate.id;
  return `sha256:${createHash("sha256").update(unsafeId).digest("hex")}`;
}
