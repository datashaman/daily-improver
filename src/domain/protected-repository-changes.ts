import { createHash } from "node:crypto";

export const protectedRepositoryChangePlanSchemaVersion = "protected-repository-change-plan/v1" as const;
export const protectedRepositoryChangeResultSchemaVersion = "protected-repository-change-result/v1" as const;
export const protectedRepositoryChangeComparisonSchemaVersion = "protected-repository-change-comparison/v1" as const;

export const protectedRepositoryClassifications = [
  "dependency",
  "generated-binary",
  "migration",
  "workflow",
] as const;

export type ProtectedRepositoryClassification = typeof protectedRepositoryClassifications[number];
export type ProtectedRepositoryEntryType = "regular-file" | "symbolic-link" | "other";

const entryTypes = ["other", "regular-file", "symbolic-link"] as const;
const maximumEntries = 100_000;
const maximumBytes = 1_000_000_000_000;

export interface ProtectedRepositoryChangePlan {
  readonly schemaVersion: typeof protectedRepositoryChangePlanSchemaVersion;
  readonly policyId: "repository-protected-change-policy/v1";
  readonly policySha256: string;
  readonly classifications: readonly ProtectedRepositoryClassification[];
}

export interface ProtectedRepositoryEntry {
  readonly classification: ProtectedRepositoryClassification;
  readonly pathIdentitySha256: string;
  readonly contentIdentitySha256: string;
  readonly entryType: ProtectedRepositoryEntryType;
  readonly sizeBytes: number;
}

export interface ProtectedRepositoryChangeResult {
  readonly schemaVersion: typeof protectedRepositoryChangeResultSchemaVersion;
  readonly policyId: ProtectedRepositoryChangePlan["policyId"];
  readonly policySha256: string;
  readonly classifications: readonly ProtectedRepositoryClassification[];
  readonly identitySemantics: "repository-relative-path-and-content/v1";
  readonly entries: readonly ProtectedRepositoryEntry[];
  readonly inventorySha256: string;
}

export interface ProtectedRepositoryChangeComparison {
  readonly schemaVersion: typeof protectedRepositoryChangeComparisonSchemaVersion;
  readonly policyId: ProtectedRepositoryChangePlan["policyId"];
  readonly policySha256: string;
  readonly classifications: readonly ProtectedRepositoryClassification[];
  readonly identitySemantics: ProtectedRepositoryChangeResult["identitySemantics"];
  readonly baselineEntryCount: number;
  readonly currentEntryCount: number;
  readonly outcome: "clean" | "unchanged";
}

export function assertProtectedRepositoryChangePlan(value: unknown): ProtectedRepositoryChangePlan {
  const plan = exactRecord(value, ["classifications", "policyId", "policySha256", "schemaVersion"], "Protected repository-change plan");
  if (plan.schemaVersion !== protectedRepositoryChangePlanSchemaVersion
    || plan.policyId !== "repository-protected-change-policy/v1") {
    throw new Error("Protected repository-change plan uses an unsupported schema or policy.");
  }
  return Object.freeze({
    schemaVersion: protectedRepositoryChangePlanSchemaVersion,
    policyId: "repository-protected-change-policy/v1",
    policySha256: hash(plan.policySha256, "policy"),
    classifications: classifications(plan.classifications),
  });
}

