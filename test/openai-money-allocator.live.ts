import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FetchOpenAiResponsesClient,
  OpenAiResponsesAgentProvider,
} from "../src/agents/openai-responses-agent-provider.js";
import { createApplication } from "../src/app.js";
import type { OpenPullRequestStateSource, UnresolvedFindingStateSource } from "../src/contracts.js";
import { LocalImprovementRunner } from "../src/core/local-runner.js";
import { CommandRunner } from "../src/infra/command-runner.js";

test("a real OpenAI model proves and fixes the MoneyAllocator defect", async (context) => {
  const mode = process.env.DAILY_IMPROVER_OPENAI_LIVE_MODE;
  const apiKey = process.env.OPENAI_API_KEY;
  if (mode !== "skip" && mode !== "require") {
    throw new Error("DAILY_IMPROVER_OPENAI_LIVE_MODE must explicitly equal skip or require.");
  }
  if (!apiKey) {
    if (mode === "skip") {
      context.skip("OPENAI_API_KEY is absent.");
      return;
    }
    throw new Error("OPENAI_API_KEY is required before a live model request.");
  }

  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-openai-live-"));
  const repository = join(sandbox, "repository");
  const shell = new CommandRunner();
  const previousRunDate = process.env.DAILY_IMPROVER_RUN_DATE;
  const runDate = new Date().toISOString().slice(0, 10);
  process.env.DAILY_IMPROVER_RUN_DATE = runDate;
  try {
    await cp(join(process.cwd(), "test", "fixtures", "laravel-money-allocator"), repository, { recursive: true });
    await expectSuccess(shell.run(["git", "init", "-b", "main"], repository));
    await expectSuccess(shell.run(["git", "config", "user.email", "openai-improver@example.test"], repository));
    await expectSuccess(shell.run(["git", "config", "user.name", "Daily Improver OpenAI Proof"], repository));
    await expectSuccess(shell.run(["git", "add", "."], repository));
    await expectSuccess(shell.run(["git", "commit", "-m", "fixture baseline"], repository));

    const model = process.env.DAILY_IMPROVER_OPENAI_MODEL ?? "gpt-5.6-terra";
    const provider = new OpenAiResponsesAgentProvider(
      new FetchOpenAiResponsesClient(apiKey),
      {
        model,
        reasoningEffort: "medium",
        maxOutputTokens: 4_000,
        maximumCostUsd: 0.25,
        pricing: { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 15 },
      },
    );
    const app = createApplication(join(sandbox, "state"), openPullRequests(), unresolvedFindings());
    const result = await new LocalImprovementRunner(
      app.stages,
      provider,
      join(sandbox, "worktrees"),
      "ephemeral-openai-live-manifest-key",
    ).run(repository);

    assert.equal(result.baselineTestFailed, true);
    assert.equal(result.verificationPassed, true);
    assert.equal(result.publication.draft, true);
    const testUsage = await show(shell, repository, `${result.branch}:.ai/runs/${runDate}/test-agent-usage.json`);
    const buildUsage = await show(shell, repository, `${result.branch}:.ai/runs/${runDate}/build-agent-usage.json`);
    assert.match(testUsage, /"provider": "openai"/);
    assert.match(buildUsage, /"provider": "openai"/);
    assert.match(testUsage, new RegExp(`"model": "${escapeRegExp(model)}"`));
    assert.match(buildUsage, new RegExp(`"model": "${escapeRegExp(model)}"`));
    assert.equal(testUsage.includes(apiKey), false);
    assert.equal(buildUsage.includes(apiKey), false);
    const fixedSource = await show(shell, repository, `${result.branch}:app/Domain/MoneyAllocator.php`);
    assert.match(fixedSource, /remainder|%/i);
  } finally {
    if (previousRunDate === undefined) delete process.env.DAILY_IMPROVER_RUN_DATE;
    else process.env.DAILY_IMPROVER_RUN_DATE = previousRunDate;
    await rm(sandbox, { recursive: true, force: true });
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

async function show(shell: CommandRunner, repository: string, object: string): Promise<string> {
  return (await expectSuccess(shell.run(["git", "show", object], repository))).stdout;
}

async function expectSuccess<T extends { exitCode: number; stderr: string }>(promise: Promise<T>): Promise<T> {
  const result = await promise;
  assert.equal(result.exitCode, 0, result.stderr);
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
