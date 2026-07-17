import { loadConfig } from "../config.js";
import type { DailyImprovementDecision, ImprovementSpec } from "../domain/model.js";
import { relative } from "node:path";
import type { Clock, DailyImprovementStore, OpenPullRequestStateSource, UnresolvedFindingStateSource } from "../contracts.js";
import { CommandRunner } from "../infra/command-runner.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { createTestManifest, readArtifact, runDirectory, verifyTestManifest, writeArtifact, type AnalysisArtifact, type TestManifest } from "./artifacts.js";
import { DiffGuard } from "./diff-guard.js";
import { SourceSafetyInspector } from "./source-safety.js";
import { selectCandidatesByScope } from "./candidate-scope.js";
import { createSpec } from "./specification.js";
import { decideOpenPullRequestLimit } from "./open-pull-request-limit.js";
import { excludeUnresolvedFindings } from "./unresolved-findings.js";
import { assertScoreExplanations } from "../domain/candidate-score.js";

export class PipelineStages {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly dailyImprovements?: DailyImprovementStore,
    private readonly openPullRequests?: OpenPullRequestStateSource,
    private readonly unresolvedFindings?: UnresolvedFindingStateSource,
    private readonly runner = new CommandRunner(),
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async resolveAdapter(root: string) {
    return await this.registry.resolve(root);
  }

  async analyse(root: string): Promise<AnalysisArtifact> {
    const adapter = await this.registry.resolve(root);
    const profile = await adapter.profile(root);
    const config = await loadConfig(root);
    const generatedAt = this.clock.now().toISOString();
    const selection = excludeUnresolvedFindings(
      selectCandidatesByScope(
        await adapter.discoverCandidates(profile),
        config.selection.priorities,
        { maxFiles: config.limits.max_changed_files, maxChangedLines: config.limits.max_diff_lines },
      ),
      await this.requiredUnresolvedFindings().current(generatedAt),
    );
    const artifact: AnalysisArtifact = {
      schema: 5,
      repository: root,
      adapter: adapter.id,
      generatedAt,
      candidates: selection.candidates.slice(0, 1),
      scoreExplanations: selection.scoreExplanations,
      candidateExclusions: selection.exclusions,
      ...(selection.humanTaskRecommendation === undefined
        ? {}
        : { humanTaskRecommendation: selection.humanTaskRecommendation }),
    };
    await writeArtifact(root, "candidate.json", artifact);
    return artifact;
  }

  async specify(root: string): Promise<ImprovementSpec> {
    const analysis = await readArtifact<AnalysisArtifact>(root, "candidate.json");
    if (analysis.schema !== 5) throw new Error("Analysis artifact must use schema 5.");
    const config = await loadConfig(root);
    assertScoreExplanations(analysis.candidates, analysis.scoreExplanations, config.selection.priorities);
    const selected = analysis.candidates[0];
    if (!selected) throw new Error("Analysis produced no candidate to specify.");
    const adapter = await this.registry.resolve(root);
    const profile = await adapter.profile(root);
    const decidedAt = this.clock.now().toISOString();
    const openPullRequestLimitDecision = decideOpenPullRequestLimit(
      await this.requiredOpenPullRequests().current(decidedAt),
      config.limits.max_open_prs,
      decidedAt,
    );
    await writeArtifact(root, "open-pull-request-limit-decision.json", openPullRequestLimitDecision);
    if (openPullRequestLimitDecision.outcome === "blocked") {
      throw new Error(`Open Daily Improver pull requests (${openPullRequestLimitDecision.openPullRequests}) meet or exceed the repository limit (${openPullRequestLimitDecision.maxOpenPullRequests}).`);
    }
    const dailyImprovements = this.requiredDailyImprovements();
    const now = this.clock.now().toISOString();
    const decision = await dailyImprovements.claim(root, now.slice(0, 10), now);
    if (decision.outcome !== "claimed") {
      throw new Error(`Daily improvement is already ${decision.outcome === "blocked-completed" ? "completed" : "active"} for this repository on ${decision.utcDate}.`);
    }
    try {
      const spec = createSpec(selected, profile, {
        maxFiles: config.limits.max_changed_files,
        maxChangedLines: config.limits.max_diff_lines,
        maxCostUsd: config.limits.max_cost_usd,
      });
      await writeArtifact(root, "daily-improvement-decision.json", decision);
      await writeArtifact(root, "spec.json", spec);
      return spec;
    } catch (error) {
      await dailyImprovements.release(decision, this.clock.now().toISOString());
      throw error;
    }
  }

  async protectTests(root: string): Promise<TestManifest> {
    const key = requiredSecret("DAILY_IMPROVER_MANIFEST_KEY");
    const manifest = await createTestManifest(root, key);
    await writeArtifact(root, "test-manifest.json", manifest);
    return manifest;
  }

  async build(root: string): Promise<{ command: string; exitCode: number }> {
    const command = process.env.DAILY_IMPROVER_BUILDER_COMMAND;
    if (!command) throw new Error("Builder provider is not configured. Set DAILY_IMPROVER_BUILDER_COMMAND in the isolated builder job.");
    const result = await this.runner.run(["/bin/sh", "-lc", command], root);
    if (result.exitCode !== 0) throw new Error(`Builder failed: ${result.stderr || result.stdout}`);
    return { command, exitCode: result.exitCode };
  }

