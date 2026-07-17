import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContext } from "../src/agents/agent-provider.js";
import {
  StructuredModelAgentProvider,
  type ModelTransport,
  type ModelTransportInvocation,
} from "../src/agents/structured-model-agent-provider.js";

const usage = {
  provider: "deterministic-fixture",
  model: "fixture-model-v1",
  inputTokens: 240,
  outputTokens: 90,
  latencyMs: 18,
  estimatedCostUsd: 0.002,
} as const;

const context: AgentContext = {
  repository: "/private/customer/repository",
  specPath: "/private/customer/repository/.ai/runs/2026-07-17/spec.json",
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
    protectedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php", ".ai/runs/2026-07-17/spec.json"],
    commands: [{ purpose: "test", argv: ["php", "tests/run.php"] }],
    testConventions: ["Use the repository test harness."],
    builderConventions: ["Preserve strict types."],
  },
};

class DeterministicTransport implements ModelTransport {
  readonly invocations: ModelTransportInvocation[] = [];
  constructor(private readonly responses: readonly unknown[]) {}

  async invoke(invocation: ModelTransportInvocation): Promise<unknown> {
    this.invocations.push(invocation);
    return this.responses[this.invocations.length - 1];
  }
}

test("constructs approved stage requests and accepts bounded deterministic model responses", async () => {
  const transport = new DeterministicTransport([
    {
      schemaVersion: "test-agent-response/v1",
      status: "completed",
      summary: "Added an allocation property test.",
      changedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php"],
      tests: [{
        path: "tests/Property/MoneyAllocatorInvariantTest.php",
        purpose: "Prove totals are preserved.",
        invariants: ["sum(allocation) equals total"],
      }],
      usage,
    },
    {
      schemaVersion: "builder-response/v1",
      status: "completed",
      summary: "Distributed the remainder.",
      changedFiles: ["app/Domain/MoneyAllocator.php"],
      implementationNotes: ["Kept the public API unchanged."],
      usage,
    },
  ]);
  const provider = new StructuredModelAgentProvider(transport);

  const testResult = await provider.generateTests(context);
  const buildResult = await provider.build(context);

  assert.equal(testResult.usage.model, "fixture-model-v1");
  assert.equal(buildResult.rationale.summary, "Distributed the remainder.");
  assert.deepEqual(transport.invocations[0]?.request, {
    schemaVersion: "test-agent-request/v1",
    stage: "test",
    task: {
      id: context.spec.id,
      title: context.spec.title,
      objective: context.spec.objective,
      currentBehaviour: context.spec.currentBehaviour,
      proposedImprovement: context.spec.proposedImprovement,
      behavioursToPreserve: context.spec.behavioursToPreserve,
      acceptanceCriteria: context.spec.acceptanceCriteria,
      propertyInvariants: context.spec.propertyInvariants,
      exclusions: context.spec.exclusions,
      evidence: context.spec.evidence,
      limits: { maxFiles: 2, maxChangedLines: 80, maxCostUsd: 1.5 },
    },
    repository: context.inputs.repository,
    allowedTestPaths: context.inputs.allowedTestPaths,
    commands: context.inputs.commands,
    conventions: context.inputs.testConventions,
  });
  const serializedRequests = JSON.stringify(transport.invocations.map(({ request }) => request));
  assert.doesNotMatch(serializedRequests, /private\/customer/);
});

test("fails closed on malformed responses and response-declared path escapes", async () => {
  const malformed = new StructuredModelAgentProvider(new DeterministicTransport([{ status: "completed" }]));
  await assert.rejects(malformed.generateTests(context), /contain exactly/);

  const escapedTest = new StructuredModelAgentProvider(new DeterministicTransport([{
    schemaVersion: "test-agent-response/v1",
    status: "completed",
    summary: "Changed production instead of tests.",
    changedFiles: ["app/Domain/MoneyAllocator.php"],
    tests: [{ path: "app/Domain/MoneyAllocator.php", purpose: "Invalid claim.", invariants: [] }],
    usage,
  }]));
  await assert.rejects(escapedTest.generateTests(context), /outside its path permissions/);

  const protectedBuild = new StructuredModelAgentProvider(new DeterministicTransport([{
    schemaVersion: "builder-response/v1",
    status: "completed",
    summary: "Changed a sealed test.",
    changedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php"],
    implementationNotes: [],
    usage,
  }]));
  await assert.rejects(protectedBuild.build({
    ...context,
    spec: { ...context.spec, allowedFiles: ["app/**", "tests/**"] },
  }), /declares a protected file/);
});
