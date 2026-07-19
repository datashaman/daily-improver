import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertProtectedRepositoryChangePlan,
  assertProtectedRepositoryChangeResult,
  compareProtectedRepositoryChanges,
  protectedRepositoryChangeHash,
  protectedRepositoryClassifications,
  type ProtectedRepositoryChangeResult,
} from "../src/domain/protected-repository-changes.js";
import {
  inspectProtectedRepositoryChanges,
  prepareProtectedRepositoryChangePlan,
} from "../src/core/protected-repository-changes.js";
import { CommandRunner } from "../src/infra/command-runner.js";

const plan = prepareProtectedRepositoryChangePlan();

test("validates exact bounded source-free protected repository-change contracts", () => {
  const validated = assertProtectedRepositoryChangePlan(plan);
  const empty = inventory([]);
  assertProtectedRepositoryChangeResult(empty, validated);
  assert.throws(() => assertProtectedRepositoryChangePlan(undefined), /malformed/);
  assert.throws(() => assertProtectedRepositoryChangePlan({ ...plan, extra: true }), /extended/);
  assert.throws(() => assertProtectedRepositoryChangePlan({ ...plan, policySha256: "raw" }), /identity/);
  assert.throws(() => assertProtectedRepositoryChangePlan({ ...plan, classifications: ["dependency"] }), /incomplete|unsupported/);
  assert.throws(() => assertProtectedRepositoryChangeResult({ ...empty, extra: true }, validated), /extended/);
  assert.throws(() => assertProtectedRepositoryChangeResult({ ...empty, inventorySha256: "f".repeat(64) }, validated), /inconsistent/);
  assert.throws(() => assertProtectedRepositoryChangeResult(inventory([{
    classification: "dependency",
    pathIdentitySha256: "raw path",
    contentIdentitySha256: digest("content"),
    entryType: "regular-file",
    sizeBytes: 1,
  }]), validated), /identity/);
});

test("accepts only an unchanged dependency, migration, workflow, and generated-binary inventory", () => {
  const baseline = inventory(protectedRepositoryClassifications.map((classification, index) => ({
    classification,
    pathIdentitySha256: digest(`${classification}-path`),
    contentIdentitySha256: digest(`${classification}-content`),
    entryType: "regular-file" as const,
    sizeBytes: index + 1,
  })));
  assert.equal(compareProtectedRepositoryChanges(inventory([]), inventory([])).outcome, "clean");
  assert.deepEqual(compareProtectedRepositoryChanges(baseline, baseline), {
    schemaVersion: "protected-repository-change-comparison/v1",
    policyId: "repository-protected-change-policy/v1",
    policySha256: plan.policySha256,
    classifications: protectedRepositoryClassifications,
    identitySemantics: "repository-relative-path-and-content/v1",
    baselineEntryCount: 4,
    currentEntryCount: 4,
    outcome: "unchanged",
  });
  for (const classification of protectedRepositoryClassifications) {
    const modified = inventory(baseline.entries.map((entry) => entry.classification === classification
      ? { ...entry, contentIdentitySha256: digest(`${classification}-modified`) }
      : entry));
    assert.throws(() => compareProtectedRepositoryChanges(baseline, modified), new RegExp(classification));
  }
  assert.throws(() => compareProtectedRepositoryChanges(baseline, inventory(baseline.entries.slice(1))), /dependency/);
  assert.throws(() => compareProtectedRepositoryChanges(baseline, inventory([
    ...baseline.entries,
    { ...baseline.entries[0]!, pathIdentitySha256: digest("added-path") },
  ])), /dependency/);
  assert.throws(() => compareProtectedRepositoryChanges(baseline, inventory([
    { ...baseline.entries[0]!, entryType: "symbolic-link" }, ...baseline.entries.slice(1),
  ])), /dependency/);
  assert.throws(() => compareProtectedRepositoryChanges(baseline, inventory([
    { ...baseline.entries[0]!, classification: "migration" }, ...baseline.entries.slice(1),
  ])), /dependency|migration/);
  assert.throws(() => compareProtectedRepositoryChanges(baseline, {
    ...baseline,
    policySha256: "b".repeat(64),
    inventorySha256: protectedRepositoryChangeHash(JSON.stringify([
      baseline.identitySemantics, baseline.classifications, baseline.entries,
    ])),
  }), /incomparable|inconsistent/);
});

