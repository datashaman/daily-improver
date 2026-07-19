import assert from "node:assert/strict";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  inspectPhpValidationBoundaries,
  preparePhpValidationBoundaries,
} from "../src/adapters/php-validation-boundaries.js";
import {
  assertValidationBoundaryPlan,
  assertValidationBoundaryResult,
  compareValidationBoundaries,
  validationBoundaryHash,
  type ValidationBoundary,
} from "../src/domain/validation-boundaries.js";

const plan = {
  schemaVersion: "validation-boundary-plan/v1",
  adapter: "php",
  policySha256: "a".repeat(64),
  targetScope: "adapter-production-sources",
  targetPaths: ["app", "src"],
} as const;

test("validates exact bounded source-free validation-boundary plans and results", () => {
  const validated = assertValidationBoundaryPlan(plan);
  const result = assertValidationBoundaryResult(inventory([], []), validated);
  assert.deepEqual(result.boundaries, []);
  assert.throws(() => assertValidationBoundaryPlan(undefined), /malformed/);
  assert.throws(() => assertValidationBoundaryPlan({ ...plan, extra: true }), /extended/);
  assert.throws(() => assertValidationBoundaryPlan({ ...plan, schemaVersion: "validation-boundary-plan/v2" }), /unsupported/);
  assert.throws(() => assertValidationBoundaryPlan({ ...plan, targetPaths: ["../app"] }), /escaped|malformed/);
  assert.throws(() => assertValidationBoundaryResult({ ...inventory([], []), extra: true }, validated), /extended/);
  assert.throws(
    () => assertValidationBoundaryResult(inventory([{ identitySha256: "raw boundary", guarantees: [] }], []), validated),
    /identity/,
  );
  assert.throws(
    () => assertValidationBoundaryResult(inventory([boundary("b", [{ identitySha256: hash("g"), strength: 0 }])], []), validated),
    /strength/,
  );
  assert.throws(
    () => assertValidationBoundaryResult({ ...inventory([], []), inventorySha256: "f".repeat(64) }, validated),
    /inconsistent/,
  );
});

test("accepts unchanged and strengthened validation contracts", () => {
  const baseline = inventory([boundary("b", [{ identitySha256: hash("required"), strength: 3 }])], [hash("legacy-flow")]);
  assert.equal(compareValidationBoundaries(baseline, baseline).outcome, "unchanged");
  const strengthened = inventory([boundary("b", [
    { identitySha256: hash("required"), strength: 4 },
    { identitySha256: hash("integer"), strength: 1 },
  ])], []);
  const comparison = compareValidationBoundaries(baseline, strengthened);
  assert.equal(comparison.outcome, "strengthened");
  assert.equal(comparison.baselineGuaranteeCount, 1);
  assert.equal(comparison.currentGuaranteeCount, 2);
  assert.equal(comparison.currentUnvalidatedFlowCount, 0);
  assert.equal(compareValidationBoundaries(inventory([], []), inventory([], [])).outcome, "clean");
});

test("rejects removed boundaries, weakened guarantees, new unvalidated flows, and incomparable semantics", () => {
  const baseline = inventory([boundary("b", [{ identitySha256: hash("minimum"), strength: 5 }])], []);
  assert.throws(() => compareValidationBoundaries(baseline, inventory([], [])), /removed a validation boundary/);
  assert.throws(
    () => compareValidationBoundaries(baseline, inventory([boundary("b", [{ identitySha256: hash("minimum"), strength: 3 }])], [])),
    /weakened a validation contract/,
  );
  assert.throws(
    () => compareValidationBoundaries(inventory([], []), inventory([], [hash("new-flow")])),
    /unvalidated input flow/,
  );
  assert.throws(
    () => compareValidationBoundaries({ ...inventory([], []), policySha256: "d".repeat(64) }, inventory([], [])),
    /incomparable/,
  );
  assert.throws(
    () => compareValidationBoundaries(inventory([], [], "other/v1"), inventory([], [])),
    /incomparable/,
  );
});

