import assert from "node:assert/strict";
import test from "node:test";
import type { ImprovementSpec } from "../src/domain/model.js";
import {
  assertSpecificationChangeScopePlan,
  assertSpecificationChangeScopeResult,
} from "../src/domain/specification-change-scope.js";
import {
  inspectSpecificationChangeScope,
  prepareSpecificationChangeScopePlan,
  requireSpecificationChangeScopeAccepted,
} from "../src/core/specification-change-scope.js";
import type { CommandRunner } from "../src/infra/command-runner.js";

const base = "a".repeat(40);

test("enforces sealed exact specification allowlists and exclusions over authenticated production changes", async () => {
  const specification = fixtureSpec(["src/Service.ts", "src/Obsolete.ts"], [
    "Dependency upgrades",
    "path-prefix:database/migrations",
  ]);
  const plan = prepareSpecificationChangeScopePlan(specification);
  assert.equal(plan.allowedPathIdentities.length, 2);
  assert.equal(plan.exclusionClauseIdentities.length, 2);
  assert.doesNotMatch(JSON.stringify(plan), /Service|Obsolete|Dependency|database|migrations/);

  const accepted = await inspect(raw(
    entry("M", "src/Service.ts"),
    entry("D", "src/Obsolete.ts"),
    entry("A", ".ai/runs/2026-07-19/test-manifest.json"),
    entry("A", "tests/GeneratedTest.php"),
  ), specification, plan, new Set(["tests/GeneratedTest.php"]));
  assert.deepEqual(accepted.productionChanges.map((change) => change.kind).sort(), ["deleted", "modified"]);
  assert.equal(accepted.outcome, "accepted");
  assert.doesNotMatch(JSON.stringify(accepted), /Service|Obsolete|GeneratedTest/);
  requireSpecificationChangeScopeAccepted(accepted);

  const addedOutside = await inspect(raw(entry("A", "src/Outside.ts")), specification, plan);
  assert.equal(addedOutside.outcome, "rejected-outside-allowlist");
  assert.throws(() => requireSpecificationChangeScopeAccepted(addedOutside), /sealed specification/);

  const excluded = await inspect(raw(entry("A", "database/migrations/2026_create.php")), specification, plan);
  assert.equal(excluded.outcome, "rejected-both");
  assert.equal(excluded.excludedPathCount, 1);
  const renamed = await inspect(raw(entry("D", "src/Obsolete.ts"), entry("A", "src/Renamed.ts")), specification, plan);
  assert.equal(renamed.productionChanges.length, 2);
  assert.equal(renamed.outcome, "rejected-outside-allowlist");

  for (const status of ["A", "M", "D", "T"] as const) {
    const result = await inspect(raw(entry(status, "src/Outside.ts")), specification, plan);
    assert.equal(result.productionChanges[0]?.kind, status === "A" ? "added" : status === "M" ? "modified" : status === "D" ? "deleted" : "type-changed");
    assert.notEqual(result.outcome, "accepted");
  }

  assert.throws(() => prepareSpecificationChangeScopePlan(fixtureSpec(["src/**"], [])), /wildcard/);
  assert.throws(() => prepareSpecificationChangeScopePlan(fixtureSpec(["../escape.ts"], [])), /escaped/);
  assert.throws(() => prepareSpecificationChangeScopePlan(fixtureSpec(["src/A.ts", "src/A.ts"], [])), /duplicate/);
  assert.throws(() => prepareSpecificationChangeScopePlan(fixtureSpec(["src/A.ts"], ["path:src/A.ts"])), /overlaps/);
  assert.throws(() => prepareSpecificationChangeScopePlan(fixtureSpec(["src/A.ts"], ["path-prefix:src/*"])), /wildcard/);
  assert.throws(() => prepareSpecificationChangeScopePlan(fixtureSpec(["src/A.ts"], ["path-prefix:src", "path:src/B.ts"])), /overlap/);
  assert.throws(() => prepareSpecificationChangeScopePlan(fixtureSpec(["src/A.ts"], ["duplicate", "duplicate"])), /duplicated/);

  assert.throws(() => assertSpecificationChangeScopePlan({ ...plan, extra: true }), /extended/);
  assert.throws(() => assertSpecificationChangeScopePlan({ ...plan, allowedPathIdentities: [] }), /malformed/);
  assert.throws(() => assertSpecificationChangeScopePlan({ ...plan, specificationScopeSha256: "0".repeat(64) }), /inconsistent/);
  assert.throws(() => assertSpecificationChangeScopeResult({ ...accepted, outcome: "rejected-exclusion" }, plan), /inconsistent/);
  assert.throws(() => assertSpecificationChangeScopeResult({ ...accepted, changeSetSha256: "0".repeat(64) }, plan), /inconsistent/);
  assert.throws(() => assertSpecificationChangeScopeResult({ ...accepted, extra: "builder-passing-result" }, plan), /extended/);
  await assert.rejects(inspect("malformed\0path\0", specification, plan), /malformed/);
  await assert.rejects(inspect(raw(entry("R100", "src/A.ts")), specification, plan), /unsupported/);
  await assert.rejects(inspect(raw(entry("A", "../escape.ts")), specification, plan), /escaped/);
  await assert.rejects(inspect(raw(entry("A", "src/Outside.ts"), entry("A", "src/Outside.ts")), specification, plan), /duplicate/);
  await assert.rejects(inspect("", specification, plan, new Set(), { exitCode: 1, stderr: "builder passing result" }), /unavailable/);

  const differentSpec = fixtureSpec(["src/Other.ts"], []);
  await assert.rejects(inspect("", differentSpec, plan), /does not match/);
});

async function inspect(
  stdout: string,
  specification: ImprovementSpec,
  plan: ReturnType<typeof prepareSpecificationChangeScopePlan>,
  ignoredPaths: ReadonlySet<string> = new Set(),
  overrides: { readonly exitCode?: number; readonly stderr?: string } = {},
) {
  const fakeRunner = {
    async run(command: readonly string[]) {
      assert.deepEqual(command, [
        "git", "diff", "--raw", "-z", "--abbrev=64", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--",
      ]);
      return { command, exitCode: overrides.exitCode ?? 0, stdout, stderr: overrides.stderr ?? "", durationMs: 1 };
    },
  } satisfies Pick<CommandRunner, "run">;
  return await inspectSpecificationChangeScope("/trusted/verifier", base, specification, ignoredPaths, plan, fakeRunner);
}

function raw(...entries: readonly string[]): string {
  return entries.join("");
}

function entry(status: "A" | "M" | "D" | "T" | "R100", path: string): string {
  const oldMode = status === "A" ? "000000" : "100644";
  const newMode = status === "D" ? "000000" : status === "T" ? "120000" : "100644";
  return `:${oldMode} ${newMode} ${"0".repeat(40)} ${"b".repeat(40)} ${status}\0${path}\0`;
}

function fixtureSpec(allowedFiles: readonly string[], exclusions: readonly string[]): ImprovementSpec {
  return {
    id: "spec-change-scope",
    improvementIntent: { schemaVersion: "improvement-intent/v1", intent: "maintainability", baselineProof: "maintainability-quality" },
    title: "Change scope",
    objective: "Change only authenticated production paths.",
    currentBehaviour: "Baseline",
    proposedImprovement: "Improved",
    allowedFiles,
    behavioursToPreserve: [],
    acceptanceCriteria: ["Scope is exact."],
    propertyInvariants: [],
    exclusions,
    verification: [],
    constraints: { maxFiles: 10, maxChangedLines: 100, maxCostUsd: 1 },
    evidence: ["deterministic"],
  };
}
