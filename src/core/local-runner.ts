import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AgentContext, AgentProvider, BuilderExecution, TestAgentExecution } from "../agents/agent-provider.js";
import type { AdapterGeneratedTestQualityInspection } from "../contracts.js";
import { loadConfig } from "../config.js";
import { CommandRunner } from "../infra/command-runner.js";
import { GitWorkspaceManager } from "../infra/git-workspace.js";
import { createTestManifest, runDirectory, writeArtifact } from "./artifacts.js";
import type { PipelineStages } from "./stages.js";
import {
  assertImprovementIntent,
  baselineMustFail,
  type ImprovementIntentContract,
} from "../domain/improvement-intent.js";
import {
  readPropertyTestExecutionProof,
  type PropertyTestExecutionProof,
} from "../domain/property-test-execution-proof.js";
import {
  createKnownMutationExecutionProof,
  type KnownMutationExecutionProof,
} from "../domain/known-mutation-execution-proof.js";
import {
  inspectGeneratedTestImplementation,
  requireBlackBoxTest,
  type TestImplementationInspection,
} from "../domain/test-implementation-inspection.js";
import {
  commandOutcome,
  decideGeneratedTestLifecycle,
  NewlyFlakyGeneratedTestError,
  readGeneratedTestLifecycleReport,
  type TestCommandOutcome,
} from "../domain/generated-test-lifecycle.js";

export interface LocalRunResult {
  readonly branch: string;
  readonly candidate: string;
  readonly baselineTestFailed: boolean;
  readonly baselineProofSatisfied: boolean;
  readonly verificationPassed: boolean;
  readonly publication: { readonly title: string; readonly body: string; readonly draft: boolean; readonly labels: readonly string[] };
}

export class LocalImprovementRunner {
  constructor(
    private readonly stages: PipelineStages,
    private readonly agents: AgentProvider,
    private readonly workspaceBase: string,
    private readonly manifestKey: string,
    private readonly runner = new CommandRunner(),
  ) {}

