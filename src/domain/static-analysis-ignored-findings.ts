import { createHash } from "node:crypto";

export const staticAnalysisIgnoredFindingsPlanSchemaVersion = "static-analysis-ignored-findings-plan/v1" as const;
export const staticAnalysisIgnoredFindingsResultSchemaVersion = "static-analysis-ignored-findings-result/v1" as const;
export const staticAnalysisIgnoredFindingsComparisonSchemaVersion = "static-analysis-ignored-findings-comparison/v1" as const;

const maximumIgnoredFindings = 10_000;
const mechanisms = ["inline-directive", "configuration-suppression", "baseline-entry"] as const;
export type StaticAnalysisIgnoreMechanism = typeof mechanisms[number];

export interface StaticAnalysisIgnoredFindingsPlan {
  readonly schemaVersion: typeof staticAnalysisIgnoredFindingsPlanSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly configurationSha256: string;
  readonly targetScope: "repository-configured";
}

export interface StaticAnalysisIgnoredFindingIdentity {
  readonly mechanism: StaticAnalysisIgnoreMechanism;
  readonly identitySha256: string;
}

export interface StaticAnalysisIgnoredFindingsResult {
  readonly schemaVersion: typeof staticAnalysisIgnoredFindingsResultSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly configurationSha256: string;
  readonly targetScope: "repository-configured";
  readonly ignoredFindingIdentitySemantics: string;
  readonly ignoredFindings: readonly StaticAnalysisIgnoredFindingIdentity[];
  readonly inventorySha256: string;
}

export interface StaticAnalysisIgnoredFindingsComparison {
  readonly schemaVersion: typeof staticAnalysisIgnoredFindingsComparisonSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly configurationSha256: string;
  readonly targetScope: "repository-configured";
  readonly ignoredFindingIdentitySemantics: string;
  readonly baselineIgnoredFindingCount: number;
  readonly currentIgnoredFindingCount: number;
  readonly removedIgnoredFindingCount: number;
  readonly outcome: "clean" | "removed" | "unchanged";
}

export function assertStaticAnalysisIgnoredFindingsPlan(value: unknown): StaticAnalysisIgnoredFindingsPlan {
  const plan = exactRecord(value, ["adapter", "configurationSha256", "schemaVersion", "targetScope", "tool"], "Static-analysis ignored-findings plan");
  if (plan.schemaVersion !== staticAnalysisIgnoredFindingsPlanSchemaVersion || plan.targetScope !== "repository-configured") {
    throw new Error("Static-analysis ignored-findings plan uses an unsupported schema or target scope.");
  }
  return Object.freeze({
    schemaVersion: staticAnalysisIgnoredFindingsPlanSchemaVersion,
    adapter: identity(plan.adapter, "adapter"),
    tool: identity(plan.tool, "tool"),
    configurationSha256: hash(plan.configurationSha256, "configuration"),
    targetScope: "repository-configured",
  });
}

