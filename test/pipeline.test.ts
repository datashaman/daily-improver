import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "../src/app.js";
import type { DailyImprovementStore, OpenPullRequestStateSource, RepositoryAdapter, RunStore } from "../src/contracts.js";
import { AdapterRegistry } from "../src/core/adapter-registry.js";
import { readArtifact, type AnalysisArtifact } from "../src/core/artifacts.js";
import { ImprovementPipeline } from "../src/core/pipeline.js";
import { PipelineStages } from "../src/core/stages.js";
import { reproducibleEvidence } from "../src/domain/candidate-reproducibility.js";
import type { ImprovementCandidate, ImprovementRun, OpenPullRequestLimitDecision, RepositoryProfile } from "../src/domain/model.js";

const acceptingDailyImprovements: DailyImprovementStore = {
  claim: async (_repository, utcDate, decidedAt) => ({
    schemaVersion: "daily-improvement-decision/v1",
    repositoryId: "a".repeat(64),
    utcDate,
    claimId: "fixture-claim",
    outcome: "claimed",
    decidedAt,
  }),
  complete: async (decision, decidedAt) => ({ ...decision, outcome: "completed", decidedAt }),
  release: async (decision, decidedAt) => ({ ...decision, outcome: "released", decidedAt }),
};

const unexpectedDailyImprovementClaim: DailyImprovementStore = {
  claim: async () => { throw new Error("A rejected candidate must not consume the daily improvement claim."); },
  complete: async () => { throw new Error("Unexpected daily improvement completion."); },
  release: async () => { throw new Error("Unexpected daily improvement release."); },
};

const acceptingOpenPullRequests: OpenPullRequestStateSource = {
  current: async (decidedAt) => ({
    schemaVersion: "open-pull-request-state/v1",
    repositoryId: "b".repeat(64),
    observedAt: decidedAt,
    openPullRequests: 0,
  }),
};

const unexpectedOpenPullRequestRead: OpenPullRequestStateSource = {
  current: async () => { throw new Error("A rejected candidate must not consume open pull request state."); },
};

test("pipeline creates and persists an approved language-specific plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-repo-"));
  const state = await mkdtemp(join(tmpdir(), "daily-improver-state-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" }, "require-dev": { "phpunit/phpunit": "^12" },
  }));
  const app = createApplication(state, acceptingOpenPullRequests);
  const run = await app.pipeline.plan(root);
  assert.equal(run.adapter, "php");
  assert.equal(run.status, "planned");
  assert.equal(run.openPullRequestLimitDecision?.outcome, "allowed");
  assert.equal((await app.store.list(root)).length, 1);
});

test("pipeline rejects at the open pull request limit before claiming or specifying", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-open-pr-limit-"));
  const state = await mkdtemp(join(tmpdir(), "daily-improver-open-pr-limit-state-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" }, "require-dev": { "phpunit/phpunit": "^12" },
  }));
  const atLimit: OpenPullRequestStateSource = {
    current: async (decidedAt) => ({
      schemaVersion: "open-pull-request-state/v1",
      repositoryId: "c".repeat(64),
      observedAt: decidedAt,
      openPullRequests: 3,
    }),
  };
  const app = createApplication(state, atLimit);
  app.dailyImprovements.claim = async () => { throw new Error("The open PR limit must block before the daily claim."); };

  const run = await app.pipeline.plan(root);

  assert.equal(run.status, "rejected");
  assert.equal(run.openPullRequestLimitDecision?.outcome, "blocked");
  assert.equal(run.openPullRequestLimitDecision?.openPullRequests, 3);
  assert.equal(run.spec, undefined);
  assert.equal(run.dailyImprovementDecision, undefined);
});

test("pipeline fails closed without creating a second specification on the same UTC repository day", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-repeat-"));
  const state = await mkdtemp(join(tmpdir(), "daily-improver-repeat-state-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" }, "require-dev": { "phpunit/phpunit": "^12" },
  }));
  const app = createApplication(state, acceptingOpenPullRequests);

  const first = await app.pipeline.plan(root);
  const repeated = await app.pipeline.plan(root);

  assert.equal(first.status, "planned");
  assert.equal(first.dailyImprovementDecision?.outcome, "claimed");
  assert.equal(repeated.status, "rejected");
  assert.equal(repeated.dailyImprovementDecision?.outcome, "blocked-active");
  assert.equal(repeated.spec, undefined);
  assert.equal((await app.store.list(root)).length, 2);
});

test("pipeline rejects work that exceeds its cost budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-repo-"));
  const state = await mkdtemp(join(tmpdir(), "daily-improver-state-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({ require: { php: "^8.3" } }));
  const run = await createApplication(state, acceptingOpenPullRequests).pipeline.plan(root, { maxCostUsd: 2, estimatedCostUsd: 3 });
  assert.equal(run.status, "rejected");
  assert.equal(run.policyDecisions.find((decision) => decision.policy === "cost-budget")?.allowed, false);
  assert.equal(run.dailyImprovementDecision?.outcome, "released");
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

  const run = await new ImprovementPipeline(new AdapterRegistry([adapter]), [], store, acceptingDailyImprovements, acceptingOpenPullRequests).plan(profile.root);

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

  const run = await new ImprovementPipeline(new AdapterRegistry([adapter]), [], store, acceptingDailyImprovements, acceptingOpenPullRequests).plan(root);

  assert.equal(run.candidate?.id, "docs");
});

