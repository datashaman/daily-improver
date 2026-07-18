import { createHash } from "node:crypto";

export const targetedMutationPlanSchemaVersion = "targeted-mutation-plan/v1" as const;
export const targetedMutationResultSchemaVersion = "targeted-mutation-result/v1" as const;

const maximumTargets = 64;
const maximumCommandParts = 64;
const maximumCommandPartLength = 4_096;
const maximumTimeoutMs = 30 * 60_000;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*[\u0000-\u001f\u007f])[^*?\[\]]{1,1024}$/u;

export interface TargetedMutationPlan {
  readonly schemaVersion: typeof targetedMutationPlanSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly mode: "targeted";
  readonly targets: readonly string[];
  readonly command: readonly string[];
  readonly timeoutMs: number;
  readonly reportArtifact: string;
}

export interface TargetedMutationExecution {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TargetedMutationResult {
  readonly schemaVersion: typeof targetedMutationResultSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly mode: "targeted";
  readonly targets: readonly string[];
  readonly outcome: "completed";
  readonly mutants: {
    readonly total: number;
    readonly killed: number;
    readonly escaped: number;
    readonly notCovered: number;
  };
  readonly durationMs: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly reportSha256: string;
}

export function assertTargetedMutationPlan(value: unknown, expectedTargets: readonly string[]): TargetedMutationPlan {
  const plan = exactRecord(value, ["adapter", "command", "mode", "reportArtifact", "schemaVersion", "targets", "timeoutMs", "tool"], "Targeted mutation plan");
  if (plan.schemaVersion !== targetedMutationPlanSchemaVersion || plan.mode !== "targeted") throw new Error("Targeted mutation plan uses an unsupported schema or mode.");
  const adapter = boundedIdentity(plan.adapter, "adapter");
  const tool = boundedIdentity(plan.tool, "tool");
  const targets = exactTargets(plan.targets, "plan targets");
  const expected = exactTargets(expectedTargets, "expected targets");
  if (JSON.stringify(targets) !== JSON.stringify(expected)) throw new Error("Targeted mutation plan is untargeted.");
  if (!Array.isArray(plan.command) || plan.command.length < 1 || plan.command.length > maximumCommandParts) throw new Error("Targeted mutation command is missing or excessive.");
  const command = plan.command.map((part) => {
    if (typeof part !== "string" || !part || part.length > maximumCommandPartLength || part.includes("\0")) throw new Error("Targeted mutation command is malformed.");
    return part;
  });
  if (!Number.isInteger(plan.timeoutMs) || (plan.timeoutMs as number) < 1_000 || (plan.timeoutMs as number) > maximumTimeoutMs) throw new Error("Targeted mutation timeout is malformed or excessive.");
  const reportArtifact = repositoryPath(plan.reportArtifact, "report artifact");
  return Object.freeze({
    schemaVersion: targetedMutationPlanSchemaVersion,
    adapter,
    tool,
    mode: "targeted",
    targets: Object.freeze(targets),
    command: Object.freeze(command),
    timeoutMs: plan.timeoutMs as number,
    reportArtifact,
  });
}

export function assertTargetedMutationResult(value: unknown, plan: TargetedMutationPlan): TargetedMutationResult {
  const result = exactRecord(value, ["adapter", "durationMs", "mode", "mutants", "outcome", "reportSha256", "schemaVersion", "stderrSha256", "stdoutSha256", "targets", "tool"], "Targeted mutation result");
  if (result.schemaVersion !== targetedMutationResultSchemaVersion || result.mode !== "targeted" || result.outcome !== "completed") {
    throw new Error("Targeted mutation result uses an unsupported schema, mode, or outcome.");
  }
  if (result.adapter !== plan.adapter || result.tool !== plan.tool) throw new Error("Targeted mutation result identifies the wrong adapter or tool.");
  const targets = exactTargets(result.targets, "result targets");
  if (JSON.stringify(targets) !== JSON.stringify(plan.targets)) throw new Error("Targeted mutation result is untargeted.");
  const mutants = exactRecord(result.mutants, ["escaped", "killed", "notCovered", "total"], "Targeted mutation counts");
  const total = boundedCount(mutants.total, "total");
  const killed = boundedCount(mutants.killed, "killed");
  const escaped = boundedCount(mutants.escaped, "escaped");
  const notCovered = boundedCount(mutants.notCovered, "not-covered");
  if (killed + escaped + notCovered > total) throw new Error("Targeted mutation counts are inconsistent.");
  if (!Number.isInteger(result.durationMs) || (result.durationMs as number) < 0 || (result.durationMs as number) > plan.timeoutMs) throw new Error("Targeted mutation duration is malformed or excessive.");
  const stdoutSha256 = hash(result.stdoutSha256, "stdout");
  const stderrSha256 = hash(result.stderrSha256, "stderr");
  const reportSha256 = hash(result.reportSha256, "report");
  return Object.freeze({
    schemaVersion: targetedMutationResultSchemaVersion,
    adapter: plan.adapter,
    tool: plan.tool,
    mode: "targeted",
    targets: Object.freeze(targets),
    outcome: "completed",
    mutants: Object.freeze({ total, killed, escaped, notCovered }),
    durationMs: result.durationMs as number,
    stdoutSha256,
    stderrSha256,
    reportSha256,
  });
}

export function targetedMutationOutputHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactTargets(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumTargets) throw new Error(`Targeted mutation ${name} are missing or excessive.`);
  const targets = value.map((path) => repositoryPath(path, name)).sort();
  if (new Set(targets).size !== targets.length) throw new Error(`Targeted mutation ${name} contain duplicates.`);
  return targets;
}

function repositoryPath(value: unknown, name: string): string {
  if (typeof value !== "string" || !safePath.test(value) || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Targeted mutation ${name} is malformed or escaped.`);
  }
  return value;
}

function boundedIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error(`Targeted mutation ${name} is malformed.`);
  return value;
}

function boundedCount(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100_000) throw new Error(`Targeted mutation ${name} count is malformed or excessive.`);
  return value as number;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Targeted mutation ${name} identity is malformed.`);
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${name} is extended or incomplete.`);
  return record;
}
