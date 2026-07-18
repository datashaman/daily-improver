import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import type { AgentContext } from "../src/agents/agent-provider.js";
import { createTrustedRunnerStructuredProvider } from "../src/agents/trusted-runner-structured-provider.js";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { OpenPullRequestStateSource, UnresolvedFindingStateSource } from "../src/contracts.js";
import { createTestManifest, runDirectory, writeArtifact } from "../src/core/artifacts.js";
import { persistAgentExecution } from "../src/core/local-runner.js";
import { readPropertyTestExecutionProof } from "../src/domain/property-test-execution-proof.js";
import { createKnownMutationExecutionProof } from "../src/domain/known-mutation-execution-proof.js";
import { inspectGeneratedTestImplementation, requireBlackBoxTest } from "../src/domain/test-implementation-inspection.js";
import { CommandRunner } from "../src/infra/command-runner.js";
import {
  assertWorkspaceCanBeCreated,
  loadLiveTrustedRunnerInvocation,
} from "./support/live-trusted-runner-configuration.js";

test("MoneyAllocator passes through the live trusted structured provider", async (context) => {
  const invocation = await loadLiveTrustedRunnerInvocation(process.env);
  if (invocation.status === "skip") {
    context.skip(invocation.reason);
    return;
  }

  const live = invocation.value;
  await assertWorkspaceCanBeCreated(live.workspace);
  const stateDirectory = `${live.workspace}-state`;
  await assertWorkspaceCanBeCreated(stateDirectory);
  await mkdir(live.workspace);
  await mkdir(stateDirectory);
  const previousRunDate = process.env.DAILY_IMPROVER_RUN_DATE;
  const runDate = new Date().toISOString().slice(0, 10);
  process.env.DAILY_IMPROVER_RUN_DATE = runDate;
  const shell = new CommandRunner();

  try {
    await cp(join(process.cwd(), "test", "fixtures", "laravel-money-allocator"), live.workspace, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await expectSuccess(shell.run(["git", "init", "-b", "main"], live.workspace));
    await expectSuccess(shell.run(["git", "config", "user.email", "live-improver@example.test"], live.workspace));
    await expectSuccess(shell.run(["git", "config", "user.name", "Daily Improver Live Proof"], live.workspace));
    await expectSuccess(shell.run(["git", "add", "."], live.workspace));
    await expectSuccess(shell.run(["git", "commit", "-m", "fixture baseline"], live.workspace));

    const app = createApplication(stateDirectory, openPullRequests(), unresolvedFindings());
    const analysis = await app.stages.analyse(live.workspace);
    const spec = await app.stages.specify(live.workspace);
    assert.equal(analysis.candidates.length, 1);
    assert.ok(spec.propertyTestTarget, "The live property proof requires a selected target.");
    assert.ok(spec.knownMutation, "The live proof requires an applicable known mutation.");

    const provider = createTrustedRunnerStructuredProvider(live.configuration, {
      endpointResolver: { async resolve() { return live.endpointResolution; } },
      identitySource: live.identitySource,
      credentialExchangeResolver: { async resolve() { return live.exchangeResolution; } },
    });
    const adapter = await app.stages.resolveAdapter(live.workspace);
    const profile = await adapter.profile(live.workspace);
    const configuration = await loadConfig(live.workspace);
    const verifierPreparation = await app.stages.prepareVerification(live.workspace, "HEAD");
    const testCapability = profile.capabilities.get("test");
    assert.ok(testCapability, "The live fixture must expose a test capability.");
    const allowedTestPaths = configuration.protected_paths.filter((path) =>
      path === "tests" || path === "test" || path.startsWith("tests/") || path.startsWith("test/")
    );
    assert.ok(allowedTestPaths.length > 0, "The live fixture must expose a protected test path.");
    const commands = spec.verification.flatMap((kind) => {
      const capability = profile.capabilities.get(kind);
      return capability ? [{ purpose: kind, argv: capability.command }] : [];
    });
    const baseContext: AgentContext = {
      repository: live.workspace,
      spec,
      specPath: join(runDirectory(live.workspace), "spec.json"),
      inputs: {
        repository: { language: profile.language, frameworks: profile.frameworks },
        allowedTestPaths,
        protectedFiles: [],
        commands,
        testConventions: [
          "Add a focused property test using the repository test harness.",
          `Exercise ${spec.propertyTestTarget} across at least 32 unique generated inputs and check one exact approved invariant for every input.`,
          "During the test command, write property-test-execution-proof/v1 JSON to DAILY_IMPROVER_PROPERTY_PROOF_PATH using DAILY_IMPROVER_PROPERTY_EXECUTION_NONCE.",
        ],
        builderConventions: ["Implement only the approved specification and preserve existing public interfaces."],
      },
    };

    const testExecution = await provider.generateTests(baseContext);
    await assertDeclaredFilesExist(live.workspace, testExecution.rationale.changedFiles);
    await persistAgentExecution(live.workspace, "test", testExecution);
    const proofRuntimePath = join(live.workspace, ".daily-improver", "property-test-execution-proof.json");
    const executionNonce = randomBytes(16).toString("hex");
    await mkdir(join(live.workspace, ".daily-improver"), { recursive: true });
    const baseline = await shell.run(testCapability.command, live.workspace, undefined, {
      DAILY_IMPROVER_PROPERTY_PROOF_PATH: proofRuntimePath,
      DAILY_IMPROVER_PROPERTY_EXECUTION_NONCE: executionNonce,
      DAILY_IMPROVER_PROPERTY_TARGET: spec.propertyTestTarget,
      DAILY_IMPROVER_PROPERTY_INVARIANTS: JSON.stringify(spec.propertyInvariants),
    });
    assert.notEqual(baseline.exitCode, 0, "The generated defect test must fail against the baseline.");
    const observedChanges = await expectSuccess(shell.run(["git", "ls-files", "--modified", "--others", "--exclude-standard"], live.workspace));
    const changedTestPaths = observedChanges.stdout.split("\n").filter((path) => path.startsWith("tests/"));
    const propertyProof = await readPropertyTestExecutionProof(proofRuntimePath, {
      executionNonce,
      target: spec.propertyTestTarget,
      approvedInvariants: spec.propertyInvariants,
      changedTestPaths,
      baselineMustFail: true,
    });
    await writeArtifact(live.workspace, "property-test-execution-proof.json", propertyProof);
    const mutationProof = createKnownMutationExecutionProof({
      exitCode: baseline.exitCode,
      stdout: baseline.stdout,
      stderr: baseline.stderr,
      durationMs: baseline.durationMs,
      classification: "property-invariant-violation",
    }, {
      requirement: spec.knownMutation,
      approvedPropertyInvariants: spec.propertyInvariants,
      approvedAcceptanceCriteria: spec.acceptanceCriteria,
      changedTestPaths,
      relevantTestPath: propertyProof.testPath,
      command: testCapability.command,
    });
    await writeArtifact(live.workspace, "known-mutation-execution-proof.json", mutationProof);
    const implementationInspection = await inspectGeneratedTestImplementation({
      root: live.workspace,
      testPath: propertyProof.testPath,
      observedTestPaths: changedTestPaths,
      target: spec.propertyTestTarget,
      criterion: { kind: "property-invariant", statement: propertyProof.invariant },
      approvedPropertyInvariants: spec.propertyInvariants,
      approvedAcceptanceCriteria: spec.acceptanceCriteria,
    });
    await writeArtifact(live.workspace, "test-implementation-inspection.json", implementationInspection);
    requireBlackBoxTest(implementationInspection);
    await rm(proofRuntimePath, { force: true });
    await writeArtifact(live.workspace, "test-plan.json", {
      schemaVersion: "test-plan/v5",
      improvementIntent: spec.improvementIntent,
      baseline: { expected: "fail", outcome: "failed-as-expected" },
      command: testCapability.command,
      propertyInvariants: spec.propertyInvariants,
      propertyTestExecutionProof: {
        schemaVersion: propertyProof.schemaVersion,
        artifact: "property-test-execution-proof.json",
        target: propertyProof.target,
        invariant: propertyProof.invariant,
        generatedInputCount: propertyProof.inputDigests.length,
      },
      knownMutationExecutionProof: {
        schemaVersion: mutationProof.schemaVersion,
        artifact: "known-mutation-execution-proof.json",
        mutationId: mutationProof.mutationId,
        testPath: mutationProof.testPath,
        target: mutationProof.target,
        criterion: mutationProof.criterion,
      },
      implementationInspection: {
        schemaVersion: implementationInspection.schemaVersion,
        artifact: "test-implementation-inspection.json",
        testPath: implementationInspection.testPath,
        target: implementationInspection.target,
        criterion: implementationInspection.criterion,
        outcome: implementationInspection.outcome,
      },
    });
    const manifestKey = randomBytes(32).toString("hex");
    const manifest = await createTestManifest(live.workspace, manifestKey);
    await writeArtifact(live.workspace, "test-manifest.json", manifest);
    const verifierInputs = await app.stages.sealVerification(live.workspace, verifierPreparation, manifest);

    const builderContext: AgentContext = {
      ...baseContext,
      inputs: {
        ...baseContext.inputs,
        protectedFiles: [...new Set([...configuration.protected_paths, ...Object.keys(manifest.files)])],
      },
    };
    const builderExecution = await provider.build(builderContext);
    await assertDeclaredFilesExist(live.workspace, builderExecution.rationale.changedFiles);
    await persistAgentExecution(live.workspace, "build", builderExecution);
    await expectSuccess(shell.run(["git", "add", "-N", "."], live.workspace));
    const verification = await app.stages.verify(live.workspace, verifierInputs, manifestKey);
    assert.equal(verification.passed, true);
    const publication = await app.stages.publicationRequest(live.workspace, {
      repository: live.workspace,
      reference: "HEAD",
    });
    assert.equal(publication.draft, true);
    await assertSanitizedArtifacts(live.workspace, live.sensitiveValues);
    assert.equal(testExecution.routingDecision?.stage, "test");
    assert.equal(builderExecution.routingDecision?.stage, "build");
    assert.equal(testExecution.requestAttempts?.attempts.at(-1)?.classification, "completed");
    assert.equal(builderExecution.requestAttempts?.attempts.at(-1)?.classification, "completed");
  } finally {
    if (previousRunDate === undefined) delete process.env.DAILY_IMPROVER_RUN_DATE;
    else process.env.DAILY_IMPROVER_RUN_DATE = previousRunDate;
    await rm(live.workspace, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

function openPullRequests(): OpenPullRequestStateSource {
  return {
    current: async (observedAt) => ({
      schemaVersion: "open-pull-request-state/v1",
      repositoryId: "b".repeat(64),
      observedAt,
      openPullRequests: 0,
    }),
  };
}

function unresolvedFindings(): UnresolvedFindingStateSource {
  return {
    current: async (observedAt) => ({
      schemaVersion: "unresolved-finding-state/v1",
      repositoryId: "f".repeat(64),
      observedAt,
      findingIds: [],
    }),
  };
}

async function assertDeclaredFilesExist(root: string, files: readonly string[]): Promise<void> {
  assert.ok(files.length > 0, "The live endpoint must declare at least one changed file.");
  for (const file of files) {
    assert.equal((await lstat(join(root, file))).isFile(), true, `The live endpoint did not materialize ${file}.`);
  }
}

async function assertSanitizedArtifacts(root: string, sensitiveValues: readonly string[]): Promise<void> {
  for await (const path of glob(".ai/runs/**/*.json", { cwd: root })) {
    const content = await readFile(join(root, path), "utf8");
    for (const value of sensitiveValues) {
      assert.equal(content.includes(value), false, `${relative(root, join(root, path))} retained runner-owned sensitive input.`);
    }
  }
}

async function expectSuccess<T extends { exitCode: number; stderr: string }>(promise: Promise<T>): Promise<T> {
  const result = await promise;
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}
