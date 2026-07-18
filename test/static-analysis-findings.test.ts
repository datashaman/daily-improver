import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectPhpVerifierStaticAnalysis, preparePhpVerifierStaticAnalysis } from "../src/adapters/php-verifier-static-analysis.js";
import {
  assertStaticAnalysisPlan,
  assertStaticAnalysisResult,
  compareStaticAnalysisFindings,
} from "../src/domain/static-analysis-findings.js";
import { CommandRunner } from "../src/infra/command-runner.js";
import { createVerifierCommandEnvironmentDecision, runVerifierCommand } from "../src/core/verifier-command-environment.js";

const plan = {
  schemaVersion: "static-analysis-plan/v1",
  adapter: "php",
  tool: "phpstan",
  configurationSha256: "a".repeat(64),
  targetScope: "repository-configured",
  command: ["vendor/bin/phpstan", "analyse", "--error-format=json"],
  timeoutMs: 120_000,
} as const;

test("validates exact bounded source-free static-analysis plans and results", () => {
  const validated = assertStaticAnalysisPlan(plan);
  const result = assertStaticAnalysisResult(staticResult([]), validated);
  assert.deepEqual(result.findingIdentities, []);
  assert.equal(JSON.stringify(result).includes("raw finding excerpt"), false);
  assert.throws(() => assertStaticAnalysisPlan(undefined), /malformed/);
  assert.throws(() => assertStaticAnalysisPlan({ ...plan, extra: true }), /extended/);
  assert.throws(() => assertStaticAnalysisPlan({ ...plan, schemaVersion: "static-analysis-plan/v2" }), /unsupported/);
  assert.throws(() => assertStaticAnalysisResult({ ...staticResult([]), extra: true }, validated), /extended/);
  assert.throws(() => assertStaticAnalysisResult({ ...staticResult([]), findingIdentities: ["raw finding"] }, validated), /identity/);
});

test("compares clean, improved, and unchanged findings and rejects regressions", () => {
  assert.equal(compareStaticAnalysisFindings(staticResult([]), staticResult([])).outcome, "clean");
  const finding = "b".repeat(64);
  const improved = compareStaticAnalysisFindings(staticResult([finding]), staticResult([]));
  assert.deepEqual(improved, {
    schemaVersion: "static-analysis-findings-comparison/v1",
    adapter: "php",
    tool: "phpstan",
    configurationSha256: "a".repeat(64),
    targetScope: "repository-configured",
    findingIdentitySemantics: "php-static-analysis-path-rule-message/v1",
    baselineFindingCount: 1,
    currentFindingCount: 0,
    resolvedFindingCount: 1,
    outcome: "improved",
  });
  assert.equal(compareStaticAnalysisFindings(staticResult([finding]), staticResult([finding])).outcome, "unchanged");
  assert.throws(() => compareStaticAnalysisFindings(staticResult([]), staticResult([finding])), /introduced new findings/);
  assert.throws(() => compareStaticAnalysisFindings({ ...staticResult([]), tool: "psalm" }, staticResult([])), /incomparable/);
  assert.throws(() => compareStaticAnalysisFindings({ ...staticResult([]), configurationSha256: "c".repeat(64) }, staticResult([])), /incomparable/);
  assert.throws(() => compareStaticAnalysisFindings({ ...staticResult([]), findingIdentitySemantics: "other/v1" }, staticResult([])), /incomparable/);
});

test("PHP adapter runs the manifest-selected analyzer in a clean verifier environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-static-analysis-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), root, { recursive: true });
  await chmod(join(root, "vendor/bin/phpstan"), 0o755);
  const prepared = assertStaticAnalysisPlan(await preparePhpVerifierStaticAnalysis(root));
  const execution = await runVerifierCommand(new CommandRunner(), createVerifierCommandEnvironmentDecision(process.env), prepared.command, root, prepared.timeoutMs);
  const result = assertStaticAnalysisResult(await inspectPhpVerifierStaticAnalysis(root, prepared, execution), prepared);
  assert.equal(result.tool, "phpstan");
  assert.deepEqual(result.findingIdentities, []);
});

test("PHP adapter fails closed when tooling is unavailable or output is malformed", async () => {
  const missing = await mkdtemp(join(tmpdir(), "daily-improver-static-missing-"));
  await writeFile(join(missing, "composer.json"), JSON.stringify({ require: { php: "^8.2" } }));
  await assert.rejects(preparePhpVerifierStaticAnalysis(missing), /not manifest-declared/);

  const unavailable = await mkdtemp(join(tmpdir(), "daily-improver-static-unavailable-"));
  await writeFile(join(unavailable, "composer.json"), JSON.stringify({ "require-dev": { "phpstan/phpstan": "^2.0" } }));
  await assert.rejects(preparePhpVerifierStaticAnalysis(unavailable), /ENOENT|unavailable/);

  const root = await mkdtemp(join(tmpdir(), "daily-improver-static-malformed-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), root, { recursive: true });
  const prepared = await preparePhpVerifierStaticAnalysis(root);
  await assert.rejects(inspectPhpVerifierStaticAnalysis(root, prepared, { exitCode: 2, durationMs: 1, stdout: "not-json", stderr: "" }), /malformed/);
});

function staticResult(findingIdentities: readonly string[]) {
  return {
    schemaVersion: "static-analysis-result/v1" as const,
    adapter: "php",
    tool: "phpstan",
    configurationSha256: "a".repeat(64),
    targetScope: "repository-configured" as const,
    outcome: "completed" as const,
    findingIdentitySemantics: "php-static-analysis-path-rule-message/v1",
    findingIdentities,
    durationMs: 10,
    stdoutSha256: "c".repeat(64),
    stderrSha256: "d".repeat(64),
  };
}
