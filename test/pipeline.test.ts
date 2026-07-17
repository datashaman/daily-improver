import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "../src/app.js";
import type { RepositoryAdapter, RunStore } from "../src/contracts.js";
import { AdapterRegistry } from "../src/core/adapter-registry.js";
import { ImprovementPipeline } from "../src/core/pipeline.js";
import type { ImprovementCandidate, ImprovementRun, RepositoryProfile } from "../src/domain/model.js";

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

test("pipeline fails closed when no candidate has reproducible evidence", async () => {
  const candidate: ImprovementCandidate = {
    id: "unsupported",
    kind: "maintainability",
    title: "Unsupported candidate",
    rationale: "This candidate has a score but no reproducibility contract.",
    confidence: 1,
    impact: 1,
    effort: 0,
    risk: 0,
    subsystemRisk: 0,
    testability: 1,
    estimatedDiffLines: 10,
    evidence: ["unqualified observation"],
    suggestedFiles: ["src/Service.ts"],
  };
  const profile: RepositoryProfile = {
    root: "/repository",
    adapter: "unqualified",
    language: "unknown",
    frameworks: [],
    signals: ["fixture"],
    capabilities: new Map(),
  };
  const adapter: RepositoryAdapter = {
    id: "unqualified",
    detect: async () => 1,
    profile: async () => profile,
    discoverCandidates: async () => [candidate],
  };
  const saved: ImprovementRun[] = [];
  const store: RunStore = {
    save: async (run) => { saved.push(run); },
    list: async () => saved,
  };
  const pipeline = new ImprovementPipeline(new AdapterRegistry([adapter]), [], store);

  await assert.rejects(
    pipeline.plan(profile.root),
    /No credible improvement candidates were found/,
  );
  assert.deepEqual(saved, []);
});
