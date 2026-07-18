import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  inspectPhpBroadExceptionSwallowing,
  preparePhpBroadExceptionSwallowing,
} from "../src/adapters/php-broad-exception-swallowing.js";
import {
  assertBroadExceptionSwallowingPlan,
  assertBroadExceptionSwallowingResult,
  broadExceptionSwallowingHash,
  compareBroadExceptionSwallowing,
  type BroadExceptionSwallowingHazard,
} from "../src/domain/broad-exception-swallowing.js";

const plan = {
  schemaVersion: "broad-exception-swallowing-plan/v1",
  adapter: "php",
  policySha256: "a".repeat(64),
  targetScope: "adapter-production-sources",
  targetPaths: ["app", "src"],
} as const;

test("validates exact bounded source-free broad exception-swallowing plans and results", () => {
  const validated = assertBroadExceptionSwallowingPlan(plan);
  const result = assertBroadExceptionSwallowingResult(inventory([]), validated);
  assert.deepEqual(result.hazards, []);
  assert.throws(() => assertBroadExceptionSwallowingPlan(undefined), /malformed/);
  assert.throws(() => assertBroadExceptionSwallowingPlan({ ...plan, extra: true }), /extended/);
  assert.throws(() => assertBroadExceptionSwallowingPlan({ ...plan, schemaVersion: "broad-exception-swallowing-plan/v2" }), /unsupported/);
  assert.throws(() => assertBroadExceptionSwallowingPlan({ ...plan, targetPaths: ["../app"] }), /escaped|malformed/);
  assert.throws(() => assertBroadExceptionSwallowingResult({ ...inventory([]), extra: true }, validated), /extended/);
  assert.throws(() => assertBroadExceptionSwallowingResult(inventory([{ kind: "discarded", identitySha256: "raw source" }]), validated), /identity/);
  assert.throws(() => assertBroadExceptionSwallowingResult({ ...inventory([]), inventorySha256: "f".repeat(64) }, validated), /inconsistent/);
});

test("accepts unchanged and removed broad exception-swallowing hazards", () => {
  const discarded = hazard("discarded", "b");
  const defaultReturn = hazard("default-return", "c");
  const baseline = inventory([discarded, defaultReturn]);
  assert.equal(compareBroadExceptionSwallowing(baseline, baseline).outcome, "unchanged");
  assert.deepEqual(compareBroadExceptionSwallowing(baseline, inventory([discarded])), {
    schemaVersion: "broad-exception-swallowing-comparison/v1",
    adapter: "php",
    policySha256: "a".repeat(64),
    targetScope: "adapter-production-sources",
    targetPaths: ["app", "src"],
    hazardIdentitySemantics: "php-broad-catch-handler-fingerprint/v1",
    baselineHazardCount: 2,
    currentHazardCount: 1,
    removedHazardCount: 1,
    outcome: "removed",
  });
});

test("rejects newly introduced discarded, default-return, and hidden broad catches", () => {
  for (const kind of ["discarded", "default-return", "hidden"] as const) {
    assert.throws(
      () => compareBroadExceptionSwallowing(inventory([]), inventory([hazard(kind, kind[0] ?? "d")])),
      new RegExp(kind),
    );
  }
  assert.throws(
    () => compareBroadExceptionSwallowing({ ...inventory([]), policySha256: "d".repeat(64) }, inventory([])),
    /incomparable/,
  );
  assert.throws(
    () => compareBroadExceptionSwallowing(inventory([], "other/v1"), inventory([])),
    /incomparable/,
  );
});

test("PHP adapter inventories broad swallowed catches without retaining source details", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-broad-catches-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), root, { recursive: true });
  await writeFile(join(root, "app", "Legacy.php"), `<?php
function discarded(): void {
    try { risky(); } catch (\\Throwable $failure) { }
}
function defaulted(): mixed {
    try { return risky(); } catch (\\Exception $failure) { return false; }
}
function hidden(): void {
    try { risky(); } catch (\\Throwable) { cleanup(); }
}
function reported(): void {
    try { risky(); } catch (\\Throwable $failure) { report($failure); }
}
function propagated(): void {
    try { risky(); } catch (\\Exception $failure) { throw $failure; }
}
$text = 'catch (\\Throwable $failure) { return false; }';
$heredoc = <<<'TEXT'
catch (\\Throwable $failure) { return false; }
TEXT;
// catch (\\Exception $failure) { }
`);
  const prepared = assertBroadExceptionSwallowingPlan(await preparePhpBroadExceptionSwallowing());
  const result = assertBroadExceptionSwallowingResult(
    await inspectPhpBroadExceptionSwallowing(root, prepared),
    prepared,
  );
  assert.deepEqual(result.hazards.map((hazard) => hazard.kind).sort(), ["default-return", "discarded", "hidden"]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Legacy|failure|cleanup|risky|Throwable|Exception/);
});

function hazard(kind: BroadExceptionSwallowingHazard["kind"], seed: string): BroadExceptionSwallowingHazard {
  return { kind, identitySha256: broadExceptionSwallowingHash(seed) };
}

function inventory(
  hazards: readonly BroadExceptionSwallowingHazard[],
  hazardIdentitySemantics = "php-broad-catch-handler-fingerprint/v1",
) {
  const sorted = [...hazards].sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  return {
    schemaVersion: "broad-exception-swallowing-result/v1" as const,
    adapter: "php",
    policySha256: "a".repeat(64),
    targetScope: "adapter-production-sources" as const,
    targetPaths: ["app", "src"],
    hazardIdentitySemantics,
    hazards,
    inventorySha256: broadExceptionSwallowingHash(JSON.stringify([hazardIdentitySemantics, sorted])),
  };
}
