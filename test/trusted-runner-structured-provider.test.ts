import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContext } from "../src/agents/agent-provider.js";
import {
  modelEndpointResolutionSchemaVersion,
  type BoundedHttpsClient,
  type BoundedHttpsRequest,
  type BoundedHttpsResponse,
} from "../src/agents/https-structured-endpoint-transport.js";
import { modelEndpointPolicySchemaVersion } from "../src/agents/model-endpoint.js";
import { modelRoutingPolicySchemaVersion } from "../src/agents/model-routing.js";
import { modelStageCredentialSchemaVersion } from "../src/agents/model-stage-credential.js";
import {
  createTrustedRunnerStructuredProvider,
  trustedRunnerStructuredProviderConfigurationSchemaVersion,
  type TrustedRunnerStructuredProviderInputs,
} from "../src/agents/trusted-runner-structured-provider.js";
import {
  modelCredentialExchangeResolutionSchemaVersion,
  trustedRunnerIdentitySchemaVersion,
} from "../src/agents/trusted-runner-model-stage-credential-source.js";

const nowMs = 1_784_236_800_000;
const endpointUrl = "https://models.runner.example/structured";
const exchangeUrl = "https://control.runner.example/model-credentials";
const issuer = "https://token.actions.example";
const audience = "daily-improver-control-plane";

const configuration = {
  schemaVersion: trustedRunnerStructuredProviderConfigurationSchemaVersion,
  budgets: {
    dailyLimitUsd: 0.01,
    stages: {
      test: { limitUsd: 0.006, reservationUsd: 0.004 },
      build: { limitUsd: 0.006, reservationUsd: 0.004 },
    },
  },
  retryPolicy: { maxAttempts: 1, delaysMs: [] },
  routingPolicy: {
    schemaVersion: modelRoutingPolicySchemaVersion,
    routes: {
      lower: {
        test: { id: "runner-test-lower", provider: "runner-models", model: "model-v1" },
        build: { id: "runner-build-lower", provider: "runner-models", model: "model-v1" },
      },
      higher: {
        test: { id: "runner-test-higher", provider: "runner-models", model: "test-model-v2" },
        build: { id: "runner-build-higher", provider: "runner-models", model: "build-model-v2" },
      },
    },
  },
  endpointPolicy: {
    schemaVersion: modelEndpointPolicySchemaVersion,
    endpoints: [{
      id: "runner-private-endpoint",
      routeIds: ["runner-test-lower", "runner-build-lower", "runner-test-higher", "runner-build-higher"],
      capabilities: {
        protocol: "structured-agent/v1",
        stages: ["test", "build"],
        authentication: "ephemeral-credential",
        costLimit: "maximum-cost-usd",
      },
    }],
  },
} as const;