export function assertStaticAnalysisIgnoredFindingsResult(
  value: unknown,
  plan: StaticAnalysisIgnoredFindingsPlan,
): StaticAnalysisIgnoredFindingsResult {
  const result = exactRecord(value, [
    "adapter", "configurationSha256", "ignoredFindingIdentitySemantics", "ignoredFindings", "inventorySha256",
    "schemaVersion", "targetScope", "tool",
  ], "Static-analysis ignored-findings result");
  if (result.schemaVersion !== staticAnalysisIgnoredFindingsResultSchemaVersion || result.targetScope !== plan.targetScope) {
    throw new Error("Static-analysis ignored-findings result uses an unsupported schema or target scope.");
  }
  if (result.adapter !== plan.adapter || result.tool !== plan.tool || result.configurationSha256 !== plan.configurationSha256) {
    throw new Error("Static-analysis ignored-findings result identifies the wrong adapter, tool, or configuration.");
  }
  if (!Array.isArray(result.ignoredFindings) || result.ignoredFindings.length > maximumIgnoredFindings) {
    throw new Error("Static-analysis ignored findings are malformed or excessive.");
  }
  const ignoredFindings = result.ignoredFindings.map((value) => {
    const item = exactRecord(value, ["identitySha256", "mechanism"], "Static-analysis ignored-finding identity");
    if (!mechanisms.includes(item.mechanism as StaticAnalysisIgnoreMechanism)) {
      throw new Error("Static-analysis ignore mechanism is unsupported.");
    }
    return Object.freeze({
      mechanism: item.mechanism as StaticAnalysisIgnoreMechanism,
      identitySha256: hash(item.identitySha256, "ignored-finding"),
    });
  }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  if (new Set(ignoredFindings.map((item) => item.identitySha256)).size !== ignoredFindings.length) {
    throw new Error("Static-analysis ignored-finding identities contain duplicates.");
  }
  const ignoredFindingIdentitySemantics = schemaIdentity(result.ignoredFindingIdentitySemantics);
  const inventorySha256 = hash(result.inventorySha256, "inventory");
  if (inventorySha256 !== staticAnalysisIgnoredFindingHash(JSON.stringify([ignoredFindingIdentitySemantics, ignoredFindings]))) {
    throw new Error("Static-analysis ignored-finding inventory identity is inconsistent.");
  }
  return Object.freeze({
    schemaVersion: staticAnalysisIgnoredFindingsResultSchemaVersion,
    adapter: plan.adapter,
    tool: plan.tool,
    configurationSha256: plan.configurationSha256,
    targetScope: plan.targetScope,
    ignoredFindingIdentitySemantics,
    ignoredFindings: Object.freeze(ignoredFindings),
    inventorySha256,
  });
}

export function compareStaticAnalysisIgnoredFindings(
  baselineValue: unknown,
  currentValue: unknown,
): StaticAnalysisIgnoredFindingsComparison {
  const baseline = comparableResult(baselineValue, "baseline");
  const current = comparableResult(currentValue, "current");
  if (baseline.adapter !== current.adapter || baseline.tool !== current.tool
    || baseline.configurationSha256 !== current.configurationSha256 || baseline.targetScope !== current.targetScope) {
    throw new Error("Static-analysis ignored-findings results are incomparable across adapter, tool, configuration, or target scope.");
  }
  if (baseline.ignoredFindingIdentitySemantics !== current.ignoredFindingIdentitySemantics) {
    throw new Error("Static-analysis ignored-findings results use incomparable identity semantics.");
  }
  const baselineSet = new Set(baseline.ignoredFindings.map((item) => `${item.mechanism}:${item.identitySha256}`));
  const introduced = current.ignoredFindings.filter((item) => !baselineSet.has(`${item.mechanism}:${item.identitySha256}`));
  if (introduced.length > 0) {
    const introducedMechanisms = [...new Set(introduced.map((item) => item.mechanism))].sort().join(", ");
    throw new Error(`Static analysis introduced new ignored findings through: ${introducedMechanisms}.`);
  }
  const removedIgnoredFindingCount = baseline.ignoredFindings.length - current.ignoredFindings.length;
  return Object.freeze({
    schemaVersion: staticAnalysisIgnoredFindingsComparisonSchemaVersion,
    adapter: baseline.adapter,
    tool: baseline.tool,
    configurationSha256: baseline.configurationSha256,
    targetScope: baseline.targetScope,
    ignoredFindingIdentitySemantics: baseline.ignoredFindingIdentitySemantics,
    baselineIgnoredFindingCount: baseline.ignoredFindings.length,
    currentIgnoredFindingCount: current.ignoredFindings.length,
    removedIgnoredFindingCount,
    outcome: baseline.ignoredFindings.length === 0 ? "clean" : removedIgnoredFindingCount > 0 ? "removed" : "unchanged",
  });
}

export function staticAnalysisIgnoredFindingHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparableResult(value: unknown, label: string): StaticAnalysisIgnoredFindingsResult {
  const record = exactRecord(value, [
    "adapter", "configurationSha256", "ignoredFindingIdentitySemantics", "ignoredFindings", "inventorySha256",
    "schemaVersion", "targetScope", "tool",
  ], `Static-analysis ignored-findings ${label} result`);
  const plan = assertStaticAnalysisIgnoredFindingsPlan({
    schemaVersion: staticAnalysisIgnoredFindingsPlanSchemaVersion,
    adapter: record.adapter,
    tool: record.tool,
    configurationSha256: record.configurationSha256,
    targetScope: record.targetScope,
  });
  return assertStaticAnalysisIgnoredFindingsResult(record, plan);
}

function identity(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error(`Static-analysis ignored-findings ${name} is malformed.`);
  return value;
}

function schemaIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/v[1-9][0-9]{0,5}$/u.test(value)) {
    throw new Error("Static-analysis ignored-finding identity semantics are malformed.");
  }
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
