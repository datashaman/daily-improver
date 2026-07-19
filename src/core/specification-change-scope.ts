import { createHash } from "node:crypto";
import type { ImprovementSpec } from "../domain/model.js";
import {
  assertSpecificationChangeScopePlan,
  assertSpecificationChangeScopeResult,
  decideSpecificationChangeScopeOutcome,
  type ProductionChangeKind,
  type SpecificationChangeScopePlan,
  type SpecificationChangeScopeResult,
} from "../domain/specification-change-scope.js";
import type { CommandRunner } from "../infra/command-runner.js";

const maximumRawDiffBytes = 16 * 1024 * 1024;
const maximumPaths = 10_000;

type ChangeScopeRunner = Pick<CommandRunner, "run">;

interface ExclusionSelectors {
  readonly exact: readonly string[];
  readonly prefixes: readonly string[];
}

export function prepareSpecificationChangeScopePlan(specification: ImprovementSpec): SpecificationChangeScopePlan {
  const allowedFiles = exactPaths(specification.allowedFiles, "allowlist", true);
  const exclusions = exclusionClauses(specification.exclusions);
  for (const path of allowedFiles) {
    if (exclusions.exact.includes(path) || exclusions.prefixes.some((prefix) => insidePrefix(path, prefix))) {
      throw new Error("Specification change-scope allowlist overlaps an exclusion.");
    }
  }
  const allowedPathIdentities = allowedFiles.map(hash).sort();
  const exclusionClauseIdentities = specification.exclusions.map(hash).sort();
  const excludedExactPathIdentities = exclusions.exact.map(hash).sort();
  const excludedPrefixIdentities = exclusions.prefixes.map(hash).sort();
  const unsigned = {
    schemaVersion: "specification-change-scope-plan/v1" as const,
    policyId: "sealed-specification-change-scope-policy/v1" as const,
    changeSemantics: "git-raw-no-renames-excluding-verifier-artifacts/v1" as const,
    allowedPathIdentities,
    exclusionClauseIdentities,
    excludedExactPathIdentities,
    excludedPrefixIdentities,
  };
  return assertSpecificationChangeScopePlan({
    ...unsigned,
    specificationScopeSha256: hash(JSON.stringify(unsigned)),
  });
}

export async function inspectSpecificationChangeScope(
  root: string,
  expectedBaseSha: string,
  specification: ImprovementSpec,
  ignoredPaths: ReadonlySet<string>,
  plan: SpecificationChangeScopePlan,
  runner: ChangeScopeRunner,
): Promise<SpecificationChangeScopeResult> {
  const exactPlan = assertSpecificationChangeScopePlan(plan);
  const independentlyPrepared = prepareSpecificationChangeScopePlan(specification);
  if (JSON.stringify(exactPlan) !== JSON.stringify(independentlyPrepared)) {
    throw new Error("Specification change-scope plan does not match the sealed specification.");
  }
  assertCommitSha(expectedBaseSha);
  const ignored = new Set(exactPaths([...ignoredPaths], "ignored verifier path", false));
  const result = await runner.run([
    "git", "diff", "--raw", "-z", "--abbrev=64", "--no-renames", "--no-ext-diff", "--no-textconv", expectedBaseSha, "--",
  ], root);
  const byteCount = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  if (result.exitCode !== 0 || result.stderr !== "" || byteCount > maximumRawDiffBytes || result.stdout.includes("\ufffd")) {
    throw new Error("Specification production diff is unavailable, malformed, or excessive.");
  }
  const changes = parseRawDiff(result.stdout).filter((change) =>
    !change.path.startsWith(".ai/runs/") && !ignored.has(change.path));
  if (changes.length > maximumPaths) throw new Error("Specification production change set is excessive.");
  const pathKeys = changes.map((change) => change.path);
  if (new Set(pathKeys).size !== pathKeys.length) throw new Error("Specification production diff contains duplicate paths.");

  const allowlist = new Set(exactPaths(specification.allowedFiles, "allowlist", true));
  const exclusions = exclusionClauses(specification.exclusions);
  let outsideAllowlistCount = 0;
  let excludedPathCount = 0;
  for (const change of changes) {
    if (!allowlist.has(change.path)) outsideAllowlistCount += 1;
    if (exclusions.exact.includes(change.path) || exclusions.prefixes.some((prefix) => insidePrefix(change.path, prefix))) {
      excludedPathCount += 1;
    }
  }
  const productionChanges = changes
    .map((change) => ({ pathSha256: hash(change.path), kind: change.kind }))
    .sort((left, right) => `${left.pathSha256}:${left.kind}`.localeCompare(`${right.pathSha256}:${right.kind}`));
  const unsigned = {
    schemaVersion: "specification-change-scope-result/v1" as const,
    policyId: exactPlan.policyId,
    changeSemantics: exactPlan.changeSemantics,
    specificationScopeSha256: exactPlan.specificationScopeSha256,
    productionChanges,
    changeSetSha256: hash(JSON.stringify(productionChanges)),
    outsideAllowlistCount,
    excludedPathCount,
    outcome: decideSpecificationChangeScopeOutcome(outsideAllowlistCount, excludedPathCount),
  };
  return assertSpecificationChangeScopeResult(unsigned, exactPlan);
}

