export const capabilityKinds = [
  "install",
  "test",
  "lint",
  "static-analysis",
  "mutation-testing",
  "coverage",
  "complexity",
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

export type CandidateKind =
  | "test-protection"
  | "static-analysis"
  | "mutation-testing"
  | "property-testing"
  | "dependency-vulnerability"
  | "maintainability"
  | "documentation";

export interface ImprovementCandidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly title: string;
  readonly rationale: string;
  readonly confidence: number;
  readonly impact: number;
  readonly effort: number;
  readonly risk: number;
  readonly evidence: readonly string[];
  readonly suggestedFiles: readonly string[];
  readonly target?: string;
  readonly estimatedDiffLines?: number;
  readonly propertyInvariants?: readonly string[];
}

export interface RankedCandidate extends ImprovementCandidate {
  readonly score: number;
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

export interface ImprovementRun {
  readonly id: string;
  readonly repository: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: RunStatus;
  readonly adapter: string;
  readonly candidate?: RankedCandidate;
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
