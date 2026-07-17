import type { CandidateValueClassification } from "./candidate-value.js";

export const capabilityKinds = [
  "install",
  "test",
  "lint",
  "static-analysis",
  "mutation-testing",
  "coverage",
  "complexity",
  "duplicate-code",
  "deprecation-analysis",
  "property-testing",
  "format",
] as const;

export type CapabilityKind = (typeof capabilityKinds)[number];

export interface CommandCapability {
  readonly kind: CapabilityKind;
  readonly command: readonly string[];
  readonly framework?: string;
  readonly source: "manifest" | "convention" | "configuration";
}

export interface RepositoryProfile {
  readonly root: string;
  readonly adapter: string;
  readonly language: string;
  readonly frameworks: readonly string[];
  readonly signals: readonly string[];
  readonly capabilities: ReadonlyMap<CapabilityKind, CommandCapability>;
}

export const candidateKinds = [
  "test-protection",
  "static-analysis",
  "mutation-testing",
  "property-testing",
  "dependency-vulnerability",
  "performance",
  "maintainability",
  "documentation",
] as const;

export type CandidateKind = (typeof candidateKinds)[number];

export interface CandidateDeduplication {
  readonly schemaVersion: "candidate-deduplication/v1";
  readonly subsystem: string;
  readonly defect: string;
}

export interface CandidateReproducibility {
  readonly schemaVersion: "candidate-reproducibility/v1";
  readonly reproducible: boolean;
  readonly strength: number;
  readonly provenance: readonly string[];
}

export interface ImprovementCandidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly title: string;
  readonly rationale: string;
  readonly confidence: number;
  readonly impact: number;
  readonly effort: number;
  readonly risk: number;
  readonly subsystemRisk: number;
  readonly testability: number;
  readonly evidence: readonly string[];
  readonly suggestedFiles: readonly string[];
  readonly target?: string;
  readonly estimatedDiffLines: number;
  readonly propertyInvariants?: readonly string[];
  readonly reproducibility?: CandidateReproducibility;
  readonly deduplication?: CandidateDeduplication;
  readonly valueClassification?: CandidateValueClassification;
}

export interface RankedCandidate extends ImprovementCandidate {
  readonly score: number;
}

export const candidateExclusionReasons = [
  "malformed-scope",
  "evidence",
  "scoring",
  "semantic-deduplication",
  "oversized-scope",
] as const;

export type CandidateExclusionReason = (typeof candidateExclusionReasons)[number];

export interface CandidateExclusion {
  readonly schemaVersion: "candidate-exclusion/v1";
  readonly candidateReference: string;
  readonly candidateKind?: CandidateKind;
  readonly reason: CandidateExclusionReason;
  readonly retainedCandidateReference?: string;
}

export interface HumanTaskRecommendation {
  readonly schemaVersion: "human-task-recommendation/v1";
  readonly candidateId: string;
  readonly candidateKind: CandidateKind;
  readonly title: string;
  readonly reason: string;
  readonly estimatedScope: {
    readonly files: number;
    readonly changedLines: number;
  };
  readonly autonomousLimits: {
    readonly maxFiles: number;
    readonly maxChangedLines: number;
  };
}

export interface ImprovementSpec {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly currentBehaviour: string;
  readonly proposedImprovement: string;
  readonly allowedFiles: readonly string[];
  readonly behavioursToPreserve: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly propertyInvariants: readonly string[];
  readonly exclusions: readonly string[];
  readonly verification: readonly CapabilityKind[];
  readonly constraints: {
    readonly maxFiles: number;
    readonly maxChangedLines: number;
    readonly maxCostUsd: number;
  };
  readonly evidence: readonly string[];
}

export type RunStatus = "planned" | "rejected" | "completed" | "failed";

export type DailyImprovementDecisionOutcome =
  | "claimed"
  | "blocked-active"
  | "blocked-completed"
  | "released"
  | "completed";

export interface DailyImprovementDecision {
  readonly schemaVersion: "daily-improvement-decision/v1";
  readonly repositoryId: string;
  readonly utcDate: string;
  readonly claimId: string;
  readonly outcome: DailyImprovementDecisionOutcome;
  readonly decidedAt: string;
}

export interface ImprovementRun {
  readonly id: string;
  readonly repository: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: RunStatus;
  readonly adapter: string;
  readonly candidate?: RankedCandidate;
  readonly candidateExclusions: readonly CandidateExclusion[];
  readonly humanTaskRecommendation?: HumanTaskRecommendation;
  readonly dailyImprovementDecision?: DailyImprovementDecision;
  readonly spec?: ImprovementSpec;
  readonly policyDecisions: readonly PolicyDecision[];
}

export interface RunOutcome {
  readonly runId: string;
  readonly outcome: "merged" | "closed" | "reverted";
  readonly reviewChangesRequested: number;
  readonly candidateType: CandidateKind;
  readonly filesChanged: number;
  readonly diffLines: number;
  readonly recordedAt: string;
}

export interface PolicyDecision {
  readonly policy: string;
  readonly allowed: boolean;
  readonly reason: string;
}
