import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentContext, AgentProvider, BuilderExecution, TestAgentExecution } from "../src/agents/agent-provider.js";
import { createApplication } from "../src/app.js";
import { defectBaselineFailureIsCredible, LocalImprovementRunner } from "../src/core/local-runner.js";
import { CommandRunner } from "../src/infra/command-runner.js";
import type { OpenPullRequestStateSource, UnresolvedFindingStateSource } from "../src/contracts.js";

class ProvingAgent implements AgentProvider {
  async generateTests(context: AgentContext): Promise<TestAgentExecution> {
    const path = join(context.repository, "tests", "Property", "MoneyAllocatorInvariantTest.php");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `<?php

declare(strict_types=1);

use App\\Domain\\MoneyAllocator;

$allocator = new MoneyAllocator();
$inputDigests = [];
$failures = [];
for ($total = 0; $total <= 50; $total++) {
    for ($parts = 1; $parts <= 10; $parts++) {
        $inputDigests[] = hash('sha256', json_encode([$total, $parts], JSON_THROW_ON_ERROR));
        $allocation = $allocator->allocate($total, $parts);
        if (array_sum($allocation) !== $total) {
            $failures[] = "Allocation did not preserve total {$total} across {$parts} parts.";
        }
    }
}

$proofPath = getenv('DAILY_IMPROVER_PROPERTY_PROOF_PATH');
$executionNonce = getenv('DAILY_IMPROVER_PROPERTY_EXECUTION_NONCE');
$target = getenv('DAILY_IMPROVER_PROPERTY_TARGET');
$invariants = json_decode(getenv('DAILY_IMPROVER_PROPERTY_INVARIANTS') ?: '[]', true, 512, JSON_THROW_ON_ERROR);
if (is_string($proofPath) && is_string($executionNonce) && is_string($target) && isset($invariants[0])) {
    file_put_contents($proofPath, json_encode([
        'schemaVersion' => 'property-test-execution-proof/v1',
        'executionNonce' => $executionNonce,
        'testPath' => 'tests/Property/MoneyAllocatorInvariantTest.php',
        'target' => $target,
        'invariant' => $invariants[0],
        'inputDigests' => $inputDigests,
        'targetExecutionCount' => count($inputDigests),
        'invariantCheckCount' => count($inputDigests),
        'failedInvariantCheckCount' => count($failures),
    ], JSON_THROW_ON_ERROR));
}
if ($failures !== []) {
    throw new RuntimeException($failures[0]);
}
`);
    const budgetDecision = fixtureBudgetDecision("test", 0, 0);
    return {
      usage: fixtureUsage,
      budgetDecision,
      requestAttempts: fixtureRequestAttempts(budgetDecision),
      routingDecision: fixtureRoutingDecision("test"),
      rationale: {
        summary: "Added the allocation invariant test.",
        changedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php"],
        tests: [{
          path: "tests/Property/MoneyAllocatorInvariantTest.php",
          purpose: "Prove allocation totals are preserved.",
          invariants: ["sum(allocation) equals total"],
        }],
      },
    };
  }

  async build(context: AgentContext): Promise<BuilderExecution> {
    await writeFile(join(context.repository, "app", "Domain", "MoneyAllocator.php"), `<?php

declare(strict_types=1);

namespace App\\Domain;

final class MoneyAllocator
{
    /** @return list<int> */
    public function allocate(int $total, int $parts): array
    {
        if ($total < 0) {
            throw new \\InvalidArgumentException('Total must be non-negative.');
        }
        if ($parts < 1) {
            throw new \\InvalidArgumentException('Parts must be positive.');
        }

        $share = intdiv($total, $parts);
        $remainder = $total % $parts;
        $allocation = array_fill(0, $parts, $share);
        for ($index = 0; $index < $remainder; $index++) {
            $allocation[$index]++;
        }

        return $allocation;
    }
}
`);
    const budgetDecision = fixtureBudgetDecision("build", 0, 0);
    return {
      usage: fixtureUsage,
      budgetDecision,
      requestAttempts: fixtureRequestAttempts(budgetDecision),
      routingDecision: fixtureRoutingDecision("build"),
      rationale: {
        summary: "Distributed the allocation remainder.",
        changedFiles: ["app/Domain/MoneyAllocator.php"],
        implementationNotes: ["Preserved the public method signature."],
      },
    };
  }
}

class SourceInspectingAgent extends ProvingAgent {
  buildCalled = false;

  override async generateTests(context: AgentContext): Promise<TestAgentExecution> {
    const execution = await super.generateTests(context);
    await appendFile(
      join(context.repository, "tests", "Property", "MoneyAllocatorInvariantTest.php"),
      "\nfile_get_contents(__DIR__ . '/../../app/Domain/MoneyAllocator.php');\n",
      "utf8",
    );
    return execution;
  }

