import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import type { Clock, DailyImprovementStore, OpenPullRequestStateSource, Policy, PolicyContext, RunStore } from "../contracts.js";
import type { ImprovementRun } from "../domain/model.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { evaluatePolicies } from "./policies.js";
import { selectCandidatesByScope } from "./candidate-scope.js";
import { createSpec } from "./specification.js";
import { decideOpenPullRequestLimit } from "./open-pull-request-limit.js";

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
    private readonly dailyImprovements: DailyImprovementStore,
    private readonly openPullRequests: OpenPullRequestStateSource,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async plan(root: string, options: PlanOptions = {}): Promise<ImprovementRun> {
    const startedAt = this.clock.now().toISOString();
    const adapter = await this.registry.resolve(root);
    const profile = await adapter.profile(root);
    const config = await loadConfig(root);
    const limits = {
      maxFiles: options.maxFiles ?? config.limits.max_changed_files,
      maxChangedLines: options.maxChangedLines ?? config.limits.max_diff_lines,
    };
    const selection = selectCandidatesByScope(
      await adapter.discoverCandidates(profile),
      config.selection.priorities,
      limits,
    );
    const candidate = selection.candidates[0];
    if (!candidate) {
      if (selection.exclusions.length === 0) throw new Error("No improvement candidates were found.");
      const run: ImprovementRun = {
        id: randomUUID(),
        repository: root,
        startedAt,
        finishedAt: this.clock.now().toISOString(),
        status: "rejected",
        adapter: adapter.id,
        candidateExclusions: selection.exclusions,
        ...(selection.humanTaskRecommendation === undefined
          ? {}
          : { humanTaskRecommendation: selection.humanTaskRecommendation }),
        policyDecisions: [],
      };
      await this.store.save(run);
      return run;
    }

    const openPullRequestDecidedAt = this.clock.now().toISOString();
    const openPullRequestLimitDecision = decideOpenPullRequestLimit(
      await this.openPullRequests.current(openPullRequestDecidedAt),
      config.limits.max_open_prs,
      openPullRequestDecidedAt,
    );
    if (openPullRequestLimitDecision.outcome === "blocked") {
      const run: ImprovementRun = {
        id: randomUUID(),
        repository: root,
        startedAt,
        finishedAt: this.clock.now().toISOString(),
        status: "rejected",
        adapter: adapter.id,
        candidate,
        candidateExclusions: selection.exclusions,
        ...(selection.humanTaskRecommendation === undefined
          ? {}
          : { humanTaskRecommendation: selection.humanTaskRecommendation }),
        openPullRequestLimitDecision,
        policyDecisions: [],
      };
      await this.store.save(run);
      return run;
    }

    const claimed = await this.dailyImprovements.claim(root, startedAt.slice(0, 10), this.clock.now().toISOString());
    if (claimed.outcome !== "claimed") {
      const run: ImprovementRun = {
        id: randomUUID(),
        repository: root,
        startedAt,
        finishedAt: this.clock.now().toISOString(),
        status: "rejected",
        adapter: adapter.id,
        candidate,
        candidateExclusions: selection.exclusions,
        ...(selection.humanTaskRecommendation === undefined
          ? {}
          : { humanTaskRecommendation: selection.humanTaskRecommendation }),
        openPullRequestLimitDecision,
        dailyImprovementDecision: claimed,
        policyDecisions: [],
      };
      await this.store.save(run);
      return run;
    }

    const spec = createSpec(candidate, profile, {
      maxFiles: limits.maxFiles,
      maxChangedLines: limits.maxChangedLines,
      maxCostUsd: options.maxCostUsd ?? config.limits.max_cost_usd,
    });
    const context: PolicyContext = {
      estimatedFiles: options.estimatedFiles ?? (candidate.suggestedFiles.length || 1),
      estimatedChangedLines: options.estimatedChangedLines ?? 80,
      estimatedCostUsd: options.estimatedCostUsd ?? 1,
      availableCapabilities: new Set(profile.capabilities.keys()),
    };
    const policyDecisions = evaluatePolicies(this.policies, spec, context);
    const status = policyDecisions.every((decision) => decision.allowed) ? "planned" : "rejected";
    const dailyImprovementDecision = status === "planned"
      ? claimed
      : await this.dailyImprovements.release(claimed, this.clock.now().toISOString());
    const run: ImprovementRun = {
      id: randomUUID(),
      repository: root,
      startedAt,
      finishedAt: this.clock.now().toISOString(),
      status,
      adapter: adapter.id,
      candidate,
      candidateExclusions: selection.exclusions,
      ...(selection.humanTaskRecommendation === undefined
        ? {}
        : { humanTaskRecommendation: selection.humanTaskRecommendation }),
      openPullRequestLimitDecision,
      dailyImprovementDecision,
      spec,
      policyDecisions,
    };
    await this.store.save(run);
    return run;
  }
}
