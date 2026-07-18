import { createHash } from "node:crypto";

export const broadExceptionSwallowingPlanSchemaVersion = "broad-exception-swallowing-plan/v1" as const;
export const broadExceptionSwallowingResultSchemaVersion = "broad-exception-swallowing-result/v1" as const;
export const broadExceptionSwallowingComparisonSchemaVersion = "broad-exception-swallowing-comparison/v1" as const;

const maximumHazards = 10_000;
const maximumTargetPaths = 32;
const hazardKinds = ["discarded", "default-return", "hidden"] as const;
export type BroadExceptionSwallowingKind = typeof hazardKinds[number];

export interface BroadExceptionSwallowingPlan {
  readonly schemaVersion: typeof broadExceptionSwallowingPlanSchemaVersion;
  readonly adapter: string;
  readonly policySha256: string;
  readonly targetScope: "adapter-production-sources";
  readonly targetPaths: readonly string[];
}

export interface BroadExceptionSwallowingHazard {
  readonly kind: BroadExceptionSwallowingKind;
  readonly identitySha256: string;
}

export interface BroadExceptionSwallowingResult {
  readonly schemaVersion: typeof broadExceptionSwallowingResultSchemaVersion;
  readonly adapter: string;
  readonly policySha256: string;
  readonly targetScope: "adapter-production-sources";
  readonly targetPaths: readonly string[];
  readonly hazardIdentitySemantics: string;
  readonly hazards: readonly BroadExceptionSwallowingHazard[];
  readonly inventorySha256: string;
}

export interface BroadExceptionSwallowingComparison {
  readonly schemaVersion: typeof broadExceptionSwallowingComparisonSchemaVersion;
  readonly adapter: string;
  readonly policySha256: string;
  readonly targetScope: "adapter-production-sources";
  readonly targetPaths: readonly string[];
  readonly hazardIdentitySemantics: string;
  readonly baselineHazardCount: number;
  readonly currentHazardCount: number;
  readonly removedHazardCount: number;
  readonly outcome: "clean" | "removed" | "unchanged";
}

export function assertBroadExceptionSwallowingPlan(value: unknown): BroadExceptionSwallowingPlan {
  const plan = exactRecord(value, ["adapter", "policySha256", "schemaVersion", "targetPaths", "targetScope"], "Broad exception-swallowing plan");
  if (plan.schemaVersion !== broadExceptionSwallowingPlanSchemaVersion || plan.targetScope !== "adapter-production-sources") {
    throw new Error("Broad exception-swallowing plan uses an unsupported schema or target scope.");
  }
  return Object.freeze({
    schemaVersion: broadExceptionSwallowingPlanSchemaVersion,
    adapter: identity(plan.adapter, "adapter"),
    policySha256: hash(plan.policySha256, "policy"),
    targetScope: "adapter-production-sources",
    targetPaths: targetPaths(plan.targetPaths),
  });
}

