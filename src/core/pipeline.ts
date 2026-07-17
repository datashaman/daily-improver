import { randomUUID } from "node:crypto";
import type { Clock, Policy, PolicyContext, RunStore } from "../contracts.js";
import type { ImprovementRun } from "../domain/model.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { evaluatePolicies } from "./policies.js";
import { rankCandidates } from "./ranking.js";
import { createSpec } from "./specification.js";

export interface PlanOptions {
  readonly maxFiles?: number;
  readonly maxChangedLines?: number;
  readonly maxCostUsd?: number;
  readonly estimatedFiles?: number;
  readonly estimatedChangedLines?: number;
  readonly estimatedCostUsd?: number;
}

export class ImprovementPipeline {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly policies: readonly Policy[],
    private readonly store: RunStore,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async plan(root: string, options: PlanOptions = {}): Promise<ImprovementRun> {
    const startedAt = this.clock.now().toISOString();
    const adapter = await this.registry.resolve(root);
    const profile = await adapter.profile(root);
    const candidates = rankCandidates(await adapter.discoverCandidates(profile));
    const candidate = candidates[0];
    if (!candidate) throw new Error("No credible improvement candidates were found.");

    const spec = createSpec(candidate, profile, {
      maxFiles: options.maxFiles ?? 8,
      maxChangedLines: options.maxChangedLines ?? 250,
      maxCostUsd: options.maxCostUsd ?? 5,
    });
    const context: PolicyContext = {
      estimatedFiles: options.estimatedFiles ?? (candidate.suggestedFiles.length || 1),
      estimatedChangedLines: options.estimatedChangedLines ?? 80,
      estimatedCostUsd: options.estimatedCostUsd ?? 1,
      availableCapabilities: new Set(profile.capabilities.keys()),
    };
    const policyDecisions = evaluatePolicies(this.policies, spec, context);
    const status = policyDecisions.every((decision) => decision.allowed) ? "planned" : "rejected";
    const run: ImprovementRun = {
      id: randomUUID(),
      repository: root,
      startedAt,
      finishedAt: this.clock.now().toISOString(),
      status,
      adapter: adapter.id,
      candidate,
      spec,
      policyDecisions,
    };
    await this.store.save(run);
    return run;
  }
}
