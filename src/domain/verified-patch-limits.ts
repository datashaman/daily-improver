export const verifiedPatchLimitPlanSchemaVersion = "verified-patch-limit-plan/v1" as const;
export const verifiedPatchLimitResultSchemaVersion = "verified-patch-limit-result/v1" as const;

const maximumFiles = 10_000;
const maximumLines = 10_000_000;

export interface VerifiedPatchLimits {
  readonly maxChangedFiles: number;
  readonly maxDiffLines: number;
}

export interface VerifiedPatchLimitPlan extends VerifiedPatchLimits {
  readonly schemaVersion: typeof verifiedPatchLimitPlanSchemaVersion;
  readonly policyId: "verified-patch-limits-policy/v1";
  readonly countingSemantics: "git-numstat-no-renames-excluding-run-artifacts/v1";
}

export interface VerifiedPatchLimitResult extends VerifiedPatchLimits {
  readonly schemaVersion: typeof verifiedPatchLimitResultSchemaVersion;
  readonly policyId: VerifiedPatchLimitPlan["policyId"];
  readonly countingSemantics: VerifiedPatchLimitPlan["countingSemantics"];
  readonly patchSha256: string;
  readonly changedFileCount: number;
  readonly addedLineCount: number;
  readonly deletedLineCount: number;
  readonly changedLineCount: number;
  readonly outcome: "accepted" | "rejected-file-limit" | "rejected-line-limit" | "rejected-both-limits";
}

export function assertVerifiedPatchLimits(value: unknown): VerifiedPatchLimits {
  const limits = exactRecord(value, ["maxChangedFiles", "maxDiffLines"], "Verified-patch limits");
  return Object.freeze({
    maxChangedFiles: boundedPositiveInteger(limits.maxChangedFiles, maximumFiles, "file"),
    maxDiffLines: boundedPositiveInteger(limits.maxDiffLines, maximumLines, "line"),
  });
}

export function assertVerifiedPatchLimitPlan(value: unknown): VerifiedPatchLimitPlan {
  const plan = exactRecord(value, [
    "countingSemantics", "maxChangedFiles", "maxDiffLines", "policyId", "schemaVersion",
  ], "Verified-patch limit plan");
  if (plan.schemaVersion !== verifiedPatchLimitPlanSchemaVersion
    || plan.policyId !== "verified-patch-limits-policy/v1"
    || plan.countingSemantics !== "git-numstat-no-renames-excluding-run-artifacts/v1") {
    throw new Error("Verified-patch limit plan uses an unsupported schema, policy, or counting semantics.");
  }
  const limits = assertVerifiedPatchLimits({
    maxChangedFiles: plan.maxChangedFiles,
    maxDiffLines: plan.maxDiffLines,
  });
  return Object.freeze({
    schemaVersion: verifiedPatchLimitPlanSchemaVersion,
    policyId: "verified-patch-limits-policy/v1",
    countingSemantics: "git-numstat-no-renames-excluding-run-artifacts/v1",
    ...limits,
  });
}

export function assertVerifiedPatchLimitResult(value: unknown, plan: VerifiedPatchLimitPlan): VerifiedPatchLimitResult {
  const result = exactRecord(value, [
    "addedLineCount", "changedFileCount", "changedLineCount", "countingSemantics", "deletedLineCount",
    "maxChangedFiles", "maxDiffLines", "outcome", "patchSha256", "policyId", "schemaVersion",
  ], "Verified-patch limit result");
  if (result.schemaVersion !== verifiedPatchLimitResultSchemaVersion
    || result.policyId !== plan.policyId || result.countingSemantics !== plan.countingSemantics
    || result.maxChangedFiles !== plan.maxChangedFiles || result.maxDiffLines !== plan.maxDiffLines) {
    throw new Error("Verified-patch limit result is not bound to its exact plan.");
  }
  const changedFileCount = boundedNonnegativeInteger(result.changedFileCount, maximumFiles, "changed-file");
  const addedLineCount = boundedNonnegativeInteger(result.addedLineCount, maximumLines, "added-line");
  const deletedLineCount = boundedNonnegativeInteger(result.deletedLineCount, maximumLines, "deleted-line");
  const changedLineCount = boundedNonnegativeInteger(result.changedLineCount, maximumLines, "changed-line");
  if (addedLineCount + deletedLineCount !== changedLineCount) {
    throw new Error("Verified-patch changed-line count is inconsistent.");
  }
  const outcome = decideOutcome(changedFileCount, changedLineCount, plan);
  if (result.outcome !== outcome) throw new Error("Verified-patch limit outcome is inconsistent.");
  if (typeof result.patchSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.patchSha256)) {
    throw new Error("Verified-patch identity is malformed.");
  }
  return Object.freeze({
    schemaVersion: verifiedPatchLimitResultSchemaVersion,
    policyId: plan.policyId,
    countingSemantics: plan.countingSemantics,
    maxChangedFiles: plan.maxChangedFiles,
    maxDiffLines: plan.maxDiffLines,
    patchSha256: result.patchSha256,
    changedFileCount,
    addedLineCount,
    deletedLineCount,
    changedLineCount,
    outcome,
  });
}

export function decideOutcome(
  changedFileCount: number,
  changedLineCount: number,
  limits: VerifiedPatchLimits,
): VerifiedPatchLimitResult["outcome"] {
  const filesExceeded = changedFileCount > limits.maxChangedFiles;
  const linesExceeded = changedLineCount > limits.maxDiffLines;
  if (filesExceeded && linesExceeded) return "rejected-both-limits";
  if (filesExceeded) return "rejected-file-limit";
  if (linesExceeded) return "rejected-line-limit";
  return "accepted";
}

function boundedPositiveInteger(value: unknown, maximum: number, name: string): number {
  const integer = boundedNonnegativeInteger(value, maximum, name);
  if (integer < 1) throw new Error(`Verified-patch ${name} limit is malformed or out of bounds.`);
  return integer;
}

function boundedNonnegativeInteger(value: unknown, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`Verified-patch ${name} count is malformed or out of bounds.`);
  }
  return value as number;
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  const record = value as Readonly<Record<string, unknown>>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${name} is extended or incomplete.`);
  }
  return record;
}
