import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "../src/app.js";
import type { RepositoryAdapter, RunStore } from "../src/contracts.js";
import { AdapterRegistry } from "../src/core/adapter-registry.js";
import { ImprovementPipeline } from "../src/core/pipeline.js";
import { reproducibleEvidence } from "../src/domain/candidate-reproducibility.js";
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

test("pipeline selects exactly one candidate from a deterministic ranking", async () => {
  const candidate = (id: string, impact: number): ImprovementCandidate => ({
    id,
    kind: "maintainability",
    title: id,
    rationale: `${id} rationale`,
    confidence: 0.8,
    impact,
    effort: 0.2,
    risk: 0.1,
    subsystemRisk: 0.1,
    testability: 0.8,
    estimatedDiffLines: 10,
    evidence: [`${id} evidence`],
    suggestedFiles: ["src/Service.ts"],
    reproducibility: reproducibleEvidence(0.9, [`${id} collector`]),
  });
  const profile: RepositoryProfile = {
    root: "/repository",
    adapter: "fixture",
    language: "unknown",
    frameworks: [],
    signals: ["fixture"],
    capabilities: new Map(),
  };
  const adapter: RepositoryAdapter = {
    id: "fixture",
    detect: async () => 1,
    profile: async () => profile,
    discoverCandidates: async () => [candidate("lower", 0.2), candidate("selected", 0.9)],
  };
  const saved: ImprovementRun[] = [];
  const store: RunStore = {
    save: async (run) => { saved.push(run); },
    list: async () => saved,
  };

  const run = await new ImprovementPipeline(new AdapterRegistry([adapter]), [], store).plan(profile.root);

  assert.equal(run.candidate?.id, "selected");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.candidate?.id, "selected");
});

test("pipeline applies repository candidate priorities", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-priorities-"));
  await mkdir(join(root, ".ai"));
  await writeFile(join(root, ".ai", "improver.yml"), `version: 1
schedule: { timezone: UTC, time: "05:00" }
selection: { priorities: [documentation] }
limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 3, max_cost_usd: 4 }
protected_paths: []
verification: { commands: [], mutation_testing: targeted }
pull_request: { draft: true, labels: [] }
`);
  const candidate = (id: string, kind: ImprovementCandidate["kind"]): ImprovementCandidate => ({
    id, kind, title: id, rationale: `${id} rationale`, confidence: 0.5, impact: 0.5,
    effort: 0.5, risk: 0.5, subsystemRisk: 0.5, testability: 0.5, estimatedDiffLines: 80,
    evidence: [`${id} evidence`], suggestedFiles: ["src/Service.ts"],
    reproducibility: reproducibleEvidence(0.8, [`${id} collector`]),
  });
  const profile: RepositoryProfile = {
    root, adapter: "fixture", language: "unknown", frameworks: [], signals: ["fixture"], capabilities: new Map(),
  };
  const adapter: RepositoryAdapter = {
    id: "fixture",
    detect: async () => 1,
    profile: async () => profile,
    discoverCandidates: async () => [candidate("mutation", "mutation-testing"), candidate("docs", "documentation")],
  };
  const saved: ImprovementRun[] = [];
  const store: RunStore = { save: async (run) => { saved.push(run); }, list: async () => saved };

  const run = await new ImprovementPipeline(new AdapterRegistry([adapter]), [], store).plan(root);

  assert.equal(run.candidate?.id, "docs");
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
