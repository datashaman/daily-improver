import type { ImprovementSpec, RankedCandidate, RepositoryProfile } from "../domain/model.js";
import { classifyImprovementIntent } from "../domain/improvement-intent.js";

export function createSpec(
  candidate: RankedCandidate,
  profile: RepositoryProfile,
  limits: { maxFiles: number; maxChangedLines: number; maxCostUsd: number },
): ImprovementSpec {
  const verification = ["test", "lint", "static-analysis"] as const;
  return {
    id: `spec-${candidate.id}`,
    improvementIntent: classifyImprovementIntent(candidate.kind, candidate.improvementIntent),
    title: candidate.title,
    objective: candidate.rationale,
    currentBehaviour: "Behavior is inferred from the current main branch and must be characterized before mutation.",
    proposedImprovement: candidate.rationale,
    allowedFiles: candidate.suggestedFiles,
    behavioursToPreserve: ["All behavior outside the approved objective remains unchanged."],
    acceptanceCriteria: [
      "The targeted improvement is implemented without unrelated changes.",
      "Existing tests remain green and new behavior is protected by tests.",
      "Every available verification capability required by this spec passes.",
    ],
    propertyInvariants: candidate.propertyInvariants ?? (candidate.kind === "property-testing"
      ? ["The selected domain invariant holds across a broad generated input space."]
      : []),
    exclusions: ["Dependency upgrades", "Database migrations", "Public API changes", "CI configuration changes"],
    verification: verification.filter((kind) => profile.capabilities.has(kind)),
    constraints: limits,
    evidence: candidate.evidence,
  };
}