test("inventories conventional protected paths and opaque generated binaries without retaining bodies or paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-protected-repository-"));
  const runner = new CommandRunner();
  try {
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await mkdir(join(root, "database", "migrations"), { recursive: true });
    await mkdir(join(root, "public", "build"), { recursive: true });
    await writeFile(join(root, "composer.lock"), "dependency-secret");
    await writeFile(join(root, "database", "migrations", "001_create.php"), "migration-secret");
    await writeFile(join(root, ".github", "workflows", "verify.yml"), "workflow-secret");
    await writeFile(join(root, "public", "build", "asset.bin"), Buffer.from([0, 1, 2, 3]));
    await git(runner, root, ["init"]);
    await git(runner, root, ["add", "."]);
    await git(runner, root, ["-c", "user.name=Daily Improver", "-c", "user.email=daily@example.invalid", "commit", "-m", "baseline"]);
    const validatedPlan = assertProtectedRepositoryChangePlan(plan);
    const baseline = assertProtectedRepositoryChangeResult(
      await inspectProtectedRepositoryChanges(root, validatedPlan, runner),
      validatedPlan,
    );
    assert.deepEqual(baseline.entries.map((entry) => entry.classification).sort(), [...protectedRepositoryClassifications]);
    assert.doesNotMatch(JSON.stringify(baseline), /composer\.lock|001_create|verify\.yml|asset\.bin|secret/);

    const changes: readonly [string, () => Promise<void>, RegExp][] = [
      ["dependency", async () => await writeFile(join(root, "composer.lock"), "changed"), /dependency/],
      ["migration", async () => await rename(
        join(root, "database", "migrations", "001_create.php"),
        join(root, "database", "migrations", "002_create.php"),
      ), /migration/],
      ["workflow", async () => {
        await rm(join(root, ".github", "workflows", "verify.yml"));
        await symlink("elsewhere.yml", join(root, ".github", "workflows", "verify.yml"));
      }, /workflow/],
      ["generated-binary", async () => await writeFile(join(root, "public", "build", "asset.bin"), Buffer.from([0, 9, 9])), /generated-binary/],
    ];
    for (const [name, mutate, expected] of changes) {
      await git(runner, root, ["reset", "--hard", "HEAD"]);
      await git(runner, root, ["clean", "-fd"]);
      await mutate();
      const current = assertProtectedRepositoryChangeResult(
        await inspectProtectedRepositoryChanges(root, validatedPlan, runner),
        validatedPlan,
      );
      assert.throws(() => compareProtectedRepositoryChanges(baseline, current), expected, name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function inventory(entries: ProtectedRepositoryChangeResult["entries"]): ProtectedRepositoryChangeResult {
  const sorted = [...entries].sort((left, right) => left.classification.localeCompare(right.classification)
    || left.pathIdentitySha256.localeCompare(right.pathIdentitySha256));
  const identitySemantics = "repository-relative-path-and-content/v1" as const;
  return {
    schemaVersion: "protected-repository-change-result/v1",
    policyId: plan.policyId,
    policySha256: plan.policySha256,
    classifications: protectedRepositoryClassifications,
    identitySemantics,
    entries: sorted,
    inventorySha256: protectedRepositoryChangeHash(JSON.stringify([identitySemantics, protectedRepositoryClassifications, sorted])),
  };
}

function digest(value: string): string {
  return protectedRepositoryChangeHash(value);
}

async function git(runner: CommandRunner, root: string, args: readonly string[]): Promise<void> {
  const result = await runner.run(["git", ...args], root);
  assert.equal(result.exitCode, 0, result.stderr);
}
