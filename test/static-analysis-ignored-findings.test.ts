import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  inspectPhpStaticAnalysisIgnoredFindings,
  preparePhpStaticAnalysisIgnoredFindings,
} from "../src/adapters/php-static-analysis-ignored-findings.js";
import {
  assertStaticAnalysisIgnoredFindingsPlan,
  assertStaticAnalysisIgnoredFindingsResult,
  compareStaticAnalysisIgnoredFindings,
  staticAnalysisIgnoredFindingHash,
  type StaticAnalysisIgnoreMechanism,
} from "../src/domain/static-analysis-ignored-findings.js";

const plan = {
  schemaVersion: "static-analysis-ignored-findings-plan/v1",
  adapter: "php",
  tool: "phpstan",
  configurationSha256: "a".repeat(64),
  targetScope: "repository-configured",
} as const;

test("validates exact bounded source-free ignored-finding plans and results", () => {
  const validated = assertStaticAnalysisIgnoredFindingsPlan(plan);
  const result = assertStaticAnalysisIgnoredFindingsResult(inventory([]), validated);
  assert.deepEqual(result.ignoredFindings, []);
  assert.equal(JSON.stringify(result).includes("@phpstan-ignore"), false);
  assert.throws(() => assertStaticAnalysisIgnoredFindingsPlan(undefined), /malformed/);
  assert.throws(() => assertStaticAnalysisIgnoredFindingsPlan({ ...plan, extra: true }), /extended/);
  assert.throws(() => assertStaticAnalysisIgnoredFindingsPlan({ ...plan, schemaVersion: "static-analysis-ignored-findings-plan/v2" }), /unsupported/);
  assert.throws(() => assertStaticAnalysisIgnoredFindingsResult({ ...inventory([]), extra: true }, validated), /extended/);
  assert.throws(() => assertStaticAnalysisIgnoredFindingsResult(inventory([{ mechanism: "inline-directive", identitySha256: "raw directive" }]), validated), /identity/);
  assert.throws(() => assertStaticAnalysisIgnoredFindingsResult({ ...inventory([]), inventorySha256: "f".repeat(64) }, validated), /inconsistent/);
});

test("accepts unchanged and removed ignored findings", () => {
  const inline = ignored("inline-directive", "b");
  const baseline = inventory([inline]);
  assert.equal(compareStaticAnalysisIgnoredFindings(baseline, baseline).outcome, "unchanged");
  assert.deepEqual(compareStaticAnalysisIgnoredFindings(baseline, inventory([])), {
    schemaVersion: "static-analysis-ignored-findings-comparison/v1",
    adapter: "php",
    tool: "phpstan",
    configurationSha256: "a".repeat(64),
    targetScope: "repository-configured",
    ignoredFindingIdentitySemantics: "php-static-analysis-ignore-inventory/v1",
    baselineIgnoredFindingCount: 1,
    currentIgnoredFindingCount: 0,
    removedIgnoredFindingCount: 1,
    outcome: "removed",
  });
});

test("rejects newly introduced directives, baseline entries, and equivalent configuration suppressions", () => {
  for (const mechanism of ["inline-directive", "baseline-entry", "configuration-suppression"] as const) {
    assert.throws(
      () => compareStaticAnalysisIgnoredFindings(inventory([]), inventory([{
        mechanism,
        identitySha256: staticAnalysisIgnoredFindingHash(mechanism),
      }])),
      new RegExp(mechanism),
    );
  }
  assert.throws(
    () => compareStaticAnalysisIgnoredFindings({ ...inventory([]), tool: "psalm" }, inventory([])),
    /incomparable/,
  );
  assert.throws(
    () => compareStaticAnalysisIgnoredFindings(inventory([], "other/v1"), inventory([])),
    /incomparable/,
  );
});

test("PHP adapter inventories supported suppressions without retaining their text or paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-static-ignores-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), root, { recursive: true });
  await chmod(join(root, "vendor/bin/phpstan"), 0o755);
  await writeFile(join(root, "phpstan.neon"), [
    "parameters:",
    "  ignoreErrors:",
    "    -",
    "      identifier: missingType.iterableValue",
    "      path: app/Legacy.php",
  ].join("\n"));
  await writeFile(join(root, "app", "Legacy.php"), "<?php\n$example = '@phpstan-ignore-line must-not-count';\n$heredoc = <<<'TEXT'\n@phpstan-ignore-line must-not-count\nTEXT;\n// @phpstan-ignore-next-line missingType.iterableValue\nlegacy();\n");
  const prepared = assertStaticAnalysisIgnoredFindingsPlan(await preparePhpStaticAnalysisIgnoredFindings(root));
  const result = assertStaticAnalysisIgnoredFindingsResult(
    await inspectPhpStaticAnalysisIgnoredFindings(root, prepared),
    prepared,
  );
  assert.deepEqual(result.ignoredFindings.map((item) => item.mechanism).sort(), ["configuration-suppression", "inline-directive"]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /missingType|Legacy|phpstan-ignore/);
});

test("PHP adapter inventories Psalm directives and independent issue-handler suppressions", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-psalm-ignores-"));
  await mkdir(join(root, "vendor", "bin"), { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "composer.json"), JSON.stringify({ "require-dev": { "vimeo/psalm": "^6.0" } }));
  await writeFile(join(root, "vendor", "bin", "psalm"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(root, "psalm.xml"), [
    "<psalm>",
    "  <issueHandlers>",
    "    <MissingReturnType errorLevel=\"suppress\" />",
    "    <PossiblyNullReference>",
    "      <errorLevel type=\"suppress\"><directory name=\"src\" /></errorLevel>",
    "    </PossiblyNullReference>",
    "  </issueHandlers>",
    "</psalm>",
  ].join("\n"));
  await writeFile(join(root, "src", "Legacy.php"), "<?php\n/** @psalm-suppress MixedAssignment */\n$legacy = source();\n");
  const prepared = assertStaticAnalysisIgnoredFindingsPlan(await preparePhpStaticAnalysisIgnoredFindings(root));
  const result = assertStaticAnalysisIgnoredFindingsResult(
    await inspectPhpStaticAnalysisIgnoredFindings(root, prepared),
    prepared,
  );
  assert.deepEqual(result.ignoredFindings.map((item) => item.mechanism).sort(), [
    "configuration-suppression",
    "configuration-suppression",
    "inline-directive",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /MissingReturnType|PossiblyNull|MixedAssignment|Legacy/);
});

function ignored(mechanism: StaticAnalysisIgnoreMechanism, seed: string) {
  return { mechanism, identitySha256: seed.repeat(64) };
}

function inventory(
  ignoredFindings: readonly { readonly mechanism: StaticAnalysisIgnoreMechanism; readonly identitySha256: string }[],
  ignoredFindingIdentitySemantics = "php-static-analysis-ignore-inventory/v1",
) {
  return {
    schemaVersion: "static-analysis-ignored-findings-result/v1" as const,
    adapter: "php",
    tool: "phpstan",
    configurationSha256: "a".repeat(64),
    targetScope: "repository-configured" as const,
    ignoredFindingIdentitySemantics,
    ignoredFindings,
    inventorySha256: staticAnalysisIgnoredFindingHash(JSON.stringify([
      ignoredFindingIdentitySemantics,
      [...ignoredFindings].sort((left, right) => left.identitySha256.localeCompare(right.identitySha256)),
    ])),
  };
}
