import type { ImprovementCandidate } from "../domain/model.js";

const maxEvidenceEntries = 16;
const maxEvidenceEntryLength = 1_024;
const maxProvenanceEntries = 8;
const maxProvenanceEntryLength = 512;

export function hasReproducibleEvidence(candidate: ImprovementCandidate): boolean {
  const contract = candidate.reproducibility;
  return boundedStrings(candidate.evidence, maxEvidenceEntries, maxEvidenceEntryLength)
    && contract?.schemaVersion === "candidate-reproducibility/v1"
    && contract.reproducible
    && Number.isFinite(contract.strength)
    && contract.strength > 0
    && contract.strength <= 1
    && boundedStrings(contract.provenance, maxProvenanceEntries, maxProvenanceEntryLength);
}

export function rejectCandidatesWithoutReproducibleEvidence(
  candidates: readonly ImprovementCandidate[],
): readonly ImprovementCandidate[] {
  return candidates.filter(hasReproducibleEvidence);
}

function boundedStrings(values: unknown, maxEntries: number, maxLength: number): boolean {
  return Array.isArray(values)
    && values.length > 0
    && values.length <= maxEntries
    && values.every((value) => typeof value === "string"
      && value.length > 0
      && value.length <= maxLength
      && value.trim() === value);
}
