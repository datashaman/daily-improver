import type { ImprovementSpec, RankedCandidate, RepositoryProfile } from "../domain/model.js";
import { classifyImprovementIntent } from "../domain/improvement-intent.js";
import { assertKnownMutationRequirement } from "../domain/known-mutation-execution-proof.js";

export function createSpec(
  candidate: RankedCandidate,
  profile: RepositoryProfile,
  limits: { maxFiles: number; maxChangedLines: number; maxCostUsd: number },
): ImprovementSpec {
  const verification = ["test", "lint", "static-analysis"] as const;
  const propertyInvariants = candidate.propertyInvariants ?? (candidate.kind === "property-testing"
    ? ["The selected domain invariant holds across a broad generated input space."]
    : []);
  if (propertyInvariants.length > 0) {
    if (!candidate.target) throw new Error("Property-test work requires one evidence-backed selected target.");
    if (!isSafeSelectedTarget(candidate.target) || !candidate.suggestedFiles.includes(candidate.target)) {
      throw new Error("Property-test selected target must be one approved repository-relative file.");
    }
    if (propertyInvariants.length > 64
      || new Set(propertyInvariants).size !== propertyInvariants.length
      || propertyInvariants.some((invariant) => invariant.length === 0 || invariant.length > 4_096 || invariant.trim() !== invariant)) {
      throw new Error("Property-test invariants must be unique bounded approved statements.");
    }
  }
  const acceptanceCriteria = [
    "The targeted improvement is implemented without unrelated changes.",
    "Existing tests remain green and new behavior is protected by tests.",
    "Every available verification capability required by this spec passes.",
  ];
  const knownMutation = candidate.knownMutation
    ? assertKnownMutationRequirement(candidate.knownMutation, propertyInvariants, acceptanceCriteria, candidate.target)
    : undefined;
  return {
    id: `spec-${candidate.id}`,
    improvementIntent: classifyImprovementIntent(candidate.kind, candidate.improvementIntent),
    title: candidate.title,
    objective: candidate.rationale,
    currentBehaviour: "Behavior is inferred from the current main branch and must be characterized before mutation.",
    proposedImprovement: candidate.rationale,
    allowedFiles: candidate.suggestedFiles,
    behavioursToPreserve: ["All behavior outside the approved objective remains unchanged."],
    acceptanceCriteria,
    propertyInvariants,
    ...(propertyInvariants.length > 0 && candidate.target ? { propertyTestTarget: candidate.target } : {}),
    ...(knownMutation ? { knownMutation } : {}),
    exclusions: ["Dependency upgrades", "Database migrations", "Public API changes", "CI configuration changes"],
    verification: verification.filter((kind) => profile.capabilities.has(kind)),
    constraints: limits,
    evidence: candidate.evidence,
  };
}

function isSafeSelectedTarget(target: string): boolean {
  return target.length <= 1_024
    && !target.startsWith("/")
    && !target.includes("\\")
    && !target.split("/").includes("..")
    && target.search(/[?*\[]/) === -1
    && !/^(?:tests?|\.ai)(?:\/|$)/.test(target);
}