test("PHP adapter inventories unchanged, strengthened, and unvalidated Laravel input flows without retaining contract details", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-validation-boundaries-"));
  await cp(resolve("test/fixtures/laravel-money-allocator"), root, { recursive: true });
  const requestPath = join(root, "app", "StoreAllocationRequest.php");
  await writeFile(requestPath, phpSource("required|integer|min:2|max:100", false));
  const prepared = assertValidationBoundaryPlan(await preparePhpValidationBoundaries());
  const baseline = assertValidationBoundaryResult(await inspectPhpValidationBoundaries(root, prepared), prepared);
  assert.equal(baseline.boundaries.length, 2);
  assert.equal(baseline.unvalidatedFlowIdentities.length, 0);
  assert.equal(compareValidationBoundaries(baseline, baseline).outcome, "unchanged");

  await writeFile(requestPath, phpSource("required|integer|min:3|max:50", false));
  const strengthened = assertValidationBoundaryResult(await inspectPhpValidationBoundaries(root, prepared), prepared);
  assert.equal(compareValidationBoundaries(baseline, strengthened).outcome, "strengthened");

  await writeFile(requestPath, phpSource("required|integer|min:1|max:200", false));
  const weakened = assertValidationBoundaryResult(await inspectPhpValidationBoundaries(root, prepared), prepared);
  assert.throws(() => compareValidationBoundaries(strengthened, weakened), /weakened a validation contract/);

  await writeFile(requestPath, phpSource("required|nullable|integer|min:3|max:50", false));
  const nullable = assertValidationBoundaryResult(await inspectPhpValidationBoundaries(root, prepared), prepared);
  assert.throws(() => compareValidationBoundaries(strengthened, nullable), /weakened a validation contract/);

  await writeFile(requestPath, phpSource("required|integer|min:3|max:50", true));
  const unvalidated = assertValidationBoundaryResult(await inspectPhpValidationBoundaries(root, prepared), prepared);
  assert.equal(unvalidated.unvalidatedFlowIdentities.length, 1);
  assert.throws(() => compareValidationBoundaries(strengthened, unvalidated), /unvalidated input flow/);

  const serialized = JSON.stringify(strengthened);
  assert.doesNotMatch(serialized, /StoreAllocationRequest|amount|integer|required|\bmin\b|\bmax\b/iu);
});

function phpSource(contract: string, unvalidated: boolean): string {
  return `<?php
namespace App\\Http\\Requests;

use Illuminate\\Foundation\\Http\\FormRequest;
use Illuminate\\Http\\Request;

final class StoreAllocationRequest extends FormRequest
{
    public function rules(): array
    {
        return ['amount' => '${contract}'];
    }

    public function store(Request $request): void
    {
        $validated = $request->validate(['amount' => '${contract}']);
        $model = new Allocation();
        $model->fill(${unvalidated ? "$request->all()" : "$validated"});
    }
}
`;
}

function boundary(seed: string, guarantees: ValidationBoundary["guarantees"]): ValidationBoundary {
  return { identitySha256: hash(seed), guarantees };
}

function hash(seed: string): string {
  return validationBoundaryHash(seed);
}

function inventory(
  boundaries: readonly ValidationBoundary[],
  unvalidatedFlowIdentities: readonly string[],
  boundaryIdentitySemantics = "php-validation-boundary-context/v1",
) {
  const sortedBoundaries = [...boundaries].map((boundary) => ({
    ...boundary,
    guarantees: [...boundary.guarantees].sort((left, right) => left.identitySha256.localeCompare(right.identitySha256)),
  })).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  const sortedFlows = [...unvalidatedFlowIdentities].sort();
  const guaranteeIdentitySemantics = "php-validation-guarantee-strength/v1";
  const unvalidatedFlowIdentitySemantics = "php-request-mass-assignment-flow/v1";
  return {
    schemaVersion: "validation-boundary-result/v1" as const,
    adapter: "php",
    policySha256: "a".repeat(64),
    targetScope: "adapter-production-sources" as const,
    targetPaths: ["app", "src"],
    boundaryIdentitySemantics,
    guaranteeIdentitySemantics,
    unvalidatedFlowIdentitySemantics,
    boundaries,
    unvalidatedFlowIdentities,
    inventorySha256: validationBoundaryHash(JSON.stringify([
      boundaryIdentitySemantics,
      guaranteeIdentitySemantics,
      unvalidatedFlowIdentitySemantics,
      sortedBoundaries,
      sortedFlows,
    ])),
  };
}
