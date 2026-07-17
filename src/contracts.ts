import type {
  CapabilityKind,
  ImprovementCandidate,
  ImprovementRun,
  ImprovementSpec,
  PolicyDecision,
  RepositoryProfile,
} from "./domain/model.js";

export interface RepositoryAdapter {
  readonly id: string;
  detect(root: string): Promise<number>;
  profile(root: string): Promise<RepositoryProfile>;
  discoverCandidates(profile: RepositoryProfile): Promise<readonly ImprovementCandidate[]>;
  classifyFailure?(output: string): string;
}

export interface RunStore {
  save(run: ImprovementRun): Promise<void>;
  list(repository: string): Promise<readonly ImprovementRun[]>;
}

export interface Policy {
  readonly id: string;
  evaluate(spec: ImprovementSpec, context: PolicyContext): PolicyDecision;
}

export interface PolicyContext {
  readonly estimatedFiles: number;
  readonly estimatedChangedLines: number;
  readonly estimatedCostUsd: number;
  readonly availableCapabilities: ReadonlySet<CapabilityKind>;
}

export interface Clock {
  now(): Date;
}
