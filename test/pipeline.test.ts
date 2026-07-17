import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "../src/app.js";

test("pipeline creates and persists an approved language-specific plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-repo-"));
  const state = await mkdtemp(join(tmpdir(), "daily-improver-state-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" }, "require-dev": { "phpunit/phpunit": "^12" },
  }));
  const app = createApplication(state);
  const run = await app.pipeline.plan(root);
  assert.equal(run.adapter, "php");
  assert.equal(run.status, "planned");
  assert.equal((await app.store.list(root)).length, 1);
});

test("pipeline rejects work that exceeds its cost budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-repo-"));
  const state = await mkdtemp(join(tmpdir(), "daily-improver-state-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({ require: { php: "^8.3" } }));
  const run = await createApplication(state).pipeline.plan(root, { maxCostUsd: 2, estimatedCostUsd: 3 });
  assert.equal(run.status, "rejected");
  assert.equal(run.policyDecisions.find((decision) => decision.policy === "cost-budget")?.allowed, false);
});