const context: AgentContext = {
  repository: "/customer/repository",
  specPath: "/customer/repository/.ai/runs/2026-07-17/spec.json",
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

class DeterministicRunnerHttpsClient implements BoundedHttpsClient {
  readonly requests: BoundedHttpsRequest[] = [];

  async send(request: BoundedHttpsRequest): Promise<BoundedHttpsResponse> {
    this.requests.push(request);
    const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as Record<string, unknown>;
    if (request.url.toString() === exchangeUrl) {
      const stage = requiredStage(body.stage);
      const scope = requiredString(body.scope);
      assert.equal(request.headers.authorization, `Bearer ${stage}-runner-identity`);
      return jsonResponse({
        schemaVersion: modelStageCredentialSchemaVersion,
        stage,
        scope,
        issuedAtMs: nowMs - 1_000,
        expiresAtMs: nowMs + 60_000,
        secret: `${stage}-ephemeral-model-credential`,
      });
    }
    assert.equal(request.url.toString(), endpointUrl);
    const stage = requiredStage(body.stage);
    assert.equal(request.headers.authorization, `Bearer ${stage}-ephemeral-model-credential`);
    const route = body.route as { readonly provider: string; readonly model: string };
    const usage = {
      provider: route.provider,
      model: route.model,
      inputTokens: 100,
      outputTokens: 40,
      latencyMs: 25,
      estimatedCostUsd: 0.002,
    };
    return stage === "test" ? jsonResponse({
      schemaVersion: "test-agent-response/v1",
      status: "completed",
      summary: "Added a property test.",
      changedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php"],
      tests: [{
        path: "tests/Property/MoneyAllocatorInvariantTest.php",
        purpose: "Prove totals are preserved.",
        invariants: ["sum(allocation) equals total"],
      }],
      usage,
    }) : jsonResponse({
      schemaVersion: "builder-response/v1",
      status: "completed",
      summary: "Distributed the remainder.",
      changedFiles: ["app/Domain/MoneyAllocator.php"],
      implementationNotes: ["Preserved the public API."],
      usage,
    });
  }
}

test("composes separate trusted test and build acquisition before structured endpoint calls", async () => {
  const client = new DeterministicRunnerHttpsClient();
  const identityRequests: { readonly stage: "test" | "build"; readonly scope: string }[] = [];
  const endpointRequests: string[] = [];
  let exchangeResolutions = 0;
  const provider = createTrustedRunnerStructuredProvider(configuration, {
    endpointResolver: {
      async resolve(endpointId) {
        endpointRequests.push(endpointId);
        return endpointResolution(endpointId);
      },
    },
    identitySource: {
      async acquire(request) {
        identityRequests.push({ stage: request.stage, scope: request.scope });
        return {
          schemaVersion: trustedRunnerIdentitySchemaVersion,
          issuer: request.issuer,
          audience: request.audience,
          stage: request.stage,
          scope: request.scope,
          issuedAtMs: nowMs - 1_000,
          expiresAtMs: nowMs + 60_000,
          assertion: `${request.stage}-runner-identity`,
        };
      },
    },
    credentialExchangeResolver: {
      async resolve() {
        exchangeResolutions++;
        return exchangeResolution();
      },
    },
    httpsClient: client,
    clock: { nowMs: () => nowMs },
  });

  const testResult = await provider.generateTests(context);
  const buildResult = await provider.build(context);

  assert.equal(testResult.rationale.summary, "Added a property test.");
  assert.equal(buildResult.rationale.summary, "Distributed the remainder.");
  assert.deepEqual(identityRequests.map(({ stage }) => stage), ["test", "build"]);
  assert.equal(identityRequests[0]?.scope, identityRequests[1]?.scope);
  assert.match(identityRequests[0]?.scope ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(endpointRequests, ["runner-private-endpoint", "runner-private-endpoint"]);
  assert.equal(exchangeResolutions, 2);
  assert.deepEqual(client.requests.map(({ url }) => url.toString()), [
    exchangeUrl,
    endpointUrl,
    exchangeUrl,
    endpointUrl,
  ]);
  assert.doesNotMatch(JSON.stringify([testResult, buildResult]), /runner-identity|ephemeral-model-credential/);
});

test("fails closed on absent or malformed trusted composition input", () => {
  const validInputs = compositionInputs(new DeterministicRunnerHttpsClient());
  const { endpointPolicy: _endpointPolicy, ...missingPolicy } = configuration;
  assert.throws(
    () => createTrustedRunnerStructuredProvider(missingPolicy, validInputs),
    /must contain exactly/,
  );
  assert.throws(
    () => createTrustedRunnerStructuredProvider({ ...configuration, schemaVersion: "unsupported" }, validInputs),
    /schemaVersion must equal/,
  );
  assert.throws(
    () => createTrustedRunnerStructuredProvider({
      ...configuration,
      budgets: { ...configuration.budgets, repositoryOverride: true },
    }, validInputs),
    /model budgets must contain exactly/,
  );
  assert.throws(
    () => createTrustedRunnerStructuredProvider(configuration, {
      ...validInputs,
      identitySource: undefined,
    } as unknown as TrustedRunnerStructuredProviderInputs),
    /inputs are required/,
  );
});

for (const mismatch of ["stage", "scope"] as const) {
  test(`fails before a model call on cross-${mismatch} trusted identity`, async () => {
    const client = new DeterministicRunnerHttpsClient();
    const inputs = compositionInputs(client);
    const provider = createTrustedRunnerStructuredProvider(configuration, {
      ...inputs,
      identitySource: {
        async acquire(request) {
          return {
            schemaVersion: trustedRunnerIdentitySchemaVersion,
            issuer: request.issuer,
            audience: request.audience,
            stage: mismatch === "stage" ? "build" : request.stage,
            scope: mismatch === "scope" ? `sha256:${"0".repeat(64)}` : request.scope,
            issuedAtMs: nowMs - 1_000,
            expiresAtMs: nowMs + 60_000,
            assertion: "must-not-reach-exchange",
          };
        },
      },
    });
    await assert.rejects(() => provider.generateTests(context), /valid model credential is unavailable/i);
    assert.equal(client.requests.length, 0);
  });
}

test("fails before a model call on cross-endpoint trusted resolution", async () => {
  const client = new DeterministicRunnerHttpsClient();
  const provider = createTrustedRunnerStructuredProvider(configuration, {
    ...compositionInputs(client),
    endpointResolver: {
      async resolve() { return endpointResolution("different-endpoint"); },
    },
  });
  await assert.rejects(() => provider.generateTests(context), /model transport request failed/i);
  assert.deepEqual(client.requests.map(({ url }) => url.toString()), [exchangeUrl]);
});

function compositionInputs(client: BoundedHttpsClient): TrustedRunnerStructuredProviderInputs {
  return {
    endpointResolver: { async resolve(endpointId) { return endpointResolution(endpointId); } },
    identitySource: {
      async acquire(request) {
        return {
          schemaVersion: trustedRunnerIdentitySchemaVersion,
          issuer: request.issuer,
          audience: request.audience,
          stage: request.stage,
          scope: request.scope,
          issuedAtMs: nowMs - 1_000,
          expiresAtMs: nowMs + 60_000,
          assertion: `${request.stage}-runner-identity`,
        };
      },
    },
    credentialExchangeResolver: { async resolve() { return exchangeResolution(); } },
    httpsClient: client,
    clock: { nowMs: () => nowMs },
  };
}

function endpointResolution(endpointId: string) {
  return {
    schemaVersion: modelEndpointResolutionSchemaVersion,
    endpointId,
    url: endpointUrl,
    timeoutMs: 30_000,
    maxRequestBytes: 128_000,
    maxResponseBytes: 128_000,
  } as const;
}

function exchangeResolution() {
  return {
    schemaVersion: modelCredentialExchangeResolutionSchemaVersion,
    url: exchangeUrl,
    issuer,
    audience,
    timeoutMs: 30_000,
    maxRequestBytes: 128_000,
    maxResponseBytes: 128_000,
  } as const;
}

function jsonResponse(value: unknown): BoundedHttpsResponse {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(value), "utf8"),
  };
}

function requiredStage(value: unknown): "test" | "build" {
  assert.ok(value === "test" || value === "build");
  return value;
}

function requiredString(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
