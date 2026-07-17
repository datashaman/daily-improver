import type { CandidateReproducibility } from "./model.js";

export function reproducibleEvidence(
  strength: number,
  provenance: readonly string[],
): CandidateReproducibility {
  return {
    schemaVersion: "candidate-reproducibility/v1",
    reproducible: true,
    strength,
    provenance,
  };
}