export function assertProtectedRepositoryChangeResult(
  value: unknown,
  plan: ProtectedRepositoryChangePlan,
): ProtectedRepositoryChangeResult {
  const result = exactRecord(value, [
    "classifications", "entries", "identitySemantics", "inventorySha256", "policyId", "policySha256", "schemaVersion",
  ], "Protected repository-change result");
  if (result.schemaVersion !== protectedRepositoryChangeResultSchemaVersion
    || result.policyId !== plan.policyId
    || result.policySha256 !== plan.policySha256
    || JSON.stringify(result.classifications) !== JSON.stringify(plan.classifications)) {
    throw new Error("Protected repository-change result identifies the wrong schema, policy, or classifications.");
  }
  if (result.identitySemantics !== "repository-relative-path-and-content/v1") {
    throw new Error("Protected repository-change result uses unsupported identity semantics.");
  }
  if (!Array.isArray(result.entries) || result.entries.length > maximumEntries) {
    throw new Error("Protected repository-change inventory is malformed or excessive.");
  }
  let aggregateBytes = 0;
  const entries = result.entries.map((value) => {
    const entry = exactRecord(value, [
      "classification", "contentIdentitySha256", "entryType", "pathIdentitySha256", "sizeBytes",
    ], "Protected repository entry");
    if (!protectedRepositoryClassifications.includes(entry.classification as ProtectedRepositoryClassification)) {
      throw new Error("Protected repository entry classification is unsupported.");
    }
    if (!entryTypes.includes(entry.entryType as ProtectedRepositoryEntryType)) {
      throw new Error("Protected repository entry type is unsupported.");
    }
    if (!Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0 || (entry.sizeBytes as number) > maximumBytes) {
      throw new Error("Protected repository entry size is malformed or excessive.");
    }
    aggregateBytes += entry.sizeBytes as number;
    if (aggregateBytes > maximumBytes) throw new Error("Protected repository inventory bytes are excessive.");
    return Object.freeze({
      classification: entry.classification as ProtectedRepositoryClassification,
      pathIdentitySha256: hash(entry.pathIdentitySha256, "path"),
      contentIdentitySha256: hash(entry.contentIdentitySha256, "content"),
      entryType: entry.entryType as ProtectedRepositoryEntryType,
      sizeBytes: entry.sizeBytes as number,
    });
  }).sort(entryOrder);
  const keys = entries.map((entry) => `${entry.classification}:${entry.pathIdentitySha256}`);
  if (new Set(keys).size !== keys.length) throw new Error("Protected repository entry identities contain duplicates.");
  const inventorySha256 = hash(result.inventorySha256, "inventory");
  if (inventorySha256 !== protectedRepositoryChangeHash(JSON.stringify([
    result.identitySemantics, plan.classifications, entries,
  ]))) throw new Error("Protected repository-change inventory identity is inconsistent.");
  return Object.freeze({
    schemaVersion: protectedRepositoryChangeResultSchemaVersion,
    policyId: plan.policyId,
    policySha256: plan.policySha256,
    classifications: plan.classifications,
    identitySemantics: "repository-relative-path-and-content/v1",
    entries: Object.freeze(entries),
    inventorySha256,
  });
}

export function compareProtectedRepositoryChanges(
  baselineValue: unknown,
  currentValue: unknown,
): ProtectedRepositoryChangeComparison {
  const baseline = comparableResult(baselineValue);
  const current = comparableResult(currentValue);
  if (baseline.policyId !== current.policyId || baseline.policySha256 !== current.policySha256
    || baseline.identitySemantics !== current.identitySemantics
    || JSON.stringify(baseline.classifications) !== JSON.stringify(current.classifications)) {
    throw new Error("Protected repository-change results are incomparable across policy or identity semantics.");
  }
  const baselineEntries = new Map(baseline.entries.map((entry) => [`${entry.classification}:${entry.pathIdentitySha256}`, entry]));
  const currentEntries = new Map(current.entries.map((entry) => [`${entry.classification}:${entry.pathIdentitySha256}`, entry]));
  const changed = new Set<ProtectedRepositoryClassification>();
  for (const [key, entry] of baselineEntries) {
    const currentEntry = currentEntries.get(key);
    if (!currentEntry || currentEntry.contentIdentitySha256 !== entry.contentIdentitySha256
      || currentEntry.entryType !== entry.entryType || currentEntry.sizeBytes !== entry.sizeBytes) {
      changed.add(entry.classification);
    }
  }
  for (const [key, entry] of currentEntries) {
    if (!baselineEntries.has(key)) changed.add(entry.classification);
  }
  if (changed.size > 0) {
    throw new Error(`Verification changed protected repository categories: ${[...changed].sort().join(", ")}.`);
  }
  return Object.freeze({
    schemaVersion: protectedRepositoryChangeComparisonSchemaVersion,
    policyId: baseline.policyId,
    policySha256: baseline.policySha256,
    classifications: baseline.classifications,
    identitySemantics: baseline.identitySemantics,
    baselineEntryCount: baseline.entries.length,
    currentEntryCount: current.entries.length,
    outcome: baseline.entries.length === 0 ? "clean" : "unchanged",
  });
}

export function protectedRepositoryChangeHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparableResult(value: unknown): ProtectedRepositoryChangeResult {
  const record = exactRecord(value, [
    "classifications", "entries", "identitySemantics", "inventorySha256", "policyId", "policySha256", "schemaVersion",
  ], "Protected repository-change comparison input");
  return assertProtectedRepositoryChangeResult(record, assertProtectedRepositoryChangePlan({
    schemaVersion: protectedRepositoryChangePlanSchemaVersion,
    policyId: record.policyId,
    policySha256: record.policySha256,
    classifications: record.classifications,
  }));
}

function classifications(value: unknown): readonly ProtectedRepositoryClassification[] {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(protectedRepositoryClassifications)) {
    throw new Error("Protected repository-change classifications are incomplete, reordered, or unsupported.");
  }
  return protectedRepositoryClassifications;
}

function entryOrder(left: ProtectedRepositoryEntry, right: ProtectedRepositoryEntry): number {
  return left.classification.localeCompare(right.classification) || left.pathIdentitySha256.localeCompare(right.pathIdentitySha256);
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Protected repository-change ${name} identity is malformed.`);
  }
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  const record = value as Readonly<Record<string, unknown>>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${name} is extended or incomplete.`);
  }
  return record;
}
