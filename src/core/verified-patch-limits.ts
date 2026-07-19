import { createHash } from "node:crypto";
import type { CommandRunner } from "../infra/command-runner.js";
import {
  assertVerifiedPatchLimitPlan,
  assertVerifiedPatchLimitResult,
  decideOutcome,
  type VerifiedPatchLimitPlan,
  type VerifiedPatchLimitResult,
  type VerifiedPatchLimits,
} from "../domain/verified-patch-limits.js";

const maximumNumstatBytes = 16 * 1024 * 1024;

type PatchLimitRunner = Pick<CommandRunner, "run">;

export function prepareVerifiedPatchLimitPlan(limits: VerifiedPatchLimits): VerifiedPatchLimitPlan {
  return assertVerifiedPatchLimitPlan({
    schemaVersion: "verified-patch-limit-plan/v1",
    policyId: "verified-patch-limits-policy/v1",
    countingSemantics: "git-numstat-no-renames-excluding-run-artifacts/v1",
    maxChangedFiles: limits.maxChangedFiles,
    maxDiffLines: limits.maxDiffLines,
  });
}

export async function inspectVerifiedPatchLimits(
  root: string,
  expectedBaseSha: string,
  plan: VerifiedPatchLimitPlan,
  runner: PatchLimitRunner,
): Promise<VerifiedPatchLimitResult> {
  const exactPlan = assertVerifiedPatchLimitPlan(plan);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(expectedBaseSha)) {
    throw new Error("Verified-patch limit baseline identity is malformed.");
  }
  const result = await runner.run([
    "git", "diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", expectedBaseSha, "--",
  ], root);
  const byteCount = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  if (result.exitCode !== 0 || result.stderr !== "" || byteCount > maximumNumstatBytes
    || result.stdout.includes("\ufffd")) {
    throw new Error("Verified-patch numstat is unavailable, malformed, or excessive.");
  }
  const entries = parseNumstat(result.stdout).filter((entry) => !entry.path.startsWith(".ai/runs/"));
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new Error("Verified-patch numstat contains duplicate paths.");
  const addedLineCount = sum(entries.map((entry) => entry.added));
  const deletedLineCount = sum(entries.map((entry) => entry.deleted));
  const changedLineCount = addedLineCount + deletedLineCount;
  if (!Number.isSafeInteger(changedLineCount) || changedLineCount > 10_000_000) {
    throw new Error("Verified-patch changed-line inventory is excessive.");
  }
  const unsigned = {
    schemaVersion: "verified-patch-limit-result/v1" as const,
    policyId: exactPlan.policyId,
    countingSemantics: exactPlan.countingSemantics,
    maxChangedFiles: exactPlan.maxChangedFiles,
    maxDiffLines: exactPlan.maxDiffLines,
    patchSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    changedFileCount: entries.length,
    addedLineCount,
    deletedLineCount,
    changedLineCount,
    outcome: decideOutcome(entries.length, changedLineCount, exactPlan),
  };
  return assertVerifiedPatchLimitResult(unsigned, exactPlan);
}

export function requireVerifiedPatchWithinLimits(result: VerifiedPatchLimitResult): void {
  if (result.outcome === "accepted") return;
  const boundary = result.outcome === "rejected-file-limit"
    ? "file"
    : result.outcome === "rejected-line-limit" ? "line" : "file and line";
  throw new Error(`Verified patch exceeds the sealed repository ${boundary} limits.`);
}

function parseNumstat(output: string): readonly { readonly path: string; readonly added: number; readonly deleted: number }[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new Error("Verified-patch numstat is not NUL terminated.");
  const records = output.slice(0, -1).split("\0");
  return records.map((record) => {
    const fields = record.split("\t");
    if (fields.length !== 3 || !/^(?:0|[1-9]\d*)$/u.test(fields[0] ?? "") || !/^(?:0|[1-9]\d*)$/u.test(fields[1] ?? "")) {
      throw new Error("Verified-patch numstat contains a binary or malformed entry.");
    }
    const path = fields[2] ?? "";
    assertPath(path);
    const added = Number(fields[0]);
    const deleted = Number(fields[1]);
    if (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted)) {
      throw new Error("Verified-patch numstat contains an excessive line count.");
    }
    return Object.freeze({ path, added, deleted });
  });
}

function assertPath(path: string): void {
  if (!path || path.length > 1_024 || path.startsWith("/") || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Verified-patch numstat path escaped the repository or is malformed.");
  }
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error("Verified-patch line inventory is excessive.");
  }
  return total;
}
