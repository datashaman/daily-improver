import { createHash } from "node:crypto";

export const staticAnalysisPlanSchemaVersion = "static-analysis-plan/v1" as const;
export const staticAnalysisResultSchemaVersion = "static-analysis-result/v1" as const;
export const staticAnalysisFindingsComparisonSchemaVersion = "static-analysis-findings-comparison/v1" as const;

const maximumFindings = 10_000;
const maximumCommandParts = 64;

export interface StaticAnalysisPlan {
  readonly schemaVersion: typeof staticAnalysisPlanSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly configurationSha256: string;
  readonly targetScope: "repository-configured";
  readonly command: readonly string[];
  readonly timeoutMs: number;
}

export interface StaticAnalysisExecution {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly resourceExhausted?: string;
}

export interface StaticAnalysisResult {
  readonly schemaVersion: typeof staticAnalysisResultSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly configurationSha256: string;
  readonly targetScope: "repository-configured";
  readonly outcome: "completed";
  readonly findingIdentitySemantics: string;
  readonly findingIdentities: readonly string[];
  readonly durationMs: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

export interface StaticAnalysisFindingsComparison {
  readonly schemaVersion: typeof staticAnalysisFindingsComparisonSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly configurationSha256: string;
  readonly targetScope: "repository-configured";
  readonly findingIdentitySemantics: string;
  readonly baselineFindingCount: number;
  readonly currentFindingCount: number;
  readonly resolvedFindingCount: number;
  readonly outcome: "clean" | "improved" | "unchanged";
}

export function assertStaticAnalysisPlan(value: unknown): StaticAnalysisPlan {
  const plan = exactRecord(value, ["adapter", "command", "configurationSha256", "schemaVersion", "targetScope", "timeoutMs", "tool"], "Static-analysis plan");
  if (plan.schemaVersion !== staticAnalysisPlanSchemaVersion || plan.targetScope !== "repository-configured") {
    throw new Error("Static-analysis plan uses an unsupported schema or target scope.");
  }
  if (!Array.isArray(plan.command) || plan.command.length < 1 || plan.command.length > maximumCommandParts) {
    throw new Error("Static-analysis command is missing or excessive.");
  }
  const command = plan.command.map((part) => {
    if (typeof part !== "string" || !part || part.length > 4_096 || part.includes("\0")) throw new Error("Static-analysis command is malformed.");
    return part;
  });
  if (!Number.isInteger(plan.timeoutMs) || (plan.timeoutMs as number) < 1_000 || (plan.timeoutMs as number) > 30 * 60_000) {
    throw new Error("Static-analysis timeout is malformed or excessive.");
  }
  return Object.freeze({
    schemaVersion: staticAnalysisPlanSchemaVersion,
    adapter: identity(plan.adapter, "adapter"),
    tool: identity(plan.tool, "tool"),
    configurationSha256: hash(plan.configurationSha256, "configuration"),
    targetScope: "repository-configured",
    command: Object.freeze(command),
    timeoutMs: plan.timeoutMs as number,
  });
}

export function assertStaticAnalysisResult(value: unknown, plan: StaticAnalysisPlan): StaticAnalysisResult {
  const result = exactRecord(value, ["adapter", "configurationSha256", "durationMs", "findingIdentities", "findingIdentitySemantics", "outcome", "schemaVersion", "stderrSha256", "stdoutSha256", "targetScope", "tool"], "Static-analysis result");
  if (result.schemaVersion !== staticAnalysisResultSchemaVersion || result.outcome !== "completed" || result.targetScope !== plan.targetScope) {
    throw new Error("Static-analysis result uses an unsupported schema, outcome, or target scope.");
  }
  if (result.adapter !== plan.adapter || result.tool !== plan.tool || result.configurationSha256 !== plan.configurationSha256) {
    throw new Error("Static-analysis result identifies the wrong adapter, tool, or configuration.");
  }
  if (!Array.isArray(result.findingIdentities) || result.findingIdentities.length > maximumFindings) {
    throw new Error("Static-analysis finding identities are malformed or excessive.");
  }
  const findingIdentities = result.findingIdentities.map((item) => hash(item, "finding")).sort();
  if (new Set(findingIdentities).size !== findingIdentities.length) throw new Error("Static-analysis finding identities contain duplicates.");
  if (!Number.isInteger(result.durationMs) || (result.durationMs as number) < 0 || (result.durationMs as number) > plan.timeoutMs) {
    throw new Error("Static-analysis duration is malformed or excessive.");
  }
  return Object.freeze({
    schemaVersion: staticAnalysisResultSchemaVersion,
    adapter: plan.adapter,
    tool: plan.tool,
    configurationSha256: plan.configurationSha256,
    targetScope: plan.targetScope,
    outcome: "completed",
    findingIdentitySemantics: schemaIdentity(result.findingIdentitySemantics),
    findingIdentities: Object.freeze(findingIdentities),
    durationMs: result.durationMs as number,
    stdoutSha256: hash(result.stdoutSha256, "stdout"),
    stderrSha256: hash(result.stderrSha256, "stderr"),
  });
}

export function compareStaticAnalysisFindings(baselineValue: unknown, currentValue: unknown): StaticAnalysisFindingsComparison {
  const baseline = comparableResult(baselineValue, "baseline");
  const current = comparableResult(currentValue, "current");
  if (baseline.adapter !== current.adapter || baseline.tool !== current.tool
    || baseline.configurationSha256 !== current.configurationSha256 || baseline.targetScope !== current.targetScope) {
    throw new Error("Static-analysis results are incomparable across adapter, tool, configuration, or target scope.");
  }
  if (baseline.findingIdentitySemantics !== current.findingIdentitySemantics) {
    throw new Error("Static-analysis results use incomparable finding-identity semantics.");
  }
  const baselineSet = new Set(baseline.findingIdentities);
  const introduced = current.findingIdentities.filter((item) => !baselineSet.has(item));
  if (introduced.length > 0) throw new Error("Static-analysis introduced new findings.");
  const resolvedFindingCount = baseline.findingIdentities.length - current.findingIdentities.length;
  return Object.freeze({
    schemaVersion: staticAnalysisFindingsComparisonSchemaVersion,
    adapter: baseline.adapter,
    tool: baseline.tool,
    configurationSha256: baseline.configurationSha256,
    targetScope: baseline.targetScope,
    findingIdentitySemantics: baseline.findingIdentitySemantics,
    baselineFindingCount: baseline.findingIdentities.length,
    currentFindingCount: current.findingIdentities.length,
    resolvedFindingCount,
    outcome: baseline.findingIdentities.length === 0 ? "clean" : resolvedFindingCount > 0 ? "improved" : "unchanged",
  });
}

export function staticAnalysisHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparableResult(value: unknown, label: string): StaticAnalysisResult {
  const record = exactRecord(value, ["adapter", "configurationSha256", "durationMs", "findingIdentities", "findingIdentitySemantics", "outcome", "schemaVersion", "stderrSha256", "stdoutSha256", "targetScope", "tool"], `Static-analysis ${label} result`);
  const plan = assertStaticAnalysisPlan({
    schemaVersion: staticAnalysisPlanSchemaVersion,
    adapter: record.adapter,
    tool: record.tool,
    configurationSha256: record.configurationSha256,
    targetScope: record.targetScope,
    command: ["comparison-only"],
    timeoutMs: 30 * 60_000,
  });
  return assertStaticAnalysisResult(record, plan);
}

function identity(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error(`Static-analysis ${name} is malformed.`);
  return value;
}

function schemaIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/v[1-9][0-9]{0,5}$/u.test(value)) throw new Error("Static-analysis finding-identity semantics are malformed.");
  return value;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Static-analysis ${name} identity is malformed.`);
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
