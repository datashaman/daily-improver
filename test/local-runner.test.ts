import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentContext, AgentProvider } from "../src/agents/agent-provider.js";
import { createApplication } from "../src/app.js";
import { LocalImprovementRunner } from "../src/core/local-runner.js";
import { CommandRunner } from "../src/infra/command-runner.js";

class ProvingAgent implements AgentProvider {
  async generateTests(context: AgentContext): Promise<void> {
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
  }

  async build(context: AgentContext): Promise<void> {
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
  }
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
  const app = createApplication(join(sandbox, "state"));
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
  delete process.env.DAILY_IMPROVER_RUN_DATE;
});

async function expectSuccess<T extends { exitCode: number; stderr: string }>(promise: Promise<T>): Promise<T> {
  const result = await promise;
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}
