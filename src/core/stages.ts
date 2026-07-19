import { loadConfig } from "../config.js";
import type { DailyImprovementDecision, ImprovementSpec } from "../domain/model.js";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { Clock, DailyImprovementStore, OpenPullRequestStateSource, RepositoryAdapter, UnresolvedFindingStateSource } from "../contracts.js";
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
import { assertTargetedMutationPlan, assertTargetedMutationResult, compareTargetedMutationScores, type TargetedMutationResult, type TargetedMutationScoreComparison } from "../domain/targeted-mutation.js";
import { assertVerifierExecutionStateUnchanged, captureVerifierExecutionState } from "./verifier-execution-state.js";
import { createVerifierBaselineWorkspace } from "./verifier-baseline-workspace.js";
import { assertStaticAnalysisPlan, assertStaticAnalysisResult, compareStaticAnalysisFindings, type StaticAnalysisFindingsComparison, type StaticAnalysisResult } from "../domain/static-analysis-findings.js";
import { assertPublicApiSurfacePlan, assertPublicApiSurfaceResult, comparePublicApiSurfaces, type PublicApiSurfaceComparison, type PublicApiSurfaceResult } from "../domain/public-api-surface.js";
import {
  assertStaticAnalysisIgnoredFindingsPlan,
  assertStaticAnalysisIgnoredFindingsResult,
  compareStaticAnalysisIgnoredFindings,
  type StaticAnalysisIgnoredFindingsComparison,
  type StaticAnalysisIgnoredFindingsResult,
} from "../domain/static-analysis-ignored-findings.js";
import {
  assertBroadExceptionSwallowingPlan,
  assertBroadExceptionSwallowingResult,
  compareBroadExceptionSwallowing,
  type BroadExceptionSwallowingComparison,
  type BroadExceptionSwallowingResult,
} from "../domain/broad-exception-swallowing.js";
import {
  assertValidationBoundaryPlan,
  assertValidationBoundaryResult,
  compareValidationBoundaries,
  type ValidationBoundaryComparison,
  type ValidationBoundaryResult,
} from "../domain/validation-boundaries.js";
import {
  assertTestStrengthPlan,
  assertTestStrengthResult,
  compareTestStrength,
  type TestStrengthComparison,
  type TestStrengthResult,
} from "../domain/test-strength.js";
import {
  assertProtectedRepositoryChangePlan,
  assertProtectedRepositoryChangeResult,
  compareProtectedRepositoryChanges,
  type ProtectedRepositoryChangeComparison,
  type ProtectedRepositoryChangeResult,
} from "../domain/protected-repository-changes.js";
import {
  inspectProtectedRepositoryChanges,
  prepareProtectedRepositoryChangePlan,
} from "./protected-repository-changes.js";
import { assertSecretScanPlan, assertSecretScanResult, type SecretScanPlan, type SecretScanResult } from "../domain/secret-scan.js";
import { prepareSecretScanPlan, scanVerifiedPatchForSecrets } from "./secret-scan.js";
import { assertVerifiedPatchLimitResult } from "../domain/verified-patch-limits.js";
import { inspectVerifiedPatchLimits, prepareVerifiedPatchLimitPlan, requireVerifiedPatchWithinLimits } from "./verified-patch-limits.js";
import { assertSpecificationChangeScopeResult } from "../domain/specification-change-scope.js";
import {
  inspectSpecificationChangeScope,
  prepareSpecificationChangeScopePlan,
  requireSpecificationChangeScopeAccepted,
} from "./specification-change-scope.js";
import {
  assertObjectiveVerificationResult,
  type ObjectiveVerificationResult,
} from "../domain/objective-verification.js";
import { createObjectiveVerifierEvidence, prepareObjectiveVerificationPlan, verifyImplementationObjective } from "./objective-verification.js";

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
    private readonly secretScanPlan: unknown = prepareSecretScanPlan(),
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
    const specificationScopePlan = prepareSpecificationChangeScopePlan(inputs.specification);
    const specificationScope = assertSpecificationChangeScopeResult(
      await inspectSpecificationChangeScope(
        root,
        inputs.expectedBaseSha,
        inputs.specification,
        trustedPaths,
        specificationScopePlan,
        this.runner,
      ),
      specificationScopePlan,
    );
    requireSpecificationChangeScopeAccepted(specificationScope);
    const patchLimitPlan = prepareVerifiedPatchLimitPlan(inputs.repositoryLimits);
    const patchLimits = assertVerifiedPatchLimitResult(
      await inspectVerifiedPatchLimits(root, inputs.expectedBaseSha, patchLimitPlan, this.runner),
      patchLimitPlan,
    );
    requireVerifiedPatchWithinLimits(patchLimits);
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
    const ordinaryVerificationPassed = diff.allowed && specificationScope.outcome === "accepted"
      && sourceSafety.allowed && checks.every((check) => check.exitCode === 0);
    let targetedMutation: TargetedMutationResult | undefined;
    let targetedMutationComparison: TargetedMutationScoreComparison | undefined;
    let staticAnalysis: StaticAnalysisResult | undefined;
    let staticAnalysisComparison: StaticAnalysisFindingsComparison | undefined;
    let staticAnalysisIgnoredFindings: StaticAnalysisIgnoredFindingsResult | undefined;
    let staticAnalysisIgnoredFindingsComparison: StaticAnalysisIgnoredFindingsComparison | undefined;
    let broadExceptionSwallowing: BroadExceptionSwallowingResult | undefined;
    let broadExceptionSwallowingComparison: BroadExceptionSwallowingComparison | undefined;
    let validationBoundaries: ValidationBoundaryResult | undefined;
    let validationBoundaryComparison: ValidationBoundaryComparison | undefined;
    let testStrength: TestStrengthResult | undefined;
    let testStrengthComparison: TestStrengthComparison | undefined;
    let protectedRepositoryChanges: ProtectedRepositoryChangeResult | undefined;
    let protectedRepositoryChangeComparison: ProtectedRepositoryChangeComparison | undefined;
    let secretScan: SecretScanResult | undefined;
    let publicApiSurface: PublicApiSurfaceResult | undefined;
    let publicApiSurfaceComparison: PublicApiSurfaceComparison | undefined;
    let objectiveVerification: ObjectiveVerificationResult | undefined;
    if (ordinaryVerificationPassed && inputs.mutationMode === "full") {
      throw new Error("Full verifier mutation testing is unsupported; use the exact targeted mode.");
    }
    if (ordinaryVerificationPassed) {
      const baselineWorkspace = await createVerifierBaselineWorkspace(root, inputs, this.runner);
      try {
        await assertVerifierExecutionInputs(baselineWorkspace.path, inputs, this.runner);
        await assertVerifierCommandEnvironment(this.runner, inputs.commandEnvironment, baselineWorkspace.path);
        if (!(await verifyVerifierTestManifest(baselineWorkspace.path, inputs.manifest, key))) {
          throw new Error("Targeted mutation baseline does not contain the sealed verifier inputs.");
        }
        const baselineAdapter = await this.registry.resolve(baselineWorkspace.path);
        const currentAdapter = await this.registry.resolve(root);
        if (baselineAdapter.id !== currentAdapter.id) throw new Error("Verifier adapters are incomparable across baseline and current states.");
        const baselineStaticAnalysis = await executeVerifierStaticAnalysis(baselineWorkspace.path, baselineAdapter, inputs, key, this.runner);
        staticAnalysis = await executeVerifierStaticAnalysis(root, currentAdapter, inputs, key, this.runner);
        staticAnalysisComparison = compareStaticAnalysisFindings(baselineStaticAnalysis, staticAnalysis);
        const baselineStaticAnalysisIgnoredFindings = await executeStaticAnalysisIgnoredFindings(
          baselineWorkspace.path,
          baselineAdapter,
          inputs,
          key,
          this.runner,
        );
        staticAnalysisIgnoredFindings = await executeStaticAnalysisIgnoredFindings(root, currentAdapter, inputs, key, this.runner);
        staticAnalysisIgnoredFindingsComparison = compareStaticAnalysisIgnoredFindings(
          baselineStaticAnalysisIgnoredFindings,
          staticAnalysisIgnoredFindings,
        );
        const baselineBroadExceptionSwallowing = await executeBroadExceptionSwallowing(
          baselineWorkspace.path,
          baselineAdapter,
          inputs,
          key,
          this.runner,
        );
        broadExceptionSwallowing = await executeBroadExceptionSwallowing(root, currentAdapter, inputs, key, this.runner);
        broadExceptionSwallowingComparison = compareBroadExceptionSwallowing(
          baselineBroadExceptionSwallowing,
          broadExceptionSwallowing,
        );
        const baselineValidationBoundaries = await executeValidationBoundaries(
          baselineWorkspace.path,
          baselineAdapter,
          inputs,
          key,
          this.runner,
        );
        validationBoundaries = await executeValidationBoundaries(root, currentAdapter, inputs, key, this.runner);
        validationBoundaryComparison = compareValidationBoundaries(baselineValidationBoundaries, validationBoundaries);
        const baselineTestStrength = await executeTestStrength(
          baselineWorkspace.path,
          baselineAdapter,
          inputs,
          key,
          this.runner,
        );
        testStrength = await executeTestStrength(root, currentAdapter, inputs, key, this.runner);
        testStrengthComparison = compareTestStrength(baselineTestStrength, testStrength);
        const baselineProtectedRepositoryChanges = await executeProtectedRepositoryChangeInspection(
          baselineWorkspace.path,
          inputs,
          key,
          this.runner,
        );
        protectedRepositoryChanges = await executeProtectedRepositoryChangeInspection(root, inputs, key, this.runner);
        protectedRepositoryChangeComparison = compareProtectedRepositoryChanges(
          baselineProtectedRepositoryChanges,
          protectedRepositoryChanges,
        );
        secretScan = await executeSecretScan(root, inputs, diff.files, key, this.secretScanPlan, this.runner);
        const baselinePublicApiSurface = await executePublicApiSurface(baselineWorkspace.path, baselineAdapter, inputs, key, this.runner);
        publicApiSurface = await executePublicApiSurface(root, currentAdapter, inputs, key, this.runner);
        publicApiSurfaceComparison = comparePublicApiSurfaces(baselinePublicApiSurface, publicApiSurface);
        if (inputs.mutationMode === "targeted") {
          const targets = changedProductionTargets(diff.files, inputs.specification.allowedFiles);
          const baselineMutation = await executeTargetedMutation(
            baselineWorkspace.path,
            baselineAdapter,
            targets,
            inputs,
            key,
            this.runner,
          );
          targetedMutation = await executeTargetedMutation(root, currentAdapter, targets, inputs, key, this.runner);
          targetedMutationComparison = compareTargetedMutationScores(baselineMutation, targetedMutation);
        }
      } finally {
        await baselineWorkspace.cleanup();
      }
    }
    const preObjectiveVerificationPassed = ordinaryVerificationPassed
      && staticAnalysis !== undefined
      && staticAnalysisComparison !== undefined
      && staticAnalysisIgnoredFindings !== undefined
      && staticAnalysisIgnoredFindingsComparison !== undefined
      && broadExceptionSwallowing !== undefined
      && broadExceptionSwallowingComparison !== undefined
      && validationBoundaries !== undefined
      && validationBoundaryComparison !== undefined
      && testStrength !== undefined
      && testStrengthComparison !== undefined
      && protectedRepositoryChanges !== undefined
      && protectedRepositoryChangeComparison !== undefined
      && secretScan !== undefined
      && publicApiSurface !== undefined
      && publicApiSurfaceComparison !== undefined
      && (inputs.mutationMode !== "targeted" || (targetedMutation !== undefined && targetedMutationComparison !== undefined));
    if (preObjectiveVerificationPassed) {
      const objectiveEvidence = await createObjectiveVerifierEvidence(root, inputs, checks, {
        diff,
        specificationScope,
        patchLimits,
        sourceSafety,
        staticAnalysisComparison,
        staticAnalysisIgnoredFindingsComparison,
        broadExceptionSwallowingComparison,
        validationBoundaryComparison,
        testStrengthComparison,
        protectedRepositoryChangeComparison,
        secretScan,
        publicApiSurfaceComparison,
        ...(targetedMutationComparison ? { targetedMutationComparison } : {}),
      });
      const objectivePlan = prepareObjectiveVerificationPlan(inputs.specification, objectiveEvidence);
      objectiveVerification = assertObjectiveVerificationResult(
        verifyImplementationObjective(inputs.specification, objectiveEvidence, objectivePlan),
        objectivePlan,
      );
    }
    const passed = preObjectiveVerificationPassed && objectiveVerification !== undefined;
    const report = {
      schemaVersion: "verification-report/v1" as const,
      passed,
      expectedBaseSha: inputs.expectedBaseSha,
      verifierInputsSha256: inputs.integritySha256,
      diff,
      specificationScope,
      patchLimits,
      sourceSafety,
      checks,
      ...(staticAnalysis ? { staticAnalysis } : {}),
      ...(staticAnalysisComparison ? { staticAnalysisComparison } : {}),
      ...(staticAnalysisIgnoredFindings ? { staticAnalysisIgnoredFindings } : {}),
      ...(staticAnalysisIgnoredFindingsComparison ? { staticAnalysisIgnoredFindingsComparison } : {}),
      ...(broadExceptionSwallowing ? { broadExceptionSwallowing } : {}),
      ...(broadExceptionSwallowingComparison ? { broadExceptionSwallowingComparison } : {}),
      ...(validationBoundaries ? { validationBoundaries } : {}),
      ...(validationBoundaryComparison ? { validationBoundaryComparison } : {}),
      ...(testStrength ? { testStrength } : {}),
      ...(testStrengthComparison ? { testStrengthComparison } : {}),
      ...(protectedRepositoryChanges ? { protectedRepositoryChanges } : {}),
      ...(protectedRepositoryChangeComparison ? { protectedRepositoryChangeComparison } : {}),
      ...(secretScan ? { secretScan } : {}),
      ...(publicApiSurface ? { publicApiSurface } : {}),
      ...(publicApiSurfaceComparison ? { publicApiSurfaceComparison } : {}),
      ...(targetedMutation ? { targetedMutation } : {}),
      ...(targetedMutationComparison ? { targetedMutationComparison } : {}),
      ...(objectiveVerification ? { objectiveVerification } : {}),
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

async function executeVerifierStaticAnalysis(
  root: string,
  adapter: RepositoryAdapter,
  inputs: VerifierExecutionInputs,
  manifestKey: string,
  runner: CommandRunner,
): Promise<StaticAnalysisResult> {
  if (!adapter.prepareVerifierStaticAnalysis || !adapter.inspectVerifierStaticAnalysis) {
    throw new Error("Static analysis is unavailable for the selected repository adapter.");
  }
  const beforeState = await captureVerifierExecutionState(root, inputs.expectedBaseSha, runner);
  const plan = assertStaticAnalysisPlan(await adapter.prepareVerifierStaticAnalysis(root));
  const execution = await runVerifierCommand(runner, inputs.commandEnvironment, plan.command, root, plan.timeoutMs);
  const result = assertStaticAnalysisResult(await adapter.inspectVerifierStaticAnalysis(root, plan, execution), plan);
  if (!Array.isArray(adapter.staticAnalysisFindingIdentitySemantics)
    || adapter.staticAnalysisFindingIdentitySemantics.length < 1
    || adapter.staticAnalysisFindingIdentitySemantics.length > 16
    || !adapter.staticAnalysisFindingIdentitySemantics.includes(result.findingIdentitySemantics)) {
    throw new Error("Static-analysis result uses unsupported adapter finding-identity semantics.");
  }
  await assertVerifierExecutionStateUnchanged(root, inputs.expectedBaseSha, beforeState, runner);
  await assertVerifierExecutionInputs(root, inputs, runner);
  if (!(await verifyVerifierTestManifest(root, inputs.manifest, manifestKey))) {
    throw new Error("Static-analysis execution changed a sealed verifier input.");
  }
  return result;
}

async function executeStaticAnalysisIgnoredFindings(
  root: string,
  adapter: RepositoryAdapter,
  inputs: VerifierExecutionInputs,
  manifestKey: string,
  runner: CommandRunner,
): Promise<StaticAnalysisIgnoredFindingsResult> {
  if (!adapter.prepareStaticAnalysisIgnoredFindings || !adapter.inspectStaticAnalysisIgnoredFindings) {
    throw new Error("Static-analysis ignored-finding inspection is unavailable for the selected repository adapter.");
  }
  const beforeState = await captureVerifierExecutionState(root, inputs.expectedBaseSha, runner);
  const plan = assertStaticAnalysisIgnoredFindingsPlan(await adapter.prepareStaticAnalysisIgnoredFindings(root));
  const result = assertStaticAnalysisIgnoredFindingsResult(
    await adapter.inspectStaticAnalysisIgnoredFindings(root, plan),
    plan,
  );
  if (!Array.isArray(adapter.staticAnalysisIgnoredFindingIdentitySemantics)
    || adapter.staticAnalysisIgnoredFindingIdentitySemantics.length < 1
    || adapter.staticAnalysisIgnoredFindingIdentitySemantics.length > 16
    || !adapter.staticAnalysisIgnoredFindingIdentitySemantics.includes(result.ignoredFindingIdentitySemantics)) {
    throw new Error("Static-analysis ignored-findings result uses unsupported adapter identity semantics.");
  }
  await assertVerifierExecutionStateUnchanged(root, inputs.expectedBaseSha, beforeState, runner);
  await assertVerifierExecutionInputs(root, inputs, runner);
  if (!(await verifyVerifierTestManifest(root, inputs.manifest, manifestKey))) {
    throw new Error("Static-analysis ignored-finding inspection changed a sealed verifier input.");
  }
  return result;
}

async function executeBroadExceptionSwallowing(
  root: string,
  adapter: RepositoryAdapter,
  inputs: VerifierExecutionInputs,
  manifestKey: string,
  runner: CommandRunner,
): Promise<BroadExceptionSwallowingResult> {
  if (!adapter.prepareBroadExceptionSwallowing || !adapter.inspectBroadExceptionSwallowing) {
    throw new Error("Broad exception-swallowing inspection is unavailable for the selected repository adapter.");
  }
  const beforeState = await captureVerifierExecutionState(root, inputs.expectedBaseSha, runner);
  const plan = assertBroadExceptionSwallowingPlan(await adapter.prepareBroadExceptionSwallowing(root));
  const result = assertBroadExceptionSwallowingResult(
    await adapter.inspectBroadExceptionSwallowing(root, plan),
    plan,
  );
  if (!Array.isArray(adapter.broadExceptionSwallowingHazardIdentitySemantics)
    || adapter.broadExceptionSwallowingHazardIdentitySemantics.length < 1
    || adapter.broadExceptionSwallowingHazardIdentitySemantics.length > 16
    || !adapter.broadExceptionSwallowingHazardIdentitySemantics.includes(result.hazardIdentitySemantics)) {
    throw new Error("Broad exception-swallowing result uses unsupported adapter identity semantics.");
  }
  await assertVerifierExecutionStateUnchanged(root, inputs.expectedBaseSha, beforeState, runner);
  await assertVerifierExecutionInputs(root, inputs, runner);
  if (!(await verifyVerifierTestManifest(root, inputs.manifest, manifestKey))) {
    throw new Error("Broad exception-swallowing inspection changed a sealed verifier input.");
  }
  return result;
}

async function executeValidationBoundaries(
  root: string,
  adapter: RepositoryAdapter,
  inputs: VerifierExecutionInputs,
  manifestKey: string,
  runner: CommandRunner,
): Promise<ValidationBoundaryResult> {
  if (!adapter.prepareValidationBoundaries || !adapter.inspectValidationBoundaries) {
    throw new Error("Validation-boundary inspection is unavailable for the selected repository adapter.");
  }
  const beforeState = await captureVerifierExecutionState(root, inputs.expectedBaseSha, runner);
  const plan = assertValidationBoundaryPlan(await adapter.prepareValidationBoundaries(root));
  const result = assertValidationBoundaryResult(
    await adapter.inspectValidationBoundaries(root, plan),
    plan,
  );
  assertSupportedSemantics(adapter.validationBoundaryIdentitySemantics, result.boundaryIdentitySemantics, "boundary");
  assertSupportedSemantics(adapter.validationGuaranteeIdentitySemantics, result.guaranteeIdentitySemantics, "guarantee");
  assertSupportedSemantics(adapter.unvalidatedFlowIdentitySemantics, result.unvalidatedFlowIdentitySemantics, "unvalidated flow");
  await assertVerifierExecutionStateUnchanged(root, inputs.expectedBaseSha, beforeState, runner);
  await assertVerifierExecutionInputs(root, inputs, runner);
  if (!(await verifyVerifierTestManifest(root, inputs.manifest, manifestKey))) {
    throw new Error("Validation-boundary inspection changed a sealed verifier input.");
  }
  return result;
}

async function executeTestStrength(
  root: string,
  adapter: RepositoryAdapter,
  inputs: VerifierExecutionInputs,
  manifestKey: string,
  runner: CommandRunner,
): Promise<TestStrengthResult> {
  if (!adapter.prepareTestStrength || !adapter.inspectTestStrength) {
    throw new Error("Repository test-strength inspection is unavailable for the selected repository adapter.");
  }
  const beforeState = await captureVerifierExecutionState(root, inputs.expectedBaseSha, runner);
  const plan = assertTestStrengthPlan(await adapter.prepareTestStrength(root));
  const result = assertTestStrengthResult(await adapter.inspectTestStrength(root, plan), plan);
  assertAdapterSemantics(adapter.testIdentitySemantics, result.testIdentitySemantics, "test");
  assertAdapterSemantics(adapter.testExpectationIdentitySemantics, result.expectationIdentitySemantics, "expectation");
  assertAdapterSemantics(adapter.testCaseIdentitySemantics, result.caseIdentitySemantics, "case");
  await assertVerifierExecutionStateUnchanged(root, inputs.expectedBaseSha, beforeState, runner);
  await assertVerifierExecutionInputs(root, inputs, runner);
  if (!(await verifyVerifierTestManifest(root, inputs.manifest, manifestKey))) {
    throw new Error("Repository test-strength inspection changed a sealed verifier input.");
  }
  return result;
}

async function executeProtectedRepositoryChangeInspection(
  root: string,
  inputs: VerifierExecutionInputs,
  manifestKey: string,
  runner: CommandRunner,
): Promise<ProtectedRepositoryChangeResult> {
  const beforeState = await captureVerifierExecutionState(root, inputs.expectedBaseSha, runner);
  const plan = assertProtectedRepositoryChangePlan(prepareProtectedRepositoryChangePlan());
  const result = assertProtectedRepositoryChangeResult(
    await inspectProtectedRepositoryChanges(root, plan, runner),
    plan,
  );
  await assertVerifierExecutionStateUnchanged(root, inputs.expectedBaseSha, beforeState, runner);
  await assertVerifierExecutionInputs(root, inputs, runner);
  if (!(await verifyVerifierTestManifest(root, inputs.manifest, manifestKey))) {
    throw new Error("Protected repository-change inspection changed a sealed verifier input.");
  }
  return result;
}

async function executeSecretScan(
  root: string,
  inputs: VerifierExecutionInputs,
  diffFiles: readonly string[],
  manifestKey: string,
  planValue: unknown,
  runner: CommandRunner,
): Promise<SecretScanResult> {
  const beforeState = await captureVerifierExecutionState(root, inputs.expectedBaseSha, runner);
  const allowed = new Set(inputs.specification.allowedFiles);
  const productionPaths = [...new Set(diffFiles.filter((path) => allowed.has(path)))].sort();
  if (productionPaths.length < 1) throw new Error("Secret-scan authenticated production patch is empty.");
  const plan: SecretScanPlan = assertSecretScanPlan(planValue);
  const result = assertSecretScanResult(
    await scanVerifiedPatchForSecrets(root, inputs.expectedBaseSha, productionPaths, plan, runner),
    plan,
  );
  await assertVerifierExecutionStateUnchanged(root, inputs.expectedBaseSha, beforeState, runner);
  await assertVerifierExecutionInputs(root, inputs, runner);
  if (!(await verifyVerifierTestManifest(root, inputs.manifest, manifestKey))) {
    throw new Error("Secret-scan inspection changed a sealed verifier input.");
  }
  return result;
}

function assertAdapterSemantics(supported: readonly string[] | undefined, actual: string, name: string): void {
  if (!Array.isArray(supported) || supported.length < 1 || supported.length > 16 || !supported.includes(actual)) {
    throw new Error(`Test-strength result uses unsupported adapter ${name} identity semantics.`);
  }
}

function assertSupportedSemantics(supported: readonly string[] | undefined, actual: string, name: string): void {
  if (!Array.isArray(supported) || supported.length < 1 || supported.length > 16 || !supported.includes(actual)) {
    throw new Error(`Validation-boundary result uses unsupported adapter ${name} identity semantics.`);
  }
}

async function executePublicApiSurface(
  root: string,
  adapter: RepositoryAdapter,
  inputs: VerifierExecutionInputs,
  manifestKey: string,
  runner: CommandRunner,
): Promise<PublicApiSurfaceResult> {
  if (!adapter.preparePublicApiSurface || !adapter.inspectPublicApiSurface) {
    throw new Error("Public-API analysis is unavailable for the selected repository adapter.");
  }
  const beforeState = await captureVerifierExecutionState(root, inputs.expectedBaseSha, runner);
  const plan = assertPublicApiSurfacePlan(await adapter.preparePublicApiSurface(root));
  const execution = await runVerifierCommand(runner, inputs.commandEnvironment, plan.command, root, plan.timeoutMs);
  const result = assertPublicApiSurfaceResult(await adapter.inspectPublicApiSurface(root, plan, execution), plan);
  if (!Array.isArray(adapter.publicApiSymbolIdentitySemantics)
    || adapter.publicApiSymbolIdentitySemantics.length < 1
    || adapter.publicApiSymbolIdentitySemantics.length > 16
    || !adapter.publicApiSymbolIdentitySemantics.includes(result.symbolIdentitySemantics)) {
    throw new Error("Public-API result uses unsupported adapter symbol-identity semantics.");
  }
  await assertVerifierExecutionStateUnchanged(root, inputs.expectedBaseSha, beforeState, runner);
  await assertVerifierExecutionInputs(root, inputs, runner);
  if (!(await verifyVerifierTestManifest(root, inputs.manifest, manifestKey))) {
    throw new Error("Public-API execution changed a sealed verifier input.");
  }
  return result;
}

async function executeTargetedMutation(
  root: string,
  adapter: RepositoryAdapter,
  targets: readonly string[],
  inputs: VerifierExecutionInputs,
  manifestKey: string,
  runner: CommandRunner,
): Promise<TargetedMutationResult> {
  if (!adapter.prepareTargetedMutation || !adapter.inspectTargetedMutation) {
    throw new Error("Targeted mutation testing is unavailable for the selected repository adapter.");
  }
  const beforeMutationState = await captureVerifierExecutionState(root, inputs.expectedBaseSha, runner);
  const plan = assertTargetedMutationPlan(await adapter.prepareTargetedMutation(root, targets), targets);
  const execution = await runVerifierCommand(
    runner,
    inputs.commandEnvironment,
    plan.command,
    root,
    plan.timeoutMs,
  );
  const result = assertTargetedMutationResult(await adapter.inspectTargetedMutation(root, plan, execution), plan);
  if (!Array.isArray(adapter.targetedMutationInventorySemantics)
    || adapter.targetedMutationInventorySemantics.length < 1
    || adapter.targetedMutationInventorySemantics.length > 16
    || !adapter.targetedMutationInventorySemantics.includes(result.inventorySemantics)) {
    throw new Error("Targeted mutation result uses unsupported adapter inventory semantics.");
  }
  await assertVerifierExecutionStateUnchanged(root, inputs.expectedBaseSha, beforeMutationState, runner);
  await assertVerifierExecutionInputs(root, inputs, runner);
  if (!(await verifyVerifierTestManifest(root, inputs.manifest, manifestKey))) {
    throw new Error("Targeted mutation execution changed a sealed verifier input.");
  }
  return result;
}

function changedProductionTargets(diffFiles: readonly string[], allowedFiles: readonly string[]): readonly string[] {
  if (!Array.isArray(diffFiles) || !Array.isArray(allowedFiles)) throw new Error("Targeted mutation inputs are unavailable.");
  const allowed = new Set(allowedFiles);
  const targets = [...new Set(diffFiles.filter((path) => allowed.has(path)))].sort();
  if (targets.length < 1 || targets.length > 64) throw new Error("Targeted mutation production targets are missing or excessive.");
  if (targets.some((path) => !path || path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))) {
    throw new Error("Targeted mutation production target escaped the sealed specification allowlist.");
  }
  return targets;
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