  async verify(
    root: string,
    base = process.env.DAILY_IMPROVER_BASE_REF ?? "origin/main",
    manifestKey?: string,
    trustedArtifacts: readonly string[] = [],
  ) {
    const key = manifestKey ?? requiredSecret("DAILY_IMPROVER_MANIFEST_KEY");
    const config = await loadConfig(root);
    const spec = await readArtifact<ImprovementSpec>(root, "spec.json");
    const manifest = await readArtifact<TestManifest>(root, "test-manifest.json");
    if (!(await verifyTestManifest(root, manifest, key))) throw new Error("Protected test manifest is invalid or a protected test changed.");
    const trustedPaths = new Set(Object.keys(manifest.files));
    trustedPaths.add(relative(root, `${runDirectory(root)}/test-manifest.json`));
    for (const path of trustedArtifacts) trustedPaths.add(path);
    const diff = await new DiffGuard(this.runner).inspect(root, base, spec, config.protected_paths, trustedPaths);
    const sourceSafety = await new SourceSafetyInspector(this.runner).inspect(root, base, Object.keys(manifest.files));
    const checks = [];
    for (const command of config.verification.commands) {
      const result = await this.runner.run(["/bin/sh", "-lc", command], root);
      checks.push({ command, exitCode: result.exitCode, durationMs: result.durationMs });
      if (result.exitCode !== 0) break;
    }
    const passed = diff.allowed && sourceSafety.allowed && checks.every((check) => check.exitCode === 0);
    const report = { passed, base, diff, sourceSafety, checks, verifiedAt: new Date().toISOString() };
    await writeArtifact(root, "verification.json", report);
    if (!passed) throw new Error(`Verification failed: ${[...diff.violations, ...sourceSafety.violations, ...checks.filter((c) => c.exitCode !== 0).map((c) => `Command failed: ${c.command}`)].join("; ")}`);
    return report;
  }

  async publicationRequest(root: string): Promise<{ title: string; body: string; draft: boolean; labels: readonly string[] }> {
    const config = await loadConfig(root);
    const spec = await readArtifact<ImprovementSpec>(root, "spec.json");
    const verification = await readArtifact<{ passed: boolean; checks: readonly { command: string; exitCode: number }[] }>(root, "verification.json");
    const testPlan = await optionalArtifact<{
      schemaVersion?: string;
      improvementIntent?: { readonly intent?: string };
      baseline?: { readonly outcome?: string };
      propertyInvariants?: readonly string[];
    }>(root, "test-plan.json");
    if (!verification.passed) throw new Error("Cannot publish an unverified improvement.");
    const request = {
      title: spec.title,
      body: `## Improvement\n${spec.objective}\n\n## Evidence\n${spec.evidence.map((item) => `- ${item}`).join("\n")}\n\n## Verification\n${baselineSummary(testPlan)}${verification.checks.map((check) => `- ${check.command}: passed`).join("\n")}\n\n## Risk\nBounded to ${spec.constraints.maxFiles} files and ${spec.constraints.maxChangedLines} changed lines.`,
      draft: config.pull_request.draft,
      labels: config.pull_request.labels,
    };
    const dailyDecision = await readArtifact<DailyImprovementDecision>(root, "daily-improvement-decision.json");
    const completed = await this.requiredDailyImprovements().complete(dailyDecision, this.clock.now().toISOString());
    await writeArtifact(root, "daily-improvement-decision.json", completed);
    await writeArtifact(root, "publication-request.json", request);
    return request;
  }

  private requiredDailyImprovements(): DailyImprovementStore {
    if (!this.dailyImprovements) throw new Error("Daily improvement state is required for specification and publication stages.");
    return this.dailyImprovements;
  }

  private requiredOpenPullRequests(): OpenPullRequestStateSource {
    if (!this.openPullRequests) throw new Error("Open pull request state is required for specification.");
    return this.openPullRequests;
  }

  private requiredUnresolvedFindings(): UnresolvedFindingStateSource {
    if (!this.unresolvedFindings) throw new Error("Unresolved finding state is required for analysis.");
    return this.unresolvedFindings;
  }
}

function baselineSummary(testPlan: {
  readonly schemaVersion?: string;
  readonly improvementIntent?: { readonly intent?: string };
  readonly baseline?: { readonly outcome?: string };
} | undefined): string {
  if (testPlan?.schemaVersion !== "test-plan/v3" && testPlan?.schemaVersion !== "test-plan/v4") return "";
  if (testPlan.baseline?.outcome === "failed-as-expected" && testPlan.improvementIntent?.intent === "defect") {
    return "- Defect regression test failed behaviorally against the baseline and passed after the change.\n";
  }
  if (testPlan.baseline?.outcome === "passed-as-expected" && testPlan.improvementIntent?.intent) {
    return `- ${testPlan.improvementIntent.intent} baseline proof passed before and after the change.\n`;
  }
  return "";
}

async function optionalArtifact<T>(root: string, name: string): Promise<T | undefined> {
  try { return await readArtifact<T>(root, name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for this isolated stage.`);
  return value;
}