  async run(repository: string): Promise<LocalRunResult> {
    const analysis = await this.stages.analyse(repository);
    const spec = await this.stages.specify(repository);
    const date = process.env.DAILY_IMPROVER_RUN_DATE ?? new Date().toISOString().slice(0, 10);
    const slug = slugify(spec.title).slice(0, 42);
    const branch = `ai/daily/${date}-${slug}`;
    const isolated = await new GitWorkspaceManager(this.workspaceBase, this.runner).create(repository, `${date}-${slug}`, branch);
    try {
      await cp(runDirectory(repository), runDirectory(isolated.path), { recursive: true });
      const specPath = join(runDirectory(isolated.path), "spec.json");
      const adapter = await this.stagesAdapter(isolated.path);
      const profile = await adapter.profile(isolated.path);
      const config = await loadConfig(isolated.path);
      const improvementIntent = assertImprovementIntent(spec.improvementIntent);
      if (spec.propertyInvariants.length > 0 && !spec.propertyTestTarget) {
        throw new Error("A selected target is required when the specification requires property-test proof.");
      }
      const test = profile.capabilities.get("test");
      if (!test) throw new Error("A test capability is required for autonomous correctness work.");
      const allowedTestPaths = config.protected_paths.filter((path) => path === "tests" || path === "test" || path.startsWith("tests/") || path.startsWith("test/"));
      if (allowedTestPaths.length === 0) throw new Error("At least one protected test path is required for model-generated tests.");
      const commands = spec.verification.flatMap((kind) => {
        const capability = profile.capabilities.get(kind);
        return capability ? [{ purpose: kind, argv: capability.command }] : [];
      });
      const baseContext: AgentContext = {
        repository: isolated.path,
        spec,
        specPath,
        inputs: {
          repository: { language: profile.language, frameworks: profile.frameworks },
          allowedTestPaths,
          protectedFiles: [],
          commands,
          testConventions: [
            "Add focused regression or property tests using the repository test harness.",
            "Use only dependencies and loading mechanisms demonstrably available to the detected test command; the test must fail because of the selected defect, not missing tooling or autoloading.",
            "During every test command, write exact generated-test-lifecycle-report/v1 JSON to DAILY_IMPROVER_TEST_LIFECYCLE_PATH using DAILY_IMPROVER_TEST_LIFECYCLE_NONCE. Report every generated test path as executed, skipped, or disabled with its assertion count and a SHA-256 identity of its effective tolerance contract.",
            ...(test.framework === "pest" ? [
              "Use ordinary Pest test()/it() discovery without only(), skip(), or todo(); every declared test must contain an explicit expectation/assertion, and inline data providers must expose at least one bounded static case.",
            ] : []),
            ...(spec.propertyTestTarget ? [
              `Exercise the selected target ${spec.propertyTestTarget} across at least 32 unique generated inputs and check one approved property invariant for every input.`,
              "During the test command, write property-test-execution-proof/v1 JSON to DAILY_IMPROVER_PROPERTY_PROOF_PATH using DAILY_IMPROVER_PROPERTY_EXECUTION_NONCE. Include the generated test path, selected target, exact approved invariant, unique SHA-256 input digests, and execution/check/failure counts.",
            ] : []),
            ...(spec.knownMutation ? [
              `The selected target is a known ${spec.knownMutation.operator} mutant. The generated test must fail for the approved ${spec.knownMutation.criterion.kind} before the builder runs.`,
            ] : []),
          ],
          builderConventions: ["Implement only the approved specification and preserve existing public interfaces."],
        },
      };
      const testExecution = await this.agents.generateTests(baseContext);
      await persistAgentExecution(isolated.path, "test", testExecution);

      const propertyProofRuntimePath = join(isolated.path, ".daily-improver", "property-test-execution-proof.json");
      const propertyExecutionNonce = randomBytes(16).toString("hex");
      await mkdir(join(isolated.path, ".daily-improver"), { recursive: true });
      await rm(propertyProofRuntimePath, { force: true });
      const changedTests = await changedTestPaths(this.runner, isolated.path, allowedTestPaths);
      if (changedTests.length === 0) throw new Error("The test agent did not add or change a generated test.");
      const testSha256 = await hashFiles(isolated.path, changedTests);
      const baselineAttempts = await runLifecycleAttempts(this.runner, isolated.path, test.command, changedTests, "baseline", spec.propertyTestTarget ? {
        DAILY_IMPROVER_PROPERTY_PROOF_PATH: propertyProofRuntimePath,
        DAILY_IMPROVER_PROPERTY_EXECUTION_NONCE: propertyExecutionNonce,
        DAILY_IMPROVER_PROPERTY_TARGET: spec.propertyTestTarget,
        DAILY_IMPROVER_PROPERTY_INVARIANTS: JSON.stringify(spec.propertyInvariants),
      } : {});
      const baseline = baselineAttempts.results[0]!;
      const baselineClassification = adapter.classifyFailure?.(`${baseline.stdout}\n${baseline.stderr}`) ?? "unclassified";
      const baselineLifecycle = decideGeneratedTestLifecycle({
        phase: "baseline",
        command: test.command,
        testSha256,
        attempts: baselineAttempts.outcomes,
        expectedExit: baselineMustFail(improvementIntent) ? "nonzero" : "zero",
      });
      const baselineProof = proveBaseline(improvementIntent, baseline.exitCode, baselineClassification);
      for (const result of baselineAttempts.results.slice(1)) {
        proveBaseline(improvementIntent, result.exitCode, adapter.classifyFailure?.(`${result.stdout}\n${result.stderr}`) ?? "unclassified");
      }
      await writeArtifact(isolated.path, "generated-test-baseline-lifecycle.json", baselineLifecycle);
      let propertyProof: PropertyTestExecutionProof | undefined;
      let knownMutationProof: KnownMutationExecutionProof | undefined;
      let implementationInspection: TestImplementationInspection | undefined;
      let adapterQualityInspection: AdapterGeneratedTestQualityInspection | undefined;
      if (spec.propertyTestTarget) {
        propertyProof = await readPropertyTestExecutionProof(propertyProofRuntimePath, {
          executionNonce: propertyExecutionNonce,
          target: spec.propertyTestTarget,
          approvedInvariants: spec.propertyInvariants,
          changedTestPaths: changedTests,
          baselineMustFail: baselineMustFail(improvementIntent),
        });
        await writeArtifact(isolated.path, "property-test-execution-proof.json", propertyProof);
      }
      if (spec.knownMutation) {
        if (!propertyProof || propertyProof.invariant !== spec.knownMutation.criterion.statement || propertyProof.failedInvariantCheckCount < 1) {
          throw new Error("Known mutation proof did not identify a relevant generated test failing the approved criterion.");
        }
        knownMutationProof = createKnownMutationExecutionProof({
          exitCode: baseline.exitCode,
          stdout: baseline.stdout,
          stderr: baseline.stderr,
          durationMs: baseline.durationMs,
          classification: "property-invariant-violation",
        }, {
          requirement: spec.knownMutation,
          approvedPropertyInvariants: spec.propertyInvariants,
          approvedAcceptanceCriteria: spec.acceptanceCriteria,
          changedTestPaths: changedTests,
          relevantTestPath: propertyProof.testPath,
          command: test.command,
        });
        await writeArtifact(isolated.path, "known-mutation-execution-proof.json", knownMutationProof);
      }
      if (propertyProof && spec.propertyTestTarget) {
        implementationInspection = await inspectGeneratedTestImplementation({
          root: isolated.path,
          testPath: propertyProof.testPath,
          observedTestPaths: changedTests,
          target: spec.propertyTestTarget,
          criterion: { kind: "property-invariant", statement: propertyProof.invariant },
          approvedPropertyInvariants: spec.propertyInvariants,
          approvedAcceptanceCriteria: spec.acceptanceCriteria,
        });
        await writeArtifact(isolated.path, "test-implementation-inspection.json", implementationInspection);
        requireBlackBoxTest(implementationInspection);
      }
      if (adapter.inspectGeneratedTestQuality) {
        adapterQualityInspection = await adapter.inspectGeneratedTestQuality({
          root: isolated.path,
          framework: test.framework,
          selectedTestPath: propertyProof?.testPath ?? changedTests[0]!,
          observedTestPaths: changedTests,
          baselineLifecycle,
        });
        if (adapterQualityInspection) {
          if (adapterQualityInspection.outcome !== "accepted") throw new Error("Adapter generated-test quality inspection rejected the generated test.");
          await writeArtifact(isolated.path, "adapter-generated-test-quality.json", adapterQualityInspection);
        }
      }
      await rm(propertyProofRuntimePath, { force: true });
      await writeArtifact(isolated.path, "test-plan.json", {
        schemaVersion: "test-plan/v7",
        improvementIntent,
        baseline: baselineProof,
        command: test.command,
        propertyInvariants: spec.propertyInvariants,
        generatedTestLifecycle: {
          schemaVersion: baselineLifecycle.schemaVersion,
          artifact: "generated-test-baseline-lifecycle.json",
          attempts: baselineLifecycle.attempts.length,
          testPaths: Object.keys(baselineLifecycle.testSha256),
        },
        ...(propertyProof ? {
          propertyTestExecutionProof: {
            schemaVersion: propertyProof.schemaVersion,
            artifact: "property-test-execution-proof.json",
            target: propertyProof.target,
            invariant: propertyProof.invariant,
            generatedInputCount: propertyProof.inputDigests.length,
          },
        } : {}),
        ...(knownMutationProof ? {
          knownMutationExecutionProof: {
            schemaVersion: knownMutationProof.schemaVersion,
            artifact: "known-mutation-execution-proof.json",
            mutationId: knownMutationProof.mutationId,
            testPath: knownMutationProof.testPath,
            target: knownMutationProof.target,
            criterion: knownMutationProof.criterion,
          },
        } : {}),
        ...(implementationInspection ? {
          implementationInspection: {
            schemaVersion: implementationInspection.schemaVersion,
            artifact: "test-implementation-inspection.json",
            testPath: implementationInspection.testPath,
            target: implementationInspection.target,
            criterion: implementationInspection.criterion,
            outcome: implementationInspection.outcome,
          },
        } : {}),
        ...(adapterQualityInspection ? {
          adapterQualityInspection: {
            schemaVersion: adapterQualityInspection.schemaVersion,
            artifact: "adapter-generated-test-quality.json",
            adapter: adapterQualityInspection.adapter,
            framework: adapterQualityInspection.framework,
            selectedTestPath: adapterQualityInspection.selectedTestPath,
            outcome: adapterQualityInspection.outcome,
          },
        } : {}),
      });
      const manifest = await createTestManifest(isolated.path, this.manifestKey);
      await writeArtifact(isolated.path, "test-manifest.json", manifest);

      const builderContext: AgentContext = {
        ...baseContext,
        inputs: {
          ...baseContext.inputs,
          protectedFiles: [...new Set([...config.protected_paths, ...Object.keys(manifest.files)])],
        },
      };
      const builderExecution = await this.agents.build(builderContext);
      const trustedBuilderArtifacts = await persistAgentExecution(isolated.path, "build", builderExecution);
      await this.runner.run(["git", "add", "-N", "."], isolated.path);
      const verification = await this.stages.verify(isolated.path, "HEAD", this.manifestKey, trustedBuilderArtifacts);
      const verificationAttempts = await runLifecycleAttempts(this.runner, isolated.path, test.command, changedTests, "verification");
      const verificationLifecycle = decideGeneratedTestLifecycle({
        phase: "verification",
        command: test.command,
        testSha256: await hashFiles(isolated.path, changedTests),
        attempts: verificationAttempts.outcomes,
        expectedExit: "zero",
        baseline: baselineLifecycle,
      });
      await writeArtifact(isolated.path, "generated-test-verification-lifecycle.json", verificationLifecycle);
      const publication = await this.stages.publicationRequest(isolated.path);
      await this.runner.run(["git", "add", "."], isolated.path);
      const commit = await this.runner.run(["git", "commit", "-m", `fix: ${spec.title}`], isolated.path);
      if (commit.exitCode !== 0) throw new Error(`Unable to commit verified improvement: ${commit.stderr.trim()}`);
      return {
        branch: isolated.branch,
        candidate: analysis.candidates[0]?.id ?? "unknown",
        baselineTestFailed: baseline.exitCode !== 0,
        baselineProofSatisfied: true,
        verificationPassed: verification.passed,
        publication,
      };
    } catch (error) {
      if (error instanceof NewlyFlakyGeneratedTestError) {
        await this.stages.quarantine(repository, analysis.candidates[0]?.id ?? "unknown", error.phase, error.reason);
      }
      throw error;
    } finally {
      await isolated.cleanup();
    }
  }

