import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentContext, AgentProvider, BuilderExecution, TestAgentExecution } from "../src/agents/agent-provider.js";
import { createApplication } from "../src/app.js";
import { LocalImprovementRunner } from "../src/core/local-runner.js";
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
for ($total = 0; $total <= 50; $total++) {
    for ($parts = 1; $parts <= 10; $parts++) {
        $allocation = $allocator->allocate($total, $parts);
        if (array_sum($allocation) !== $total) {
            throw new RuntimeException("Allocation did not preserve total {$total} across {$parts} parts.");
        }
    }
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
  const dailyDecision = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/daily-improvement-decision.json`], repository));
  assert.match(dailyDecision.stdout, /"schemaVersion": "daily-improvement-decision\/v1"/);
  assert.match(dailyDecision.stdout, /"outcome": "completed"/);
  const openPrDecision = await expectSuccess(shell.run(["git", "show", `${result.branch}:.ai/runs/2026-07-17/open-pull-request-limit-decision.json`], repository));
  assert.match(openPrDecision.stdout, /"schemaVersion": "open-pull-request-limit-decision\/v1"/);
  assert.match(openPrDecision.stdout, /"outcome": "allowed"/);
  delete process.env.DAILY_IMPROVER_RUN_DATE;
});

async function expectSuccess<T extends { exitCode: number; stderr: string }>(promise: Promise<T>): Promise<T> {
  const result = await promise;
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}
