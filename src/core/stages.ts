import { loadConfig } from "../config.js";
import type { DailyImprovementDecision, ImprovementSpec } from "../domain/model.js";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { Clock, DailyImprovementStore, OpenPullRequestStateSource, UnresolvedFindingStateSource } from "../contracts.js";
import { CommandRunner } from "../infra/command-runner.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { createTestManifest, readArtifact, runDirectory, verifierManifestFilePaths, verifyVerifierTestManifest, writeArtifact, type AnalysisArtifact, type TestManifest } from "./artifacts.js";
import { DiffGuard } from "./diff-guard.js";
import { SourceSafetyInspector } from "./source-safety.js";
import { selectCandidatesByScope } from "./candidate-scope.js";
import { createSpec } from "./specification.js";
import { decideOpenPullRequestLimit } from "./open-pull-request-limit.js";
import { excludeUnresolvedFindings } from "./unresolved-findings.js";
import { assertScoreExplanations } from "../domain/candidate-score.js";
import {
  assertVerifierExecutionInputs,
  prepareVerifierExecution,
  sealVerifierExecution,
  writeVerificationOutput,
  type VerifierExecutionInputs,
  type VerifierExecutionPreparation,
} from "./verifier-execution-inputs.js";
import { assertVerifierCommandEnvironment, createVerifierCommandEnvironmentDecision, runVerifierCommand, type VerifierCommandEnvironmentDecision } from "./verifier-command-environment.js";
import { authorizePublication, type PublicationVerificationBinding } from "./publication-authorization.js";
import { signArtifact, verifyArtifact } from "./artifact-authentication.js";
import { assertVerifiedPublicationPatchMaterialized, type VerifiedPublicationPatch } from "./trusted-publication-workspace.js";

export interface PublicationMainContext {
  readonly repository: string;
  readonly reference: string;
}