export function requireSpecificationChangeScopeAccepted(result: SpecificationChangeScopeResult): void {
  if (result.outcome === "accepted") return;
  throw new Error("Authenticated production change set violates the sealed specification allowlist or exclusions.");
}

function parseRawDiff(output: string): readonly { readonly path: string; readonly kind: ProductionChangeKind }[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new Error("Specification production diff is not NUL terminated.");
  const fields = output.slice(0, -1).split("\0");
  if (fields.length % 2 !== 0) throw new Error("Specification production diff contains a malformed record.");
  const changes: { path: string; kind: ProductionChangeKind }[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const metadata = fields[index] ?? "";
    const path = fields[index + 1] ?? "";
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([AMDT])$/u.exec(metadata);
    if (!match) throw new Error("Specification production diff contains malformed or unsupported metadata.");
    assertPath(path);
    const status = match[5];
    const kind: ProductionChangeKind = status === "A" ? "added" : status === "M" ? "modified" : status === "D" ? "deleted" : "type-changed";
    changes.push({ path, kind });
  }
  return changes;
}

function exclusionClauses(values: readonly string[]): ExclusionSelectors {
  if (!Array.isArray(values) || values.length > 256) throw new Error("Specification exclusions are malformed or excessive.");
  const seen = new Set<string>();
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.trim() !== value || value.includes("\0")) {
      throw new Error("Specification exclusion clause is malformed or unbounded.");
    }
    if (seen.has(value)) throw new Error("Specification exclusion clauses are duplicated.");
    seen.add(value);
    if (value.startsWith("path:")) exact.push(exactPath(value.slice(5), "exact exclusion"));
    else if (value.startsWith("path-prefix:")) prefixes.push(exactPath(value.slice(12).replace(/\/$/u, ""), "prefix exclusion"));
    else if (/^(?:path|path-prefix)\s*:/u.test(value) || /[*?\[\]{}!]/u.test(value)) {
      throw new Error("Specification exclusion selector is malformed or wildcard-ambiguous.");
    }
  }
  exact.sort();
  prefixes.sort();
  if (new Set(exact).size !== exact.length || new Set(prefixes).size !== prefixes.length) {
    throw new Error("Specification exclusion selectors are duplicated.");
  }
  for (const path of exact) {
    if (prefixes.some((prefix) => insidePrefix(path, prefix))) throw new Error("Specification exclusion selectors overlap.");
  }
  for (let index = 0; index < prefixes.length; index += 1) {
    if (prefixes.some((prefix, other) => other !== index && insidePrefix(prefix, prefixes[index]!))) {
      throw new Error("Specification exclusion prefixes overlap.");
    }
  }
  return { exact, prefixes };
}

function exactPaths(values: readonly string[], name: string, nonempty: boolean): readonly string[] {
  if (!Array.isArray(values) || values.length > maximumPaths || (nonempty && values.length === 0)) {
    throw new Error(`Specification ${name} is malformed or excessive.`);
  }
  const paths = values.map((value) => exactPath(value, name));
  if (new Set(paths).size !== paths.length) throw new Error(`Specification ${name} contains duplicate paths.`);
  return paths.sort();
}

function exactPath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > 1_024 || value.startsWith("/") || value.includes("\\")
    || /[\u0000-\u001f\u007f*?\[\]{}!]/u.test(value)
    || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Specification ${name} path is malformed, escaped, or wildcard-ambiguous.`);
  }
  return value;
}

function assertPath(path: string): void {
  exactPath(path, "production diff");
}

function insidePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function assertCommitSha(value: string): void {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) throw new Error("Specification change-scope baseline identity is malformed.");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
