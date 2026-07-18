import type {
  CapabilityKind,
  ImprovementCandidate,
  DailyImprovementDecision,
  ImprovementRun,
  ImprovementSpec,
  OpenPullRequestState,
  UnresolvedFindingState,
  PolicyDecision,
  RepositoryProfile,
} from "./domain/model.js";
import type { GeneratedTestLifecycleDecision } from "./domain/generated-test-lifecycle.js";
import type { PropertyTestExecutionProof } from "./domain/property-test-execution-proof.js";
import type {
  TargetedMutationExecution,
  TargetedMutationPlan,
  TargetedMutationResult,
} from "./domain/targeted-mutation.js";

export interface GeneratedTestQualityInspectionRequest {
  readonly root: string;
  readonly framework: string | undefined;
  readonly propertyFramework?: string;
  readonly selectedTestPath: string;
  readonly observedTestPaths: readonly string[];
  readonly baselineLifecycle: GeneratedTestLifecycleDecision;
  readonly propertyProof?: PropertyTestExecutionProof;
}

export interface AdapterGeneratedTestQualityInspection {
  readonly schemaVersion: string;
  readonly adapter: string;
  readonly framework: string;
  readonly selectedTestPath: string;
  readonly outcome: "accepted" | "rejected";
}

export interface RepositoryAdapter {
  readonly id: string;
  detect(root: string): Promise<number>;
  profile(root: string): Promise<RepositoryProfile>;
  discoverCandidates(profile: RepositoryProfile): Promise<readonly ImprovementCandidate[]>;
  classifyFailure?(output: string): string;
  inspectGeneratedTestQuality?(request: GeneratedTestQualityInspectionRequest): Promise<AdapterGeneratedTestQualityInspection | undefined>;
  prepareTargetedMutation?(root: string, targets: readonly string[]): Promise<TargetedMutationPlan>;
  inspectTargetedMutation?(root: string, plan: TargetedMutationPlan, execution: TargetedMutationExecution): Promise<TargetedMutationResult>;
}

export interface RunStore {
  save(run: ImprovementRun): Promise<void>;
  list(repository: string): Promise<readonly ImprovementRun[]>;
}

export interface DailyImprovementStore {
  claim(repository: string, utcDate: string, decidedAt: string): Promise<DailyImprovementDecision>;
  complete(decision: DailyImprovementDecision, decidedAt: string): Promise<DailyImprovementDecision>;
  release(decision: DailyImprovementDecision, decidedAt: string): Promise<DailyImprovementDecision>;
}

export interface OpenPullRequestStateSource {
  current(decidedAt: string): Promise<OpenPullRequestState>;
}

export interface UnresolvedFindingStateSource {
  current(decidedAt: string): Promise<UnresolvedFindingState>;
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
  | "missing-packages"
  | "missing-coverage-support"
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
  readonly provenance: EvidenceProvenanceRequest;
  readonly classify: (output: EvidenceCommandOutput) => EvidenceResultStatus;
}

export interface EvidenceProvenanceRequest {
  readonly versionCommand: readonly string[];
  readonly configurationRoot?: string;
  readonly configurationPaths: readonly string[];
  readonly maxConfigurationFileBytes: number;
}

export type EvidenceConfigurationFileStatus = "hashed" | "absent" | "unreadable" | "oversized";

export interface EvidenceConfigurationFile {
  readonly path: string;
  readonly status: EvidenceConfigurationFileStatus;
  readonly bytes: number | null;
  readonly sha256: string | null;
}

export type EvidenceProvenanceStatus =
  | "success"
  | "unavailable-version-command"
  | "version-command-failure"
  | "malformed-version"
  | "configuration-hash-failure";

export interface EvidenceProvenance {
  readonly status: EvidenceProvenanceStatus;
  readonly versionCommand: readonly string[];
  readonly toolVersion: string | null;
  readonly configurationHash: string | null;
  readonly configurationFiles: readonly EvidenceConfigurationFile[];
  readonly maxConfigurationFileBytes: number;
}

export const evidenceResultSchemaVersion = "evidence-command-result/v2" as const;

export interface EvidenceResult {
  readonly schemaVersion: typeof evidenceResultSchemaVersion;
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
  readonly provenance: EvidenceProvenance;
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