export class PipelineStages {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly dailyImprovements?: DailyImprovementStore,
    private readonly openPullRequests?: OpenPullRequestStateSource,
    private readonly unresolvedFindings?: UnresolvedFindingStateSource,
    private readonly runner = new CommandRunner(),
    private readonly clock: Clock = { now: () => new Date() },
    private readonly verifierCommandEnvironment: VerifierCommandEnvironmentDecision = createVerifierCommandEnvironmentDecision(process.env),
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
      }, config.protected_paths);
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

  async prepareVerification(
    root: string,
    base = process.env.DAILY_IMPROVER_BASE_REF ?? "origin/main",
  ): Promise<VerifierExecutionPreparation> {
    const config = await loadConfig(root);
    const spec = await readArtifact<ImprovementSpec>(root, "spec.json");
    return await prepareVerifierExecution(root, base, spec, config, this.verifierCommandEnvironment, this.runner);
  }

  async sealVerification(
    root: string,
    preparation: VerifierExecutionPreparation,
    manifest: TestManifest,
  ): Promise<VerifierExecutionInputs> {
    return await sealVerifierExecution(root, preparation, manifest);
  }

  async verify(
    root: string,
    preparedInputs?: VerifierExecutionInputs,
    manifestKey?: string,
  ) {
    const key = manifestKey ?? requiredSecret("DAILY_IMPROVER_MANIFEST_KEY");
    const inputs = preparedInputs ?? await this.sealVerification(
      root,
      await this.prepareVerification(root),
      await readArtifact<TestManifest>(root, "test-manifest.json"),
    );
    await assertVerifierExecutionInputs(root, inputs, this.runner);
    if (!(await verifyVerifierTestManifest(root, inputs.manifest, key))) throw new Error("Protected test manifest is invalid or a protected test changed.");
    await assertVerifierCommandEnvironment(this.runner, inputs.commandEnvironment, root);
    const trustedPaths = new Set(verifierManifestFilePaths(inputs.manifest));
    trustedPaths.add(relative(root, `${runDirectory(root)}/test-manifest.json`));
    const diff = await new DiffGuard(this.runner).inspect(
      root,
      inputs.expectedBaseSha,
      inputs.specification,
      inputs.protectedPaths,
      trustedPaths,
    );
    const sourceSafety = await new SourceSafetyInspector(this.runner).inspect(
      root,
      inputs.expectedBaseSha,
      Object.keys(inputs.manifest.files),
    );
    const checks = [];
    for (const command of inputs.commands) {
      const result = await runVerifierCommand(
        this.runner,
        inputs.commandEnvironment,
        [inputs.commandEnvironment.shell, "-c", command],
        root,
        10 * 60_000,
      );
      checks.push({ command, exitCode: result.exitCode, durationMs: result.durationMs });
      if (result.exitCode !== 0) break;
    }
    const passed = diff.allowed && sourceSafety.allowed && checks.every((check) => check.exitCode === 0);
    const report = {
      schemaVersion: "verification-report/v1" as const,
      passed,
      expectedBaseSha: inputs.expectedBaseSha,
      verifierInputsSha256: inputs.integritySha256,
      diff,
      sourceSafety,
      checks,
      verifiedAt: this.clock.now().toISOString(),
    };
    await writeVerificationOutput(root, inputs.outputArtifact, report);
    await signArtifact(root, inputs.outputArtifact, "verification-report/v1", key, this.clock.now());
    if (!passed) throw new Error(`Verification failed: ${[...diff.violations, ...sourceSafety.violations, ...checks.filter((c) => c.exitCode !== 0).map((c) => `Command failed: ${c.command}`)].join("; ")}`);
    return report;
  }

  async publicationRequest(
    root: string,
    main: PublicationMainContext,
    artifactKey?: string,
  ): Promise<{ title: string; body: string; draft: boolean; labels: readonly string[] }> {
    const key = artifactKey ?? requiredSecret("DAILY_IMPROVER_MANIFEST_KEY");
    const verificationPath = relative(root, `${runDirectory(root)}/verification.json`);
    const lifecyclePath = relative(root, `${runDirectory(root)}/generated-test-verification-lifecycle.json`);
    const patchPath = relative(root, `${runDirectory(root)}/verified-publication-patch.json`);
    const now = this.clock.now();
    const authenticated = await verifyPublicationInputs(root, verificationPath, lifecyclePath, patchPath, key, now);
    const config = await loadConfig(root);
    const spec = await readArtifact<ImprovementSpec>(root, "spec.json");
    const verification = JSON.parse(authenticated.reportBytes.toString("utf8")) as PublicationVerificationBinding & { readonly checks: readonly { command: string; exitCode: number }[] };
    const testPlan = await optionalArtifact<{
      schemaVersion?: string;
      improvementIntent?: { readonly intent?: string };
      baseline?: { readonly outcome?: string };
      propertyInvariants?: readonly string[];
    }>(root, "test-plan.json");
    const decidedAt = this.clock.now().toISOString();
    const authorization = await authorizePublication(main.repository, main.reference, verification, decidedAt, this.runner);
    const request = {
      title: spec.title,
      body: `## Improvement\n${spec.objective}\n\n## Evidence\n${spec.evidence.map((item) => `- ${item}`).join("\n")}\n\n## Verification\n${baselineSummary(testPlan)}${verification.checks.map((check) => `- ${check.command}: passed`).join("\n")}\n\n## Risk\nBounded to ${spec.constraints.maxFiles} files and ${spec.constraints.maxChangedLines} changed lines.`,
      draft: config.pull_request.draft,
      labels: config.pull_request.labels,
    };
    await verifyPublicationInputs(root, verificationPath, lifecyclePath, patchPath, key, now);
    const dailyDecision = await readArtifact<DailyImprovementDecision>(root, "daily-improvement-decision.json");
    const completed = await this.requiredDailyImprovements().complete(dailyDecision, decidedAt);
    await writeArtifact(root, "daily-improvement-decision.json", completed);
    await writeArtifact(root, "publication-authorization.json", authorization);
    await writeArtifact(root, "publication-request.json", { schemaVersion: "publication-request/v1", ...request });
    await signArtifact(root, relative(root, `${runDirectory(root)}/daily-improvement-decision.json`), "daily-improvement-decision/v1", key, now);
    await signArtifact(root, relative(root, `${runDirectory(root)}/publication-authorization.json`), "publication-authorization/v1", key, now);
    await signArtifact(root, relative(root, `${runDirectory(root)}/publication-request.json`), "publication-request/v1", key, now);
    return request;
  }

  async quarantine(root: string, candidateId: string, phase: "baseline" | "verification", reason: string): Promise<void> {
    if (!candidateId || candidateId.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(candidateId)) throw new Error("Quarantine candidate identity is malformed.");
    if (reason !== "command-outcome-varied" && reason !== "execution-metrics-varied") throw new Error("Quarantine reason is unsupported.");
    const decision = await readArtifact<DailyImprovementDecision>(root, "daily-improvement-decision.json");
    const decidedAt = this.clock.now().toISOString();
    const released = await this.requiredDailyImprovements().release(decision, decidedAt);
    await writeArtifact(root, "daily-improvement-decision.json", released);
    await writeArtifact(root, "candidate-quarantine.json", {
      schemaVersion: "candidate-quarantine/v1",
      candidateId,
      phase,
      reason,
      outcome: "quarantined",
      decidedAt,
    });
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
  if (testPlan?.schemaVersion !== "test-plan/v3" && testPlan?.schemaVersion !== "test-plan/v4" && testPlan?.schemaVersion !== "test-plan/v5" && testPlan?.schemaVersion !== "test-plan/v6" && testPlan?.schemaVersion !== "test-plan/v7") return "";
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

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function verifyPublicationInputs(
  root: string,
  verificationPath: string,
  lifecyclePath: string,
  patchPath: string,
  key: string,
  now: Date,
): Promise<{ readonly reportBytes: Buffer; readonly lifecycleBytes: Buffer; readonly patch: VerifiedPublicationPatch }> {
  const reportBytes = await verifyArtifact(root, verificationPath, "verification-report/v1", key, now);
  const lifecycleBytes = await verifyArtifact(root, lifecyclePath, "generated-test-lifecycle-decision/v1", key, now);
  const patchBytes = await verifyArtifact(root, patchPath, "verified-publication-patch/v1", key, now);
  const patch = JSON.parse(patchBytes.toString("utf8")) as VerifiedPublicationPatch;
  if (patch.verificationReportSha256 !== sha256(reportBytes)
    || patch.verificationLifecycleSha256 !== sha256(lifecycleBytes)) {
    throw new Error("Authenticated publication patch does not bind the required verifier artifacts.");
  }
  await assertVerifiedPublicationPatchMaterialized(
    root,
    patch,
    verificationPath,
    lifecyclePath,
    relative(root, `${runDirectory(root)}/daily-improvement-decision.json`),
  );
  return { reportBytes, lifecycleBytes, patch };
}
