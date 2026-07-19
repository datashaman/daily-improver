import { createHash } from "node:crypto";

export const validationBoundaryPlanSchemaVersion = "validation-boundary-plan/v1" as const;
export const validationBoundaryResultSchemaVersion = "validation-boundary-result/v1" as const;
export const validationBoundaryComparisonSchemaVersion = "validation-boundary-comparison/v1" as const;

const maximumBoundaries = 10_000;
const maximumGuarantees = 100_000;
const maximumTargetPaths = 32;
const maximumStrength = 1_000_000;

export interface ValidationBoundaryPlan {
  readonly schemaVersion: typeof validationBoundaryPlanSchemaVersion;
  readonly adapter: string;
  readonly policySha256: string;
  readonly targetScope: "adapter-production-sources";
  readonly targetPaths: readonly string[];
}

export interface ValidationGuarantee {
  readonly identitySha256: string;
  readonly strength: number;
}

export interface ValidationBoundary {
  readonly identitySha256: string;
  readonly guarantees: readonly ValidationGuarantee[];
}

export interface ValidationBoundaryResult {
  readonly schemaVersion: typeof validationBoundaryResultSchemaVersion;
  readonly adapter: string;
  readonly policySha256: string;
  readonly targetScope: "adapter-production-sources";
  readonly targetPaths: readonly string[];
  readonly boundaryIdentitySemantics: string;
  readonly guaranteeIdentitySemantics: string;
  readonly unvalidatedFlowIdentitySemantics: string;
  readonly boundaries: readonly ValidationBoundary[];
  readonly unvalidatedFlowIdentities: readonly string[];
  readonly inventorySha256: string;
}

export interface ValidationBoundaryComparison {
  readonly schemaVersion: typeof validationBoundaryComparisonSchemaVersion;
  readonly adapter: string;
  readonly policySha256: string;
  readonly targetScope: "adapter-production-sources";
  readonly targetPaths: readonly string[];
  readonly boundaryIdentitySemantics: string;
  readonly guaranteeIdentitySemantics: string;
  readonly unvalidatedFlowIdentitySemantics: string;
  readonly baselineBoundaryCount: number;
  readonly currentBoundaryCount: number;
  readonly baselineGuaranteeCount: number;
  readonly currentGuaranteeCount: number;
  readonly baselineUnvalidatedFlowCount: number;
  readonly currentUnvalidatedFlowCount: number;
  readonly outcome: "clean" | "strengthened" | "unchanged";
}

export function assertValidationBoundaryPlan(value: unknown): ValidationBoundaryPlan {
  const plan = exactRecord(value, ["adapter", "policySha256", "schemaVersion", "targetPaths", "targetScope"], "Validation-boundary plan");
  if (plan.schemaVersion !== validationBoundaryPlanSchemaVersion || plan.targetScope !== "adapter-production-sources") {
    throw new Error("Validation-boundary plan uses an unsupported schema or target scope.");
  }
  return Object.freeze({
    schemaVersion: validationBoundaryPlanSchemaVersion,
    adapter: identity(plan.adapter, "adapter"),
    policySha256: hash(plan.policySha256, "policy"),
    targetScope: "adapter-production-sources",
    targetPaths: targetPaths(plan.targetPaths),
  });
}

