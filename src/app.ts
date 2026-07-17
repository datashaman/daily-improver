import { resolve } from "node:path";
import { PhpAdapter } from "./adapters/php.js";
import { GenericAdapter } from "./adapters/generic.js";
import { AdapterRegistry } from "./core/adapter-registry.js";
import { ImprovementPipeline } from "./core/pipeline.js";
import { CostBudgetPolicy, DiffLimitPolicy, TestProtectionPolicy } from "./core/policies.js";
import { JsonRunStore } from "./infra/json-run-store.js";
import { PipelineStages } from "./core/stages.js";
import { JsonDailyImprovementStore } from "./infra/json-daily-improvement-store.js";

export function createApplication(stateDirectory = resolve(".daily-improver")) {
  const registry = new AdapterRegistry([new PhpAdapter(), new GenericAdapter()]);
  const store = new JsonRunStore(stateDirectory);
  const dailyImprovements = new JsonDailyImprovementStore(stateDirectory);
  return {
    registry,
    store,
    dailyImprovements,
    stages: new PipelineStages(registry, dailyImprovements),
    pipeline: new ImprovementPipeline(
      registry,
      [new DiffLimitPolicy(), new CostBudgetPolicy(), new TestProtectionPolicy()],
      store,
      dailyImprovements,
    ),
  };
}
