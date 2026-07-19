import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectPhpPublicApiSurface, preparePhpPublicApiSurface } from "../src/adapters/php-public-api-surface.js";
import {
  assertPublicApiSurfacePlan,
  assertPublicApiSurfaceResult,
  comparePublicApiSurfaces,
} from "../src/domain/public-api-surface.js";
import { CommandRunner } from "../src/infra/command-runner.js";
import { createVerifierCommandEnvironmentDecision, runVerifierCommand } from "../src/core/verifier-command-environment.js";

const plan = {
  schemaVersion: "public-api-surface-plan/v1",
  adapter: "php",
  tool: "phpprobe",
  configurationSha256: "a".repeat(64),
  targetScope: "composer-autoload",
  targetPaths: ["app"],
  command: ["vendor/bin/phpprobe", "api", "--public-only", "--format=json", "app"],
  timeoutMs: 120_000,
} as const;

test("validates exact bounded source-free public-API plans and results", () => {
  const validated = assertPublicApiSurfacePlan(plan);
  const result = assertPublicApiSurfaceResult(surface([]), validated);
  assert.deepEqual(result.symbols, []);
  assert.equal(JSON.stringify(result).includes("App\\Service"), false);
  assert.throws(() => assertPublicApiSurfacePlan(undefined), /malformed/);
  assert.throws(() => assertPublicApiSurfacePlan({ ...plan, extra: true }), /extended/);
  assert.throws(() => assertPublicApiSurfacePlan({ ...plan, schemaVersion: "public-api-surface-plan/v2" }), /unsupported/);
  assert.throws(() => assertPublicApiSurfacePlan({ ...plan, targetPaths: ["../app"] }), /escaped|malformed/);
  assert.throws(() => assertPublicApiSurfaceResult({ ...surface([]), extra: true }, validated), /extended/);
  assert.throws(() => assertPublicApiSurfaceResult({ ...surface([]), symbols: [{ identitySha256: "raw symbol", signatureSha256: "b".repeat(64) }] }, validated), /identity/);
});

test("accepts clean and additive-compatible surfaces", () => {
  assert.equal(comparePublicApiSurfaces(surface([]), surface([])).outcome, "clean");
  const existing = symbol("b", "c");
  const additive = comparePublicApiSurfaces(surface([existing]), surface([existing, symbol("d", "e")]));
  assert.deepEqual(additive, {
    schemaVersion: "public-api-surface-comparison/v1",
    adapter: "php",
    tool: "phpprobe",
    configurationSha256: "a".repeat(64),
    targetScope: "composer-autoload",
    targetPaths: ["app"],
    symbolIdentitySemantics: "phpprobe-public-symbol-id-fingerprint/v1",
    baselineSymbolCount: 1,
    currentSymbolCount: 2,
    addedSymbolCount: 1,
    outcome: "additive-compatible",
  });
});

test("rejects removed and signature-incompatible public symbols", () => {
  const existing = symbol("b", "c");
  assert.throws(() => comparePublicApiSurfaces(surface([existing]), surface([])), /removed/);
  assert.throws(() => comparePublicApiSurfaces(surface([existing]), surface([symbol("b", "d")])), /signature/);
  assert.throws(() => comparePublicApiSurfaces({ ...surface([existing]), tool: "other" }, surface([existing])), /incomparable/);
  assert.throws(() => comparePublicApiSurfaces({ ...surface([existing]), symbolIdentitySemantics: "other/v1" }, surface([existing])), /incomparable/);
});

test("PHP adapter runs manifest-declared PHPProbe in a clean verifier environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-public-api-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), root, { recursive: true });
  await chmod(join(root, "vendor/bin/phpprobe"), 0o755);
  const prepared = assertPublicApiSurfacePlan(await preparePhpPublicApiSurface(root));
  const execution = await runVerifierCommand(new CommandRunner(), createVerifierCommandEnvironmentDecision(process.env), prepared.command, root, prepared.timeoutMs);
  const result = assertPublicApiSurfaceResult(await inspectPhpPublicApiSurface(root, prepared, execution), prepared);
  assert.equal(result.tool, "phpprobe");
  assert.equal(result.symbols.length, 2);
  assert.equal(JSON.stringify(result).includes("MoneyAllocator"), false);
});

test("PHP adapter fails closed for unavailable tooling and malformed output", async () => {
  const missing = await mkdtemp(join(tmpdir(), "daily-improver-public-api-missing-"));
  await writeFile(join(missing, "composer.json"), JSON.stringify({ require: { php: "^8.2" }, autoload: { "psr-4": { "App\\": "app/" } } }));
  await assert.rejects(preparePhpPublicApiSurface(missing), /required verifier public-api-surface is unavailable/i);

  const unavailable = await mkdtemp(join(tmpdir(), "daily-improver-public-api-unavailable-"));
  await writeFile(join(unavailable, "composer.json"), JSON.stringify({
    "require-dev": { "infocyph/phpprobe": "^0.4" },
    autoload: { "psr-4": { "App\\": "app/" } },
  }));
  await assert.rejects(preparePhpPublicApiSurface(unavailable), /ENOENT|unavailable/);

  const malformedScope = await mkdtemp(join(tmpdir(), "daily-improver-public-api-scope-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), malformedScope, { recursive: true });
  await writeFile(join(malformedScope, "composer.json"), JSON.stringify({
    "require-dev": { "infocyph/phpprobe": "^0.4" },
    autoload: { "psr-4": { "App\\": 42 } },
  }));
  await assert.rejects(preparePhpPublicApiSurface(malformedScope), /autoload mapping is malformed/);

  const root = await mkdtemp(join(tmpdir(), "daily-improver-public-api-malformed-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), root, { recursive: true });
  const prepared = await preparePhpPublicApiSurface(root);
  await assert.rejects(inspectPhpPublicApiSurface(root, prepared, { exitCode: 0, durationMs: 1, stdout: "not-json", stderr: "" }), /malformed/);
});

function symbol(identity: string, signature: string) {
  return { identitySha256: identity.repeat(64), signatureSha256: signature.repeat(64) };
}

function surface(symbols: readonly { readonly identitySha256: string; readonly signatureSha256: string }[]) {
  return {
    schemaVersion: "public-api-surface-result/v1" as const,
    adapter: "php",
    tool: "phpprobe",
    configurationSha256: "a".repeat(64),
    targetScope: "composer-autoload" as const,
    targetPaths: ["app"],
    outcome: "completed" as const,
    symbolIdentitySemantics: "phpprobe-public-symbol-id-fingerprint/v1",
    symbols,
    durationMs: 10,
    stdoutSha256: "f".repeat(64),
    stderrSha256: "0".repeat(64),
  };
}