  override async build(context: AgentContext): Promise<BuilderExecution> {
    this.buildCalled = true;
    return await super.build(context);
  }
}

const fixtureUsage = {
  provider: "deterministic-fixture",
  model: "fixture-model-v1",
  inputTokens: 120,
  outputTokens: 80,
  latencyMs: 25,
  estimatedCostUsd: 0,
} as const;

function fixtureBudgetDecision(stage: "test" | "build", before: number, after: number) {
  return {
    schemaVersion: "model-cost-budget-decision/v2" as const,
    status: "approved" as const,
    accounting: "validated-usage" as const,
    stage,
    stageLimitUsd: 0.5,
    dailyLimitUsd: 1,
    specificationLimitUsd: 1,
    reservedCostUsd: 0.25,
    actualCostUsd: 0,
    dailyCommittedBeforeUsd: before,
    dailyCommittedAfterUsd: after,
    specificationCommittedBeforeUsd: before,
    specificationCommittedAfterUsd: after,
  };
}

function fixtureRequestAttempts(budgetDecision: ReturnType<typeof fixtureBudgetDecision>) {
  return {
    schemaVersion: "model-request-attempts/v1" as const,
    maxAttempts: 1,
    attempts: [{ attempt: 1, classification: "completed" as const, budgetDecision }],
  };
}

function fixtureRoutingDecision(stage: "test" | "build") {
  return {
    schemaVersion: "task-complexity-decision/v1" as const,
    stage,
    complexity: "lower" as const,
    score: 0,
    inputs: {
      maxFiles: 2,
      maxChangedLines: 80,
      acceptanceCriteria: 1,
      propertyInvariants: 1,
      evidenceItems: 1,
    },
    route: {
      id: `fixture-${stage}-lower`,
      provider: fixtureUsage.provider,
      model: fixtureUsage.model,
    },
  };
}

test("one local run proves a Laravel correctness fix before producing a draft PR request", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-e2e-"));
  const repository = join(sandbox, "repository");
  await cp(join(process.cwd(), "test", "fixtures", "laravel-money-allocator"), repository, { recursive: true });
  const shell = new CommandRunner();
  await expectSuccess(shell.run(["git", "init", "-b", "main"], repository));
  await expectSuccess(shell.run(["git", "config", "user.email", "improver@example.test"], repository));
  await expectSuccess(shell.run(["git", "config", "user.name", "Daily Improver Test"], repository));
  await expectSuccess(shell.run(["git", "add", "."], repository));
  await expectSuccess(shell.run(["git", "commit", "-m", "fixture baseline"], repository));

  process.env.DAILY_IMPROVER_RUN_DATE = "2026-07-17";
  const openPullRequests: OpenPullRequestStateSource = {
    current: async (decidedAt) => ({
      schemaVersion: "open-pull-request-state/v1",
      repositoryId: "b".repeat(64),
      observedAt: decidedAt,
      openPullRequests: 0,
    }),
  };
  const unresolvedFindings: UnresolvedFindingStateSource = {
    current: async (observedAt) => ({
      schemaVersion: "unresolved-finding-state/v1",
      repositoryId: "f".repeat(64),
      observedAt,
      findingIds: [],
    }),
  };
  const app = createApplication(join(sandbox, "state"), openPullRequests, unresolvedFindings);
  const result = await new LocalImprovementRunner(
    app.stages,
    new ProvingAgent(),
    join(sandbox, "worktrees"),
    "ephemeral-test-key",
  ).run(repository);

  assert.equal(result.baselineTestFailed, true);
  assert.equal(result.baselineProofSatisfied, true);
  assert.equal(result.verificationPassed, true);
  assert.equal(result.publication.draft, true);
  assert.match(result.branch, /^ai\/daily\/2026-07-17-/);
  assert.match(result.publication.body, /Infection escaped mutation/);
  const fixedSource = await expectSuccess(shell.run(["git", "show", `${result.branch}:app/Domain/MoneyAllocator.php`], repository));
  assert.match(fixedSource.stdout, /\$remainder = \$total % \$parts/);
  const usageArtifact = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/build-agent-usage.json`], repository));
  assert.match(usageArtifact.stdout, /"model": "fixture-model-v1"/);
  assert.match(usageArtifact.stdout, /"schemaVersion": "agent-usage\/v4"/);
  assert.match(usageArtifact.stdout, /"budgetDecision"/);
  assert.match(usageArtifact.stdout, /"requestAttempts"/);
  assert.match(usageArtifact.stdout, /"routingDecision"/);
  assert.match(usageArtifact.stdout, /"complexity": "lower"/);
  assert.match(usageArtifact.stdout, /"classification": "completed"/);
  const rationaleArtifact = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/build-agent-rationale.json`], repository));
  assert.match(rationaleArtifact.stdout, /"trust": "untrusted-model-output"/);
  const specification = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/spec.json`], repository));
  assert.match(specification.stdout, /"schemaVersion": "improvement-intent\/v1"/);
  assert.match(specification.stdout, /"intent": "defect"/);
  const testPlan = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/test-plan.json`], repository));
  assert.match(testPlan.stdout, /"schemaVersion": "test-plan\/v5"/);
  assert.match(testPlan.stdout, /"baselineProof": "defect-regression"/);
  assert.match(testPlan.stdout, /"outcome": "failed-as-expected"/);
  assert.match(testPlan.stdout, /"generatedInputCount": 510/);
  assert.match(testPlan.stdout, /"outcome": "accepted"/);
  const propertyProof = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/property-test-execution-proof.json`], repository));
  assert.match(propertyProof.stdout, /"schemaVersion": "property-test-execution-proof\/v1"/);
  assert.match(propertyProof.stdout, /"targetExecutionCount": 510/);
  const mutationProof = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/known-mutation-execution-proof.json`], repository));
  assert.match(mutationProof.stdout, /"schemaVersion": "known-mutation-execution-proof\/v1"/);
  assert.match(mutationProof.stdout, /"status": "failed-as-required"/);
  assert.match(mutationProof.stdout, /"classification": "property-invariant-violation"/);
  assert.doesNotMatch(mutationProof.stdout, /Allocation did not preserve/);
  const implementationInspection = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/test-implementation-inspection.json`], repository));
  assert.match(implementationInspection.stdout, /"schemaVersion": "test-implementation-inspection\/v1"/);
  assert.match(implementationInspection.stdout, /"outcome": "accepted"/);
  assert.match(implementationInspection.stdout, /"testSha256": "[a-f0-9]{64}"/);
  assert.doesNotMatch(implementationInspection.stdout, /array_sum|intdiv|Allocation did not preserve/);
  const testManifest = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/test-manifest.json`], repository));
  assert.match(testManifest.stdout, /test-implementation-inspection\.json/);
  const dailyDecision = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/daily-improvement-decision.json`], repository));
  assert.match(dailyDecision.stdout, /"schemaVersion": "daily-improvement-decision\/v1"/);
  assert.match(dailyDecision.stdout, /"outcome": "completed"/);
  const openPrDecision = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/open-pull-request-limit-decision.json`], repository));
  assert.match(openPrDecision.stdout, /"schemaVersion": "open-pull-request-limit-decision\/v1"/);
  assert.match(openPrDecision.stdout, /"outcome": "allowed"/);
  delete process.env.DAILY_IMPROVER_RUN_DATE;
});