  private async stagesAdapter(root: string) {
    return await this.stages.resolveAdapter(root);
  }
}

async function runLifecycleAttempts(
  runner: CommandRunner,
  root: string,
  command: readonly string[],
  testPaths: readonly string[],
  phase: "baseline" | "verification",
  firstAttemptEnvironment: Readonly<Record<string, string>> = {},
): Promise<{ readonly results: readonly Awaited<ReturnType<CommandRunner["run"]>>[]; readonly outcomes: readonly TestCommandOutcome[] }> {
  const reportPath = join(root, ".daily-improver", "generated-test-lifecycle-report.json");
  const results = [];
  const outcomes: TestCommandOutcome[] = [];
  for (let index = 0; index < 3; index++) {
    const nonce = randomBytes(16).toString("hex");
    await rm(reportPath, { force: true });
    const result = await runner.run(command, root, undefined, {
      ...(index === 0 ? firstAttemptEnvironment : {}),
      DAILY_IMPROVER_TEST_LIFECYCLE_PATH: reportPath,
      DAILY_IMPROVER_TEST_LIFECYCLE_NONCE: nonce,
      DAILY_IMPROVER_TEST_LIFECYCLE_PHASE: phase,
      DAILY_IMPROVER_GENERATED_TEST_PATHS: JSON.stringify(testPaths),
    });
    const report = await readGeneratedTestLifecycleReport(reportPath, nonce, testPaths);
    results.push(result);
    outcomes.push(commandOutcome(index + 1, result, report));
  }
  await rm(reportPath, { force: true });
  return { results, outcomes };
}

