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

export type EvidenceResultStatus =
  | "success"
  | "code-finding"
  | "unavailable-tool"
  | "configuration-failure"
  | "timeout"
  | "infrastructure-failure";

export interface EvidenceCommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export interface EvidenceCommand {
  readonly identity: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly classify: (output: EvidenceCommandOutput) => EvidenceResultStatus;
}

export interface EvidenceResult {
  readonly commandIdentity: string;
  readonly command: readonly string[];
  readonly status: EvidenceResultStatus;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly stdoutHash: string;
  readonly stderrHash: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly outputLimitBytes: number;
  readonly outputTruncated: boolean;
}

export interface EvidenceRun {
  /** Safe to persist: contains bounded metadata and hashes, but no raw tool output. */
  readonly result: EvidenceResult;
  /** Transient adapter input. Each stream is capped by the command output limit. */
  readonly output: {
    readonly stdout: string;
    readonly stderr: string;
  };
}

export interface EvidenceRunner {
  run(command: EvidenceCommand): Promise<EvidenceRun>;
}