test("rejects known non-behavioral defect-test failure classifications", () => {
  assert.equal(defectBaselineFailureIsCredible("test-assertion"), true);
  assert.equal(defectBaselineFailureIsCredible("unknown"), true);
  assert.equal(defectBaselineFailureIsCredible("syntax"), false);
  assert.equal(defectBaselineFailureIsCredible("resource-limit"), false);
  assert.equal(defectBaselineFailureIsCredible("dependency-or-autoload"), false);
});

test("rejects implementation-restating generated tests before the builder", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-restatement-"));
  const repository = join(sandbox, "repository");
  await cp(join(process.cwd(), "test", "fixtures", "laravel-money-allocator"), repository, { recursive: true });
  const shell = new CommandRunner();
  await expectSuccess(shell.run(["git", "init", "-b", "main"], repository));
  await expectSuccess(shell.run(["git", "config", "user.email", "improver@example.test"], repository));
  await expectSuccess(shell.run(["git", "config", "user.name", "Daily Improver Test"], repository));
  await expectSuccess(shell.run(["git", "add", "."], repository));
  await expectSuccess(shell.run(["git", "commit", "-m", "fixture baseline"], repository));

  process.env.DAILY_IMPROVER_RUN_DATE = "2026-07-17";
  const app = createApplication(join(sandbox, "state"), {
    current: async (observedAt) => ({
      schemaVersion: "open-pull-request-state/v1",
      repositoryId: "b".repeat(64),
      observedAt,
      openPullRequests: 0,
    }),
  }, {
    current: async (observedAt) => ({
      schemaVersion: "unresolved-finding-state/v1",
      repositoryId: "f".repeat(64),
      observedAt,
      findingIds: [],
    }),
  });
  const agent = new SourceInspectingAgent();
  await assert.rejects(new LocalImprovementRunner(
    app.stages,
    agent,
    join(sandbox, "worktrees"),
    "ephemeral-test-key",
  ).run(repository), /production-source-inspection/);
  assert.equal(agent.buildCalled, false);
  delete process.env.DAILY_IMPROVER_RUN_DATE;
});

async function expectSuccess<T extends { exitCode: number; stderr: string }>(promise: Promise<T>): Promise<T> {
  const result = await promise;
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}