async function hashFiles(root: string, paths: readonly string[]): Promise<Readonly<Record<string, string>>> {
  const entries = await Promise.all([...paths].sort().map(async (path) => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")] as const));
  return Object.fromEntries(entries);
}

async function changedTestPaths(
  runner: CommandRunner,
  root: string,
  allowedTestPaths: readonly string[],
): Promise<readonly string[]> {
  const result = await runner.run(["git", "ls-files", "--modified", "--others", "--exclude-standard"], root);
  if (result.exitCode !== 0) throw new Error(`Unable to identify generated property tests: ${result.stderr.trim()}`);
  return result.stdout.split("\n")
    .map((path) => path.trim())
    .filter((path) => path.length > 0 && allowedTestPaths.some((allowed) => {
      const wildcardIndex = allowed.search(/[?*\[]/);
      const prefix = (wildcardIndex === -1 ? allowed : allowed.slice(0, wildcardIndex)).replace(/\/$/, "");
      return path === allowed || path === prefix || path.startsWith(`${prefix}/`);
    }))
    .sort();
}

export function defectBaselineFailureIsCredible(classification: string): boolean {
  return classification !== "syntax"
    && classification !== "resource-limit"
    && classification !== "dependency-or-autoload";
}

export interface BaselineProofResult {
  readonly expected: "fail" | "pass";
  readonly outcome: "failed-as-expected" | "passed-as-expected";
  readonly classification?: string;
}

export function proveBaseline(
  intent: ImprovementIntentContract,
  exitCode: number,
  classification: string,
): BaselineProofResult {
  const validated = assertImprovementIntent(intent);
  if (!Number.isInteger(exitCode) || exitCode < 0) throw new Error("Baseline command exit code is malformed.");
  if (baselineMustFail(validated)) {
    if (exitCode === 0) throw new Error("Generated defect regression test did not fail against baseline behavior.");
    if (!defectBaselineFailureIsCredible(classification)) {
      throw new Error(`Generated defect test failed for a non-behavioral reason: ${classification}.`);
    }
    return { expected: "fail", outcome: "failed-as-expected", classification };
  }
  if (exitCode !== 0) {
    throw new Error(`Generated ${validated.intent} baseline proof must pass before and after the change.`);
  }
  return { expected: "pass", outcome: "passed-as-expected" };
}

export async function persistAgentExecution(
  root: string,
  stage: "test" | "build",
  execution: TestAgentExecution | BuilderExecution | void,
): Promise<readonly string[]> {
  if (!execution) return [];
  const usagePath = await writeArtifact(root, `${stage}-agent-usage.json`, {
    schemaVersion: execution.routingDecision ? "agent-usage/v4" : execution.requestAttempts ? "agent-usage/v3" : execution.budgetDecision ? "agent-usage/v2" : "agent-usage/v1",
    stage,
    ...execution.usage,
    ...(execution.budgetDecision ? { budgetDecision: execution.budgetDecision } : {}),
    ...(execution.requestAttempts ? { requestAttempts: execution.requestAttempts } : {}),
    ...(execution.routingDecision ? { routingDecision: execution.routingDecision } : {}),
  });
  const rationalePath = await writeArtifact(root, `${stage}-agent-rationale.json`, {
    schemaVersion: "agent-rationale/v1",
    trust: "untrusted-model-output",
    stage,
    ...execution.rationale,
  });
  return [relative(root, usagePath), relative(root, rationalePath)];
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