export function assertValidationBoundaryResult(
  value: unknown,
  plan: ValidationBoundaryPlan,
): ValidationBoundaryResult {
  const result = exactRecord(value, [
    "adapter", "boundaries", "boundaryIdentitySemantics", "guaranteeIdentitySemantics", "inventorySha256",
    "policySha256", "schemaVersion", "targetPaths", "targetScope", "unvalidatedFlowIdentities",
    "unvalidatedFlowIdentitySemantics",
  ], "Validation-boundary result");
  if (result.schemaVersion !== validationBoundaryResultSchemaVersion || result.targetScope !== plan.targetScope) {
    throw new Error("Validation-boundary result uses an unsupported schema or target scope.");
  }
  if (result.adapter !== plan.adapter || result.policySha256 !== plan.policySha256
    || JSON.stringify(result.targetPaths) !== JSON.stringify(plan.targetPaths)) {
    throw new Error("Validation-boundary result identifies the wrong adapter, policy, or target paths.");
  }
  if (!Array.isArray(result.boundaries) || result.boundaries.length > maximumBoundaries) {
    throw new Error("Validation-boundary inventory is malformed or excessive.");
  }
  let guaranteeCount = 0;
  const boundaries = result.boundaries.map((value) => {
    const boundary = exactRecord(value, ["guarantees", "identitySha256"], "Validation boundary");
    if (!Array.isArray(boundary.guarantees)) throw new Error("Validation guarantees are malformed.");
    guaranteeCount += boundary.guarantees.length;
    if (guaranteeCount > maximumGuarantees) throw new Error("Validation guarantees are excessive.");
    const guarantees = boundary.guarantees.map((value) => {
      const guarantee = exactRecord(value, ["identitySha256", "strength"], "Validation guarantee");
      if (!Number.isSafeInteger(guarantee.strength) || (guarantee.strength as number) < 1
        || (guarantee.strength as number) > maximumStrength) {
        throw new Error("Validation guarantee strength is malformed or excessive.");
      }
      return Object.freeze({
        identitySha256: hash(guarantee.identitySha256, "guarantee"),
        strength: guarantee.strength as number,
      });
    }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
    if (new Set(guarantees.map((guarantee) => guarantee.identitySha256)).size !== guarantees.length) {
      throw new Error("Validation guarantee identities contain duplicates.");
    }
    return Object.freeze({
      identitySha256: hash(boundary.identitySha256, "boundary"),
      guarantees: Object.freeze(guarantees),
    });
  }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  if (new Set(boundaries.map((boundary) => boundary.identitySha256)).size !== boundaries.length) {
    throw new Error("Validation boundary identities contain duplicates.");
  }
  if (!Array.isArray(result.unvalidatedFlowIdentities) || result.unvalidatedFlowIdentities.length > maximumBoundaries) {
    throw new Error("Unvalidated input-flow inventory is malformed or excessive.");
  }
  const unvalidatedFlowIdentities = result.unvalidatedFlowIdentities.map((value) => hash(value, "unvalidated flow")).sort();
  if (new Set(unvalidatedFlowIdentities).size !== unvalidatedFlowIdentities.length) {
    throw new Error("Unvalidated input-flow identities contain duplicates.");
  }
  const boundaryIdentitySemantics = schemaIdentity(result.boundaryIdentitySemantics, "boundary");
  const guaranteeIdentitySemantics = schemaIdentity(result.guaranteeIdentitySemantics, "guarantee");
  const unvalidatedFlowIdentitySemantics = schemaIdentity(result.unvalidatedFlowIdentitySemantics, "unvalidated flow");
  const inventorySha256 = hash(result.inventorySha256, "inventory");
  if (inventorySha256 !== validationBoundaryHash(JSON.stringify([
    boundaryIdentitySemantics, guaranteeIdentitySemantics, unvalidatedFlowIdentitySemantics, boundaries, unvalidatedFlowIdentities,
  ]))) {
    throw new Error("Validation-boundary inventory identity is inconsistent.");
  }
  return Object.freeze({
    schemaVersion: validationBoundaryResultSchemaVersion,
    adapter: plan.adapter,
    policySha256: plan.policySha256,
    targetScope: plan.targetScope,
    targetPaths: plan.targetPaths,
    boundaryIdentitySemantics,
    guaranteeIdentitySemantics,
    unvalidatedFlowIdentitySemantics,
    boundaries: Object.freeze(boundaries),
    unvalidatedFlowIdentities: Object.freeze(unvalidatedFlowIdentities),
    inventorySha256,
  });
}

export function compareValidationBoundaries(
  baselineValue: unknown,
  currentValue: unknown,
): ValidationBoundaryComparison {
  const baseline = comparableResult(baselineValue, "baseline");
  const current = comparableResult(currentValue, "current");
  assertComparable(baseline, current);
  const currentBoundaries = new Map(current.boundaries.map((boundary) => [boundary.identitySha256, boundary]));
  let strengthened = current.boundaries.length > baseline.boundaries.length;
  for (const baselineBoundary of baseline.boundaries) {
    const currentBoundary = currentBoundaries.get(baselineBoundary.identitySha256);
    if (!currentBoundary) throw new Error("Verification removed a validation boundary.");
    const currentGuarantees = new Map(currentBoundary.guarantees.map((guarantee) => [guarantee.identitySha256, guarantee.strength]));
    for (const baselineGuarantee of baselineBoundary.guarantees) {
      const currentStrength = currentGuarantees.get(baselineGuarantee.identitySha256);
      if (currentStrength === undefined || currentStrength < baselineGuarantee.strength) {
        throw new Error("Verification weakened a validation contract.");
      }
      if (currentStrength > baselineGuarantee.strength) strengthened = true;
    }
    if (currentBoundary.guarantees.length > baselineBoundary.guarantees.length) strengthened = true;
  }
  const baselineFlows = new Set(baseline.unvalidatedFlowIdentities);
  if (current.unvalidatedFlowIdentities.some((flow) => !baselineFlows.has(flow))) {
    throw new Error("Verification introduced an unvalidated input flow.");
  }
  if (current.unvalidatedFlowIdentities.length < baseline.unvalidatedFlowIdentities.length) strengthened = true;
  const baselineGuaranteeCount = countGuarantees(baseline);
  const currentGuaranteeCount = countGuarantees(current);
  const empty = baseline.boundaries.length === 0 && current.boundaries.length === 0
    && baseline.unvalidatedFlowIdentities.length === 0 && current.unvalidatedFlowIdentities.length === 0;
  return Object.freeze({
    schemaVersion: validationBoundaryComparisonSchemaVersion,
    adapter: baseline.adapter,
    policySha256: baseline.policySha256,
    targetScope: baseline.targetScope,
    targetPaths: baseline.targetPaths,
    boundaryIdentitySemantics: baseline.boundaryIdentitySemantics,
    guaranteeIdentitySemantics: baseline.guaranteeIdentitySemantics,
    unvalidatedFlowIdentitySemantics: baseline.unvalidatedFlowIdentitySemantics,
    baselineBoundaryCount: baseline.boundaries.length,
    currentBoundaryCount: current.boundaries.length,
    baselineGuaranteeCount,
    currentGuaranteeCount,
    baselineUnvalidatedFlowCount: baseline.unvalidatedFlowIdentities.length,
    currentUnvalidatedFlowCount: current.unvalidatedFlowIdentities.length,
    outcome: empty ? "clean" : strengthened ? "strengthened" : "unchanged",
  });
}

export function validationBoundaryHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertComparable(baseline: ValidationBoundaryResult, current: ValidationBoundaryResult): void {
  if (baseline.adapter !== current.adapter || baseline.policySha256 !== current.policySha256
    || baseline.targetScope !== current.targetScope || JSON.stringify(baseline.targetPaths) !== JSON.stringify(current.targetPaths)) {
    throw new Error("Validation-boundary results are incomparable across adapter, policy, or target scope.");
  }
  if (baseline.boundaryIdentitySemantics !== current.boundaryIdentitySemantics
    || baseline.guaranteeIdentitySemantics !== current.guaranteeIdentitySemantics
    || baseline.unvalidatedFlowIdentitySemantics !== current.unvalidatedFlowIdentitySemantics) {
    throw new Error("Validation-boundary results use incomparable adapter semantics.");
  }
}

function comparableResult(value: unknown, label: string): ValidationBoundaryResult {
  const record = exactRecord(value, [
    "adapter", "boundaries", "boundaryIdentitySemantics", "guaranteeIdentitySemantics", "inventorySha256",
    "policySha256", "schemaVersion", "targetPaths", "targetScope", "unvalidatedFlowIdentities",
    "unvalidatedFlowIdentitySemantics",
  ], `Validation-boundary ${label} result`);
  const plan = assertValidationBoundaryPlan({
    schemaVersion: validationBoundaryPlanSchemaVersion,
    adapter: record.adapter,
    policySha256: record.policySha256,
    targetScope: record.targetScope,
    targetPaths: record.targetPaths,
  });
  return assertValidationBoundaryResult(record, plan);
}

function countGuarantees(result: ValidationBoundaryResult): number {
  return result.boundaries.reduce((count, boundary) => count + boundary.guarantees.length, 0);
}

function targetPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumTargetPaths) {
    throw new Error("Validation-boundary target paths are malformed or excessive.");
  }
  const paths = value.map((path) => {
    if (typeof path !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(path)
      || path === "." || path.split("/").includes("..")) {
      throw new Error("Validation-boundary target path is escaped or malformed.");
    }
    return path;
  });
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    throw new Error("Validation-boundary target paths are duplicate or unsorted.");
  }
  return Object.freeze(paths);
}

function identity(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`Validation-boundary ${name} is malformed.`);
  }
  return value;
}

function schemaIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/v[1-9][0-9]{0,5}$/u.test(value)) {
    throw new Error(`Validation-boundary ${name} identity semantics are malformed.`);
  }
  return value;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Validation-boundary ${name} identity is malformed.`);
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