test("pipeline persists a human task instead of planning oversized-only work", async () => {
  const oversized: ImprovementCandidate = {
    id: "large-refactor", kind: "maintainability", title: "Refactor the service boundary",
    rationale: "A credible but oversized opportunity.", confidence: 0.9, impact: 0.9,
    effort: 0.4, risk: 0.3, subsystemRisk: 0.3, testability: 0.8, estimatedDiffLines: 251,
    evidence: ["bounded evidence"], suggestedFiles: ["src/Service.ts"],
    reproducibility: reproducibleEvidence(0.9, ["fixture collector"]),
  };
  const profile: RepositoryProfile = {
    root: "/repository", adapter: "fixture", language: "unknown", frameworks: [], signals: ["fixture"], capabilities: new Map(),
  };
  const adapter: RepositoryAdapter = {
    id: "fixture", detect: async () => 1, profile: async () => profile, discoverCandidates: async () => [oversized],
  };
  const saved: ImprovementRun[] = [];
  const store: RunStore = { save: async (run) => { saved.push(run); }, list: async () => saved };

  const run = await new ImprovementPipeline(new AdapterRegistry([adapter]), [], store, unexpectedDailyImprovementClaim, unexpectedOpenPullRequestRead).plan(profile.root);

  assert.equal(run.status, "rejected");
  assert.equal(run.candidate, undefined);
  assert.equal(run.spec, undefined);
  assert.equal(run.humanTaskRecommendation?.candidateId, "large-refactor");
  assert.equal(run.candidateExclusions[0]?.reason, "oversized-scope");
  assert.deepEqual(saved, [run]);
});

test("analyse emits the versioned human task in its persisted artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-oversized-analysis-"));
  const oversized: ImprovementCandidate = {
    id: "large-analysis", kind: "maintainability", title: "Review the large service boundary",
    rationale: "Raw rationale stays out of the recommendation.", confidence: 0.9, impact: 0.9,
    effort: 0.4, risk: 0.3, subsystemRisk: 0.3, testability: 0.8, estimatedDiffLines: 251,
    evidence: ["raw evidence stays private"], suggestedFiles: ["src/Service.ts"],
    reproducibility: reproducibleEvidence(0.9, ["fixture collector"]),
  };
  const profile: RepositoryProfile = {
    root, adapter: "fixture", language: "unknown", frameworks: [], signals: ["fixture"], capabilities: new Map(),
  };
  const adapter: RepositoryAdapter = {
    id: "fixture", detect: async () => 1, profile: async () => profile, discoverCandidates: async () => [oversized],
  };

  const artifact = await new PipelineStages(new AdapterRegistry([adapter])).analyse(root);
  const persisted = await readArtifact<AnalysisArtifact>(root, "candidate.json");

  assert.equal(artifact.schema, 3);
  assert.deepEqual(persisted, artifact);
  assert.equal(persisted.candidates.length, 0);
  assert.equal(persisted.humanTaskRecommendation?.schemaVersion, "human-task-recommendation/v1");
  assert.equal(persisted.candidateExclusions[0]?.reason, "oversized-scope");
  assert.doesNotMatch(JSON.stringify(persisted.humanTaskRecommendation), /raw evidence|raw rationale|src\/Service/iu);
});

test("specify persists the blocked open pull request decision without claiming the repository day", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-open-pr-stage-"));
  const candidate: ImprovementCandidate = {
    id: "bounded-stage", kind: "maintainability", title: "Bounded stage candidate",
    rationale: "A bounded stage candidate.", confidence: 0.9, impact: 0.9,
    effort: 0.2, risk: 0.2, subsystemRisk: 0.2, testability: 0.8, estimatedDiffLines: 20,
    evidence: ["bounded stage evidence"], suggestedFiles: ["src/Service.ts"],
    reproducibility: reproducibleEvidence(0.9, ["fixture collector"]),
  };
  const profile: RepositoryProfile = {
    root, adapter: "fixture", language: "unknown", frameworks: [], signals: ["fixture"], capabilities: new Map(),
  };
  const adapter: RepositoryAdapter = {
    id: "fixture", detect: async () => 1, profile: async () => profile, discoverCandidates: async () => [candidate],
  };
  const atLimit: OpenPullRequestStateSource = {
    current: async (decidedAt) => ({
      schemaVersion: "open-pull-request-state/v1",
      repositoryId: "d".repeat(64),
      observedAt: decidedAt,
      openPullRequests: 3,
    }),
  };
  const stages = new PipelineStages(new AdapterRegistry([adapter]), unexpectedDailyImprovementClaim, atLimit);
  await stages.analyse(root);

  await assert.rejects(stages.specify(root), /meet or exceed the repository limit/);
  const decision = await readArtifact<OpenPullRequestLimitDecision>(root, "open-pull-request-limit-decision.json");
  assert.deepEqual(decision, {
    schemaVersion: "open-pull-request-limit-decision/v1",
    repositoryId: "d".repeat(64),
    observedAt: decision.observedAt,
    openPullRequests: 3,
    maxOpenPullRequests: 3,
    outcome: "blocked",
    decidedAt: decision.decidedAt,
  });
});

test("pipeline persists a machine-readable rejection when no candidate has reproducible evidence", async () => {
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
  const pipeline = new ImprovementPipeline(new AdapterRegistry([adapter]), [], store, unexpectedDailyImprovementClaim, unexpectedOpenPullRequestRead);

  const run = await pipeline.plan(profile.root);

  assert.equal(run.status, "rejected");
  assert.equal(run.candidate, undefined);
  assert.deepEqual(run.candidateExclusions, [{
    schemaVersion: "candidate-exclusion/v1",
    candidateReference: "unsupported",
    candidateKind: "maintainability",
    reason: "evidence",
  }]);
  assert.deepEqual(saved, [run]);
});
