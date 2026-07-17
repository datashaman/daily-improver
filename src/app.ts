import { resolve } from "node:path";
import { PhpAdapter } from "./adapters/php.js";
import { GenericAdapter } from "./adapters/generic.js";
import { AdapterRegistry } from "./core/adapter-registry.js";
import { ImprovementPipeline } from "./core/pipeline.js";
import { CostBudgetPolicy, DiffLimitPolicy, TestProtectionPolicy } from "./core/policies.js";
import { JsonRunStore } from "./infra/json-run-store.js";
import { PipelineStages } from "./core/stages.js";
import { JsonDailyImprovementStore } from "./infra/json-daily-improvement-store.js";
import type { OpenPullRequestStateSource } from "./contracts.js";
import { JsonOpenPullRequestStateSource } from "./infra/json-open-pull-request-state-source.js";

export function createApplication(
  stateDirectory = resolve(".daily-improver"),
  openPullRequests: OpenPullRequestStateSource = new JsonOpenPullRequestStateSource(
    process.env.DAILY_IMPROVER_OPEN_PR_STATE_PATH,
    process.env.DAILY_IMPROVER_REPOSITORY_SCOPE,
  ),
) {
  const registry = new AdapterRegistry([new PhpAdapter(), new GenericAdapter()]);
  const store = new JsonRunStore(stateDirectory);
  const dailyImprovements = new JsonDailyImprovementStore(stateDirectory);
  return {
    registry,
    store,
    dailyImprovements,
    stages: new PipelineStages(registry, dailyImprovements, openPullRequests),
    pipeline: new ImprovementPipeline(
      registry,
      [new DiffLimitPolicy(), new CostBudgetPolicy(), new TestProtectionPolicy()],
      store,
      dailyImprovements,
      openPullRequests,
    ),
  };
}
