import { createHash } from "node:crypto";

export const specificationChangeScopePlanSchemaVersion = "specification-change-scope-plan/v1" as const;
export const specificationChangeScopeResultSchemaVersion = "specification-change-scope-result/v1" as const;

const maximumPaths = 10_000;

export type ProductionChangeKind = "added" | "modified" | "deleted" | "type-changed";

export interface SpecificationChangeScopePlan {
  readonly schemaVersion: typeof specificationChangeScopePlanSchemaVersion;
  readonly policyId: "sealed-specification-change-scope-policy/v1";
  readonly changeSemantics: "git-raw-no-renames-excluding-verifier-artifacts/v1";
  readonly allowedPathIdentities: readonly string[];
  readonly exclusionClauseIdentities: readonly string[];
  readonly excludedExactPathIdentities: readonly string[];
  readonly excludedPrefixIdentities: readonly string[];
  readonly specificationScopeSha256: string;
}

export interface SpecificationProductionChange {
  readonly pathSha256: string;
  readonly kind: ProductionChangeKind;
}

export interface SpecificationChangeScopeResult {
  readonly schemaVersion: typeof specificationChangeScopeResultSchemaVersion;
  readonly policyId: SpecificationChangeScopePlan["policyId"];
  readonly changeSemantics: SpecificationChangeScopePlan["changeSemantics"];
  readonly specificationScopeSha256: string;
  readonly productionChanges: readonly SpecificationProductionChange[];
  readonly changeSetSha256: string;
  readonly outsideAllowlistCount: number;
  readonly excludedPathCount: number;
  readonly outcome: "accepted" | "rejected-outside-allowlist" | "rejected-exclusion" | "rejected-both";
}

export function assertSpecificationChangeScopePlan(value: unknown): SpecificationChangeScopePlan {
  const plan = exactRecord(value, [
    "allowedPathIdentities", "changeSemantics", "excludedExactPathIdentities", "excludedPrefixIdentities",
    "exclusionClauseIdentities", "policyId", "schemaVersion", "specificationScopeSha256",
  ], "Specification change-scope plan");
  if (plan.schemaVersion !== specificationChangeScopePlanSchemaVersion
    || plan.policyId !== "sealed-specification-change-scope-policy/v1"
    || plan.changeSemantics !== "git-raw-no-renames-excluding-verifier-artifacts/v1") {
    throw new Error("Specification change-scope plan uses an unsupported schema, policy, or semantics.");
  }
  const allowedPathIdentities = identities(plan.allowedPathIdentities, "allowlist", true);
  const exclusionClauseIdentities = identities(plan.exclusionClauseIdentities, "exclusion clause", false);
  const excludedExactPathIdentities = identities(plan.excludedExactPathIdentities, "exact exclusion", false);
  const excludedPrefixIdentities = identities(plan.excludedPrefixIdentities, "prefix exclusion", false);
  const allSelectors = [...excludedExactPathIdentities, ...excludedPrefixIdentities];
  if (new Set(allSelectors).size !== allSelectors.length) {
    throw new Error("Specification change-scope exclusions overlap or are duplicated.");
  }
  const specificationScopeSha256 = sha256(plan.specificationScopeSha256, "specification scope");
  const validated = {
    schemaVersion: specificationChangeScopePlanSchemaVersion,
    policyId: "sealed-specification-change-scope-policy/v1",
    changeSemantics: "git-raw-no-renames-excluding-verifier-artifacts/v1",
    allowedPathIdentities,
    exclusionClauseIdentities,
    excludedExactPathIdentities,
    excludedPrefixIdentities,
    specificationScopeSha256,
  } as const;
  const { specificationScopeSha256: _identity, ...scope } = validated;
  if (hash(JSON.stringify(scope)) !== specificationScopeSha256) {
    throw new Error("Specification change-scope plan identity is inconsistent.");
  }
  return Object.freeze(validated);
}

export function assertSpecificationChangeScopeResult(
  value: unknown,
  plan: SpecificationChangeScopePlan,
): SpecificationChangeScopeResult {
  const result = exactRecord(value, [
    "changeSemantics", "changeSetSha256", "excludedPathCount", "outcome", "outsideAllowlistCount",
    "policyId", "productionChanges", "schemaVersion", "specificationScopeSha256",
  ], "Specification change-scope result");
  if (result.schemaVersion !== specificationChangeScopeResultSchemaVersion
    || result.policyId !== plan.policyId || result.changeSemantics !== plan.changeSemantics
    || result.specificationScopeSha256 !== plan.specificationScopeSha256) {
    throw new Error("Specification change-scope result is not bound to its exact plan.");
  }
  if (!Array.isArray(result.productionChanges) || result.productionChanges.length > maximumPaths) {
    throw new Error("Specification production-change inventory is malformed or excessive.");
  }
  const productionChanges = result.productionChanges.map((item) => {
    const change = exactRecord(item, ["kind", "pathSha256"], "Specification production change");
    if (change.kind !== "added" && change.kind !== "modified" && change.kind !== "deleted" && change.kind !== "type-changed") {
      throw new Error("Specification production-change kind is unsupported.");
    }
    return Object.freeze({ pathSha256: sha256(change.pathSha256, "production path"), kind: change.kind });
  });
  const keys = productionChanges.map((change) => `${change.pathSha256}:${change.kind}`);
  if (new Set(keys).size !== keys.length || JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
    throw new Error("Specification production-change inventory is duplicated or unsorted.");
  }
  const outsideAllowlistCount = count(result.outsideAllowlistCount, productionChanges.length, "outside-allowlist");
  const excludedPathCount = count(result.excludedPathCount, productionChanges.length, "excluded-path");
  const outcome = decideSpecificationChangeScopeOutcome(outsideAllowlistCount, excludedPathCount);
  if (result.outcome !== outcome) throw new Error("Specification change-scope outcome is inconsistent.");
  const changeSetSha256 = sha256(result.changeSetSha256, "change set");
  if (hash(JSON.stringify(productionChanges)) !== changeSetSha256) {
    throw new Error("Specification production change-set identity is inconsistent.");
  }
  return Object.freeze({
    schemaVersion: specificationChangeScopeResultSchemaVersion,
    policyId: plan.policyId,
    changeSemantics: plan.changeSemantics,
    specificationScopeSha256: plan.specificationScopeSha256,
    productionChanges: Object.freeze(productionChanges),
    changeSetSha256,
    outsideAllowlistCount,
    excludedPathCount,
    outcome,
  });
}

export function decideSpecificationChangeScopeOutcome(
  outsideAllowlistCount: number,
  excludedPathCount: number,
): SpecificationChangeScopeResult["outcome"] {
  if (outsideAllowlistCount > 0 && excludedPathCount > 0) return "rejected-both";
  if (outsideAllowlistCount > 0) return "rejected-outside-allowlist";
  if (excludedPathCount > 0) return "rejected-exclusion";
  return "accepted";
}

function identities(value: unknown, name: string, nonempty: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumPaths || (nonempty && value.length === 0)) {
    throw new Error(`Specification ${name} identities are malformed or excessive.`);
  }
  const values = value.map((identity) => sha256(identity, name));
  if (new Set(values).size !== values.length || JSON.stringify(values) !== JSON.stringify([...values].sort())) {
    throw new Error(`Specification ${name} identities are duplicated or unsorted.`);
  }
  return Object.freeze(values);
}

function count(value: unknown, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`Specification ${name} count is malformed or inconsistent.`);
  }
  return value as number;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Specification ${name} identity is malformed.`);
  }
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  const record = value as Readonly<Record<string, unknown>>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${name} is extended or incomplete.`);
  }
  return record;
}
