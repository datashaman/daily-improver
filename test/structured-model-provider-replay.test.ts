import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { AgentContext, BuilderExecution, TestAgentExecution } from "../src/agents/agent-provider.js";
import { InMemoryModelCostBudgetState, type ModelCostBudgets } from "../src/agents/model-cost-budget.js";
import { modelStageCredentialSchemaVersion } from "../src/agents/model-stage-credential.js";
import type { ModelRoutingPolicy } from "../src/agents/model-routing.js";
import type { ModelEndpointPolicy } from "../src/agents/model-endpoint.js";
import {
  ModelTransportFailure,
  StructuredModelAgentProvider,
  type ModelRequest,
  type ModelRetryPolicy,
  type ModelTransport,
  type ModelTransportInvocation,
} from "../src/agents/structured-model-agent-provider.js";

const replayDirectory = path.join(process.cwd(), "test", "fixtures", "model-provider-replay");

interface ReplayFixture {
  readonly schemaVersion: "structured-provider-replay/v3";
  readonly stage: "test" | "build";
  readonly clockNowMs: number;
  readonly budgets: ModelCostBudgets;
  readonly retryPolicy: ModelRetryPolicy;
  readonly routingPolicy: ModelRoutingPolicy;
  readonly endpointPolicy: ModelEndpointPolicy;
  readonly request: ModelRequest;
  readonly events: readonly ReplayEvent[];
  readonly expected: {
    readonly trusted: {
      readonly usage: unknown;
      readonly budgetDecision: unknown;
      readonly requestAttempts: unknown;
      readonly routingDecision: unknown;
    };
    readonly untrustedRationale: unknown;
    readonly retryDelaysMs: readonly number[];
    readonly maximumCostsUsd: readonly number[];
    readonly credentialAcquisitions: number;
  };
}

type ReplayEvent =
  | { readonly kind: "response"; readonly value: unknown }
  | {
    readonly kind: "failure";
    readonly classification: "transient" | "permanent";
    readonly errorText: string;
  };

const context: AgentContext = {
  repository: "/deterministic/replay/repository",
  specPath: "/deterministic/replay/repository/.ai/runs/2026-07-17/spec.json",
  spec: {
    id: "spec-money-allocation",
    improvementIntent: { schemaVersion: "improvement-intent/v1", intent: "defect", baselineProof: "defect-regression" },
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

class ReplayTransport implements ModelTransport {
  readonly invocations: ModelTransportInvocation[] = [];

  constructor(private readonly fixture: ReplayFixture) {}

  async invoke(invocation: ModelTransportInvocation): Promise<unknown> {
    this.invocations.push(invocation);
    assert.equal(invocation.stage, this.fixture.stage);
    assert.deepEqual(invocation.request, this.fixture.request);
    assert.deepEqual(invocation.route, (this.fixture.expected.trusted.routingDecision as { readonly route: unknown }).route);
    assert.equal(invocation.endpoint.id, "customer-private-model-endpoint");
    assert.equal(invocation.endpoint.capabilities.protocol, "structured-agent/v1");
    assert.ok(invocation.endpoint.capabilities.stages.includes(this.fixture.stage));
    const event = this.fixture.events[this.invocations.length - 1];
    assert.ok(event, "Replay transport received an unexpected invocation.");
    if (event.kind === "failure") {
      throw new ModelTransportFailure(event.classification, event.errorText);
    }
    return event.value;
  }
}

for (const name of ["test-success.json", "builder-transient-retry.json"] as const) {
  test(`replays ${name} through every structured provider boundary`, async () => {
    const fixture = await loadFixture(name);
    const transport = new ReplayTransport(fixture);
    const credentialRequests: { readonly stage: "test" | "build"; readonly scope: string }[] = [];
    const retryDelaysMs: number[] = [];
    const provider = new StructuredModelAgentProvider(
      transport,
      fixture.budgets,
      {
        clock: { nowMs: () => fixture.clockNowMs },
        source: {
          async acquire(request) {
            credentialRequests.push(request);
            return {
              schemaVersion: modelStageCredentialSchemaVersion,
              stage: request.stage,
              scope: request.scope,
              issuedAtMs: fixture.clockNowMs - 1_000,
              expiresAtMs: fixture.clockNowMs + 60_000,
              secret: `${request.stage}-replay-credential-${credentialRequests.length}`,
            };
          },
        },
      },
      fixture.routingPolicy,
      fixture.endpointPolicy,
      new InMemoryModelCostBudgetState(),
      fixture.retryPolicy,
      { async wait(delayMs) { retryDelaysMs.push(delayMs); } },
    );

    const result = await execute(provider, fixture.stage);
    const trusted = {
      usage: result.usage,
      budgetDecision: result.budgetDecision,
      requestAttempts: result.requestAttempts,
      routingDecision: result.routingDecision,
    };

    assert.deepEqual(trusted, fixture.expected.trusted);
    assert.deepEqual(result.rationale, fixture.expected.untrustedRationale);
    assert.deepEqual(retryDelaysMs, fixture.expected.retryDelaysMs);
    assert.deepEqual(
      transport.invocations.map(({ maximumCostUsd }) => maximumCostUsd),
      fixture.expected.maximumCostsUsd,
    );
    assert.equal(credentialRequests.length, fixture.expected.credentialAcquisitions);
    assert.ok(credentialRequests.every(({ stage }) => stage === fixture.stage));
    assert.ok(credentialRequests.every(({ scope }) => /^sha256:[a-f0-9]{64}$/.test(scope)));
    assert.equal(transport.invocations.length, fixture.events.length);

    const serializedRequests = JSON.stringify(transport.invocations.map(({ request }) => request));
    const serializedEndpointMetadata = JSON.stringify(transport.invocations.map(({ endpoint }) => endpoint));
    const serializedTrusted = JSON.stringify(trusted);
    const serializedResult = JSON.stringify(result);
    assert.doesNotMatch(serializedRequests, /deterministic\/replay\/repository|replay-credential/);
    assert.doesNotMatch(serializedEndpointMetadata, /replay-credential|sensitive upstream timeout/);
    assert.doesNotMatch(serializedTrusted, /Added an allocation|Distributed the remainder|public API unchanged/);
    assert.doesNotMatch(serializedResult, /sensitive upstream timeout replay sentinel|replay-credential/);
  });
}

async function execute(
  provider: StructuredModelAgentProvider,
  stage: "test" | "build",
): Promise<TestAgentExecution | BuilderExecution> {
  return stage === "test" ? provider.generateTests(context) : provider.build(context);
}

async function loadFixture(name: string): Promise<ReplayFixture> {
  const parsed: unknown = JSON.parse(await readFile(path.join(replayDirectory, name), "utf8"));
  assert.ok(isRecord(parsed));
  assert.equal(parsed.schemaVersion, "structured-provider-replay/v3");
  assert.ok(parsed.stage === "test" || parsed.stage === "build");
  assert.ok(Array.isArray(parsed.events) && parsed.events.length > 0);
  return parsed as unknown as ReplayFixture;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