export function assertBroadExceptionSwallowingResult(
  value: unknown,
  plan: BroadExceptionSwallowingPlan,
): BroadExceptionSwallowingResult {
  const result = exactRecord(value, [
    "adapter", "hazardIdentitySemantics", "hazards", "inventorySha256", "policySha256", "schemaVersion",
    "targetPaths", "targetScope",
  ], "Broad exception-swallowing result");
  if (result.schemaVersion !== broadExceptionSwallowingResultSchemaVersion || result.targetScope !== plan.targetScope) {
    throw new Error("Broad exception-swallowing result uses an unsupported schema or target scope.");
  }
  if (result.adapter !== plan.adapter || result.policySha256 !== plan.policySha256
    || JSON.stringify(result.targetPaths) !== JSON.stringify(plan.targetPaths)) {
    throw new Error("Broad exception-swallowing result identifies the wrong adapter, policy, or target paths.");
  }
  if (!Array.isArray(result.hazards) || result.hazards.length > maximumHazards) {
    throw new Error("Broad exception-swallowing hazards are malformed or excessive.");
  }
  const hazards = result.hazards.map((value) => {
    const hazard = exactRecord(value, ["identitySha256", "kind"], "Broad exception-swallowing hazard");
    if (!hazardKinds.includes(hazard.kind as BroadExceptionSwallowingKind)) {
      throw new Error("Broad exception-swallowing hazard kind is unsupported.");
    }
    return Object.freeze({
      kind: hazard.kind as BroadExceptionSwallowingKind,
      identitySha256: hash(hazard.identitySha256, "hazard"),
    });
  }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  if (new Set(hazards.map((hazard) => hazard.identitySha256)).size !== hazards.length) {
    throw new Error("Broad exception-swallowing hazard identities contain duplicates.");
  }
  const hazardIdentitySemantics = schemaIdentity(result.hazardIdentitySemantics);
  const inventorySha256 = hash(result.inventorySha256, "inventory");
  if (inventorySha256 !== broadExceptionSwallowingHash(JSON.stringify([hazardIdentitySemantics, hazards]))) {
    throw new Error("Broad exception-swallowing inventory identity is inconsistent.");
  }
  return Object.freeze({
    schemaVersion: broadExceptionSwallowingResultSchemaVersion,
    adapter: plan.adapter,
    policySha256: plan.policySha256,
    targetScope: plan.targetScope,
    targetPaths: plan.targetPaths,
    hazardIdentitySemantics,
    hazards: Object.freeze(hazards),
    inventorySha256,
  });
}

export function compareBroadExceptionSwallowing(
  baselineValue: unknown,
  currentValue: unknown,
): BroadExceptionSwallowingComparison {
  const baseline = comparableResult(baselineValue, "baseline");
  const current = comparableResult(currentValue, "current");
  if (baseline.adapter !== current.adapter || baseline.policySha256 !== current.policySha256
    || baseline.targetScope !== current.targetScope || JSON.stringify(baseline.targetPaths) !== JSON.stringify(current.targetPaths)) {
    throw new Error("Broad exception-swallowing results are incomparable across adapter, policy, or target scope.");
  }
  if (baseline.hazardIdentitySemantics !== current.hazardIdentitySemantics) {
    throw new Error("Broad exception-swallowing results use incomparable identity semantics.");
  }
  const baselineSet = new Set(baseline.hazards.map((hazard) => `${hazard.kind}:${hazard.identitySha256}`));
  const introduced = current.hazards.filter((hazard) => !baselineSet.has(`${hazard.kind}:${hazard.identitySha256}`));
  if (introduced.length > 0) {
    const kinds = [...new Set(introduced.map((hazard) => hazard.kind))].sort().join(", ");
    throw new Error(`Verification introduced broad exception swallowing through: ${kinds}.`);
  }
  const removedHazardCount = baseline.hazards.length - current.hazards.length;
  return Object.freeze({
    schemaVersion: broadExceptionSwallowingComparisonSchemaVersion,
    adapter: baseline.adapter,
    policySha256: baseline.policySha256,
    targetScope: baseline.targetScope,
    targetPaths: baseline.targetPaths,
    hazardIdentitySemantics: baseline.hazardIdentitySemantics,
    baselineHazardCount: baseline.hazards.length,
    currentHazardCount: current.hazards.length,
    removedHazardCount,
    outcome: baseline.hazards.length === 0 ? "clean" : removedHazardCount > 0 ? "removed" : "unchanged",
  });
}

export function broadExceptionSwallowingHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparableResult(value: unknown, label: string): BroadExceptionSwallowingResult {
  const record = exactRecord(value, [
    "adapter", "hazardIdentitySemantics", "hazards", "inventorySha256", "policySha256", "schemaVersion",
    "targetPaths", "targetScope",
  ], `Broad exception-swallowing ${label} result`);
  const plan = assertBroadExceptionSwallowingPlan({
    schemaVersion: broadExceptionSwallowingPlanSchemaVersion,
    adapter: record.adapter,
    policySha256: record.policySha256,
    targetScope: record.targetScope,
    targetPaths: record.targetPaths,
  });
  return assertBroadExceptionSwallowingResult(record, plan);
}

function targetPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumTargetPaths) {
    throw new Error("Broad exception-swallowing target paths are malformed or excessive.");
  }
  const paths = value.map((path) => {
    if (typeof path !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(path)
      || path === "." || path.split("/").includes("..")) {
      throw new Error("Broad exception-swallowing target path is escaped or malformed.");
    }
    return path;
  });
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    throw new Error("Broad exception-swallowing target paths are duplicate or unsorted.");
  }
  return Object.freeze(paths);
}

function identity(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`Broad exception-swallowing ${name} is malformed.`);
  }
  return value;
}

function schemaIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/v[1-9][0-9]{0,5}$/u.test(value)) {
    throw new Error("Broad exception-swallowing identity semantics are malformed.");
  }
  return value;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Broad exception-swallowing ${name} identity is malformed.`);
  }
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} is extended or incomplete.`);
  }
  return record;
}
