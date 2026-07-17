import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentContext } from "../src/agents/agent-provider.js";
import {
  FetchOpenAiResponsesClient,
  OpenAiResponsesApiFailure,
  OpenAiResponsesAgentProvider,
  type OpenAiResponsesClient,
  type OpenAiResponsesRequest,
} from "../src/agents/openai-responses-agent-provider.js";

class RecordingOpenAiClient implements OpenAiResponsesClient {
  readonly requests: OpenAiResponsesRequest[] = [];

  constructor(private readonly outputs: readonly unknown[]) {}

  async create(request: OpenAiResponsesRequest): Promise<unknown> {
    this.requests.push(request);
    const output = this.outputs[this.requests.length - 1];
    if (output === undefined) throw new Error("Unexpected OpenAI request.");
    return response(output);
  }
}

test("uses bounded Responses structured output to materialize test and builder files", async () => {
  const context = await fixtureContext();
  const client = new RecordingOpenAiClient([
    {
      summary: "Added the allocation invariant.",
      files: [{
        path: "tests/Property/MoneyAllocatorInvariantTest.php",
        content: "<?php\nthrow new RuntimeException('baseline defect');\n",
      }],
      tests: [{
        path: "tests/Property/MoneyAllocatorInvariantTest.php",
        purpose: "Prove allocation totals are preserved.",
        invariants: ["sum(allocation) equals total"],
      }],
    },
    {
      summary: "Distributed the remainder.",
      files: [{
        path: "app/Domain/MoneyAllocator.php",
        content: "<?php\nfinal class MoneyAllocator { public function allocate(): array { return []; } }\n",
      }],
      implementationNotes: ["Preserved the approved file boundary."],
    },
  ]);
  const provider = createProvider(client);

  const testResult = await provider.generateTests(context);
  const builderResult = await provider.build({
    ...context,
    inputs: {
      ...context.inputs,
      protectedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php", ".ai/runs/2026-07-17/spec.json"],
    },
  });

  assert.equal(testResult.rationale.changedFiles[0], "tests/Property/MoneyAllocatorInvariantTest.php");
  assert.equal(builderResult.rationale.changedFiles[0], "app/Domain/MoneyAllocator.php");
  assert.match(await readFile(join(context.repository, "tests/Property/MoneyAllocatorInvariantTest.php"), "utf8"), /baseline defect/);
  assert.match(await readFile(join(context.repository, "app/Domain/MoneyAllocator.php"), "utf8"), /final class/);
  assert.equal(client.requests.length, 2);
  assert.deepEqual(client.requests.map(({ text }) => text.format.type), ["json_schema", "json_schema"]);
  assert.deepEqual(client.requests.map(({ store }) => store), [false, false]);
  assert.doesNotMatch(JSON.stringify(client.requests), new RegExp(escapeRegExp(context.repository)));
  const testInput = JSON.parse(client.requests[0]?.input ?? "") as { sources: readonly { path: string }[] };
  assert.deepEqual(testInput.sources.map(({ path }) => path), [
    "app/Domain/MoneyAllocator.php",
    "tests/run.php",
  ]);
  assert.equal(testResult.usage.provider, "openai");
  assert.equal(testResult.usage.estimatedCostUsd, 0.0025);
});

test("rejects unauthorized or malformed file outputs before writing", async () => {
  const context = await fixtureContext();
  const original = await readFile(join(context.repository, "app/Domain/MoneyAllocator.php"), "utf8");
  const client = new RecordingOpenAiClient([{
    summary: "Attempted an escape.",
    files: [{ path: "../outside.php", content: "<?php" }],
    implementationNotes: [],
  }]);
  const provider = createProvider(client);

  await assert.rejects(() => provider.build(context), /repository-relative POSIX path/);
  assert.equal(await readFile(join(context.repository, "app/Domain/MoneyAllocator.php"), "utf8"), original);
});

test("rejects a request whose configured maximum cost can be exceeded before transport", async () => {
  const context = await fixtureContext();
  const client = new RecordingOpenAiClient([{}]);
  const provider = new OpenAiResponsesAgentProvider(client, {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    maxOutputTokens: 4_000,
    maximumCostUsd: 0.000001,
    pricing: { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 15 },
  });

  await assert.rejects(() => provider.generateTests(context), /could exceed.*cost limit/);
  assert.equal(client.requests.length, 0);
});

test("retains only a bounded API error code from unsuccessful responses", async () => {
  const client = new FetchOpenAiResponsesClient(
    `sk-${"a".repeat(24)}`,
    "https://api.openai.com/v1/responses",
    1_000,
    async () => new Response(JSON.stringify({
      error: {
        code: "insufficient_quota",
        message: "sensitive provider detail must not survive",
        type: "insufficient_quota",
      },
    }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
  );

  await assert.rejects(
    () => client.create({
      model: "gpt-5.6-terra",
      instructions: "test",
      input: "test",
      reasoning: { effort: "medium" },
      max_output_tokens: 256,
      store: false,
      text: { format: { type: "json_schema", name: "test", strict: true, schema: {} } },
    }),
    (error) => error instanceof OpenAiResponsesApiFailure
      && error.status === 429
      && error.code === "insufficient_quota"
      && !error.message.includes("sensitive provider detail"),
  );
});

function createProvider(client: OpenAiResponsesClient): OpenAiResponsesAgentProvider {
  let now = 1_000;
  return new OpenAiResponsesAgentProvider(client, {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    maxOutputTokens: 4_000,
    maximumCostUsd: 0.25,
    pricing: { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 15 },
  }, () => now += 25);
}

async function fixtureContext(): Promise<AgentContext> {
  const repository = await mkdtemp(join(tmpdir(), "daily-improver-openai-provider-"));
  await mkdir(join(repository, "app", "Domain"), { recursive: true });
  await mkdir(join(repository, "tests"), { recursive: true });
  await writeFile(join(repository, "app", "Domain", "MoneyAllocator.php"), "<?php\nfinal class MoneyAllocator {}\n");
  await writeFile(join(repository, "tests", "run.php"), "<?php\n// test harness\n");
  return {
    repository,
    specPath: join(repository, ".ai", "runs", "2026-07-17", "spec.json"),
    spec: {
      id: "spec-money-allocation",
      title: "Preserve allocation totals",
      objective: "Ensure integer allocations preserve the requested total.",
      currentBehaviour: "Remainders are discarded.",
      proposedImprovement: "Distribute the remainder deterministically.",
      allowedFiles: ["app/Domain/MoneyAllocator.php"],
      behavioursToPreserve: ["Reject invalid part counts."],
      acceptanceCriteria: ["Every allocation sums to the requested total."],
      propertyInvariants: ["sum(allocation) equals total"],
      exclusions: ["Public API changes"],
      verification: ["test"],
      constraints: { maxFiles: 2, maxChangedLines: 80, maxCostUsd: 1.5 },
      evidence: ["An escaped mutation removes remainder distribution."],
    },
    inputs: {
      repository: { language: "php", frameworks: ["laravel"] },
      allowedTestPaths: ["tests/Property/**"],
      protectedFiles: [".ai/runs/2026-07-17/spec.json"],
      commands: [{ purpose: "test", argv: ["php", "tests/run.php"] }],
      testConventions: ["Use the repository test harness."],
      builderConventions: ["Preserve strict types."],
    },
  };
}

function response(output: unknown): unknown {
  return {
    status: "completed",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(output) }],
    }],
    usage: { input_tokens: 1_000, output_tokens: 0 },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
