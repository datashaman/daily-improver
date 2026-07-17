import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContext } from "../src/agents/agent-provider.js";
import {
  ModelTransportFailure,
  StructuredModelRequestFailure,
  StructuredModelAgentProvider,
  type ModelTransport,
  type ModelTransportInvocation,
} from "../src/agents/structured-model-agent-provider.js";
import { InMemoryModelCostBudgetState } from "../src/agents/model-cost-budget.js";
import { modelStageCredentialSchemaVersion } from "../src/agents/model-stage-credential.js";
import {
  modelRoutingPolicySchemaVersion,
  validateModelRoutingPolicy,
  type ModelRoutingPolicy,
} from "../src/agents/model-routing.js";
import {
  modelEndpointPolicySchemaVersion,
  validateModelEndpointPolicy,
  type ModelEndpointPolicy,
} from "../src/agents/model-endpoint.js";

const credentialNowMs = 1_784_236_800_000;

function validCredentials(secrets = { test: "test-stage-secret", build: "builder-stage-secret" }) {
  const requests: { readonly stage: "test" | "build"; readonly scope: string }[] = [];
  return {
    requests,
    clock: { nowMs: () => credentialNowMs },
    source: {
      async acquire(request: { readonly stage: "test" | "build"; readonly scope: string }) {
        requests.push(request);
        return {
          schemaVersion: modelStageCredentialSchemaVersion,
          stage: request.stage,
          scope: request.scope,
          issuedAtMs: credentialNowMs - 1_000,
          expiresAtMs: credentialNowMs + 60_000,
          secret: secrets[request.stage],
        } as const;
      },
    },
  };
}

const budgets = {
  dailyLimitUsd: 0.01,
  stages: {
    test: { limitUsd: 0.006, reservationUsd: 0.004 },
    build: { limitUsd: 0.006, reservationUsd: 0.004 },
  },
} as const;

const routingPolicy = {
  schemaVersion: modelRoutingPolicySchemaVersion,
  routes: {
    lower: {
      test: { id: "fixture-test-lower", provider: "deterministic-fixture", model: "fixture-model-v1" },
      build: { id: "fixture-build-lower", provider: "deterministic-fixture", model: "fixture-model-v1" },
    },
    higher: {
      test: { id: "fixture-test-higher", provider: "deterministic-fixture", model: "fixture-test-model-v2" },
      build: { id: "fixture-build-higher", provider: "deterministic-fixture", model: "fixture-build-model-v2" },
    },
  },
} as const;

const endpointPolicy = {
  schemaVersion: modelEndpointPolicySchemaVersion,
  endpoints: [{
    id: "customer-private-model-endpoint",
    routeIds: ["fixture-test-lower", "fixture-build-lower", "fixture-test-higher", "fixture-build-higher"],
    capabilities: {
      protocol: "structured-agent/v1",
      stages: ["test", "build"],
      authentication: "ephemeral-credential",
      costLimit: "maximum-cost-usd",
    },
  }],
} as const;

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
    const response = this.responses[this.invocations.length - 1];
    if (response instanceof Error) throw response;
    return response;
  }
}

const testResponse = {
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
} as const;

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
  const credentials = validCredentials();
  const provider = new StructuredModelAgentProvider(transport, budgets, credentials, routingPolicy, endpointPolicy);

  const testResult = await provider.generateTests(context);
  const buildResult = await provider.build(context);

  assert.equal(testResult.usage.model, "fixture-model-v1");
  assert.equal(buildResult.rationale.summary, "Distributed the remainder.");
  assert.equal(testResult.budgetDecision?.reservedCostUsd, 0.004);
  assert.equal(buildResult.budgetDecision?.dailyCommittedBeforeUsd, 0.002);
  assert.equal(buildResult.budgetDecision?.dailyCommittedAfterUsd, 0.004);
  assert.equal(transport.invocations[0]?.maximumCostUsd, 0.004);
  assert.deepEqual(transport.invocations[0]?.route, routingPolicy.routes.lower.test);
  assert.deepEqual(transport.invocations[1]?.route, routingPolicy.routes.lower.build);
  assert.deepEqual(transport.invocations.map(({ endpoint }) => endpoint), [
    { id: "customer-private-model-endpoint", capabilities: endpointPolicy.endpoints[0].capabilities },
    { id: "customer-private-model-endpoint", capabilities: endpointPolicy.endpoints[0].capabilities },
  ]);
  assert.equal(testResult.routingDecision?.complexity, "lower");
  assert.equal(buildResult.routingDecision?.complexity, "lower");
  assert.equal(transport.invocations[0]?.credential, "test-stage-secret");
  assert.equal(transport.invocations[1]?.credential, "builder-stage-secret");
  assert.deepEqual(credentials.requests.map(({ stage }) => stage), ["test", "build"]);
  assert.ok(credentials.requests.every(({ scope }) => /^sha256:[a-f0-9]{64}$/.test(scope)));
  assert.doesNotMatch(JSON.stringify(credentials.requests), /private\/customer/);
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
  assert.doesNotMatch(serializedRequests, /stage-secret/);
  assert.doesNotMatch(JSON.stringify([testResult, buildResult]), /stage-secret/);
});

test("routes higher-complexity test and builder tasks through explicit stage models", async () => {
  const higherContext: AgentContext = {
    ...context,
    spec: {
      ...context.spec,
      constraints: { ...context.spec.constraints, maxFiles: 3 },
    },
  };
  const transport = new DeterministicTransport([
    {
      ...testResponse,
      usage: { ...usage, model: "fixture-test-model-v2" },
    },
    {
      schemaVersion: "builder-response/v1",
      status: "completed",
      summary: "Distributed the remainder.",
      changedFiles: ["app/Domain/MoneyAllocator.php"],
      implementationNotes: [],
      usage: { ...usage, model: "fixture-build-model-v2" },
    },
  ]);
  const provider = new StructuredModelAgentProvider(
    transport,
    budgets,
    validCredentials(),
    routingPolicy,
    endpointPolicy,
  );

  const testResult = await provider.generateTests(higherContext);
  const buildResult = await provider.build(higherContext);

  assert.deepEqual(transport.invocations.map(({ route }) => route), [
    routingPolicy.routes.higher.test,
    routingPolicy.routes.higher.build,
  ]);
  assert.deepEqual(testResult.routingDecision, {
    schemaVersion: "task-complexity-decision/v1",
    stage: "test",
    complexity: "higher",
    score: 2,
    inputs: {
      maxFiles: 3,
      maxChangedLines: 80,
      acceptanceCriteria: 1,
      propertyInvariants: 1,
      evidenceItems: 1,
    },
    route: routingPolicy.routes.higher.test,
  });
  assert.equal(buildResult.routingDecision?.route.id, "fixture-build-higher");
  assert.doesNotMatch(JSON.stringify([testResult.routingDecision, buildResult.routingDecision]), /private|credential|Remainders|allocation/);
});

test("fails closed on incomplete, unsupported, or ambiguous model routing configuration", () => {
  const invalidPolicies: readonly unknown[] = [
    { schemaVersion: modelRoutingPolicySchemaVersion, routes: { lower: routingPolicy.routes.lower } },
    { ...routingPolicy, schemaVersion: "model-routing-policy/v2" },
    {
      ...routingPolicy,
      routes: {
        ...routingPolicy.routes,
        higher: {
          ...routingPolicy.routes.higher,
          test: { ...routingPolicy.routes.higher.test, id: routingPolicy.routes.lower.test.id },
        },
      },
    },
    {
      ...routingPolicy,
      routes: {
        ...routingPolicy.routes,
        higher: {
          ...routingPolicy.routes.higher,
          test: { ...routingPolicy.routes.higher.test, provider: "deterministic-fixture", model: "fixture-model-v1" },
        },
      },
    },
  ];

  for (const policy of invalidPolicies) {
    assert.throws(() => validateModelRoutingPolicy(policy as ModelRoutingPolicy));
  }
});

test("fails closed before transport on incomplete, unsupported, extended, or route-incompatible endpoint configuration", () => {
  const invalidPolicies: readonly unknown[] = [
    { schemaVersion: modelEndpointPolicySchemaVersion, endpoints: [] },
    { ...endpointPolicy, schemaVersion: "model-endpoint-policy/v2" },
    {
      ...endpointPolicy,
      endpoints: [{ ...endpointPolicy.endpoints[0], untrustedUrl: "https://customer.invalid/model" }],
    },
    {
      ...endpointPolicy,
      endpoints: [{ ...endpointPolicy.endpoints[0], id: "https://customer.invalid/model" }],
    },
    {
      ...endpointPolicy,
      endpoints: [{
        ...endpointPolicy.endpoints[0],
        capabilities: { ...endpointPolicy.endpoints[0].capabilities, protocol: "provider-specific/v1" },
      }],
    },
    {
      ...endpointPolicy,
      endpoints: [{
        ...endpointPolicy.endpoints[0],
        routeIds: endpointPolicy.endpoints[0].routeIds.filter((id) => id !== "fixture-build-higher"),
      }],
    },
    {
      ...endpointPolicy,
      endpoints: [{
        ...endpointPolicy.endpoints[0],
        capabilities: { ...endpointPolicy.endpoints[0].capabilities, stages: ["test"] },
      }],
    },
  ];

  for (const policy of invalidPolicies) {
    const transport = new DeterministicTransport([]);
    assert.throws(() => new StructuredModelAgentProvider(
      transport,
      budgets,
      validCredentials(),
      routingPolicy,
      policy as ModelEndpointPolicy,
    ));
    assert.equal(transport.invocations.length, 0);
  }
  assert.deepEqual(validateModelEndpointPolicy(endpointPolicy, routingPolicy), endpointPolicy);
});

test("rejects response usage that does not match the selected model route", async () => {
  const transport = new DeterministicTransport([{
    ...testResponse,
    usage: { ...usage, model: "unrouted-model" },
  }]);
  const provider = new StructuredModelAgentProvider(transport, budgets, validCredentials(), routingPolicy, endpointPolicy);

  await assert.rejects(provider.generateTests(context), (error) => {
    assert.ok(error instanceof StructuredModelRequestFailure);
    assert.equal(error.classification, "policy");
    assert.match(error.message, /selected model route/);
    return true;
  });
  assert.equal(transport.invocations.length, 1);
});

test("fails closed before transport for unavailable, mis-scoped, and invalid-lifetime credentials", async () => {
  const cases = [
    {
      name: "unavailable",
      credential: (_stage: "test" | "build", _scope: string) => undefined,
    },
    {
      name: "wrong stage",
      credential: (stage: "test" | "build", scope: string) => credential({ stage: stage === "test" ? "build" : "test", scope }),
    },
    {
      name: "wrong scope",
      credential: (stage: "test" | "build", scope: string) => credential({ stage, scope: `${scope}-other` }),
    },
    {
      name: "unexpected field",
      credential: (stage: "test" | "build", scope: string) => ({
        ...credential({ stage, scope }),
        leakedMetadata: "must not cross the credential boundary",
      }),
    },
    {
      name: "expired",
      credential: (stage: "test" | "build", scope: string) => credential({ stage, scope, expiresAtMs: credentialNowMs }),
    },
    {
      name: "not yet valid",
      credential: (stage: "test" | "build", scope: string) => credential({ stage, scope, issuedAtMs: credentialNowMs + 1 }),
    },
    {
      name: "not short lived",
      credential: (stage: "test" | "build", scope: string) => credential({
        stage,
        scope,
        issuedAtMs: credentialNowMs - 1,
        expiresAtMs: credentialNowMs + (15 * 60 * 1_000),
      }),
    },
  ] as const;

  for (const item of cases) {
    const transport = new DeterministicTransport([testResponse]);
    const provider = new StructuredModelAgentProvider(transport, budgets, {
      clock: { nowMs: () => credentialNowMs },
      source: {
        async acquire(request) {
          return item.credential(request.stage, request.scope);
        },
      },
    }, routingPolicy, endpointPolicy);

    await assert.rejects(provider.generateTests(context), (error) => {
      assert.ok(error instanceof StructuredModelRequestFailure, item.name);
      assert.equal(error.classification, "policy", item.name);
      assert.equal(error.requestAttempts.attempts.length, 1, item.name);
      assert.equal(error.requestAttempts.attempts[0]?.budgetDecision.actualCostUsd, 0, item.name);
      assert.doesNotMatch(error.message, /credential-secret/, item.name);
      return true;
    });
    assert.equal(transport.invocations.length, 0, item.name);
  }
});

test("prevents one credential secret from crossing the test and builder stage boundary", async () => {
  const transport = new DeterministicTransport([testResponse, {
    schemaVersion: "builder-response/v1",
    status: "completed",
    summary: "Distributed the remainder.",
    changedFiles: ["app/Domain/MoneyAllocator.php"],
    implementationNotes: [],
    usage,
  }]);
  const provider = new StructuredModelAgentProvider(
    transport,
    budgets,
    validCredentials({ test: "shared-stage-secret", build: "shared-stage-secret" }),
    routingPolicy,
    endpointPolicy,
  );

  await provider.generateTests(context);
  await assert.rejects(provider.build(context), (error) => {
    assert.ok(error instanceof StructuredModelRequestFailure);
    assert.equal(error.classification, "policy");
    assert.doesNotMatch(error.message, /shared-stage-secret/);
    return true;
  });
  assert.equal(transport.invocations.length, 1);
});

function credential(overrides: {
  readonly stage: "test" | "build";
  readonly scope: string;
  readonly issuedAtMs?: number;
  readonly expiresAtMs?: number;
}) {
  return {
    schemaVersion: modelStageCredentialSchemaVersion,
    stage: overrides.stage,
    scope: overrides.scope,
    issuedAtMs: overrides.issuedAtMs ?? credentialNowMs - 1_000,
    expiresAtMs: overrides.expiresAtMs ?? credentialNowMs + 60_000,
    secret: "credential-secret",
  } as const;
}

test("fails closed on malformed responses and response-declared path escapes", async () => {
  const malformed = new StructuredModelAgentProvider(new DeterministicTransport([{ status: "completed" }]), budgets, validCredentials(), routingPolicy, endpointPolicy);
  await assert.rejects(malformed.generateTests(context), /contain exactly/);

  const escapedTest = new StructuredModelAgentProvider(new DeterministicTransport([{
    schemaVersion: "test-agent-response/v1",
    status: "completed",
    summary: "Changed production instead of tests.",
    changedFiles: ["app/Domain/MoneyAllocator.php"],
    tests: [{ path: "app/Domain/MoneyAllocator.php", purpose: "Invalid claim.", invariants: [] }],
    usage,
  }]), budgets, validCredentials(), routingPolicy, endpointPolicy);
  await assert.rejects(escapedTest.generateTests(context), /outside its path permissions/);

  const protectedBuild = new StructuredModelAgentProvider(new DeterministicTransport([{
    schemaVersion: "builder-response/v1",
    status: "completed",
    summary: "Changed a sealed test.",
    changedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php"],
    implementationNotes: [],
    usage,
  }]), budgets, validCredentials(), routingPolicy, endpointPolicy);
  await assert.rejects(protectedBuild.build({
    ...context,
    spec: { ...context.spec, allowedFiles: ["app/**", "tests/**"] },
  }), /declares a protected file/);
});

test("rejects unavailable stage reservations before transport and preserves the specification ceiling", async () => {
  const transport = new DeterministicTransport([]);
  const stageExceeded = new StructuredModelAgentProvider(transport, {
    dailyLimitUsd: 1,
    stages: {
      test: { limitUsd: 0.1, reservationUsd: 0.2 },
      build: { limitUsd: 0.1, reservationUsd: 0.1 },
    },
  }, validCredentials(), routingPolicy, endpointPolicy);
  await assert.rejects(stageExceeded.generateTests(context), /exceeds its stage limit/);
  assert.equal(transport.invocations.length, 0);

  const specificationExceeded = new StructuredModelAgentProvider(transport, {
    dailyLimitUsd: 2,
    stages: {
      test: { limitUsd: 1, reservationUsd: 1 },
      build: { limitUsd: 1, reservationUsd: 1 },
    },
  }, validCredentials(), routingPolicy, endpointPolicy);
  const narrowSpec = { ...context, spec: { ...context.spec, constraints: { ...context.spec.constraints, maxCostUsd: 0.5 } } };
  await assert.rejects(specificationExceeded.generateTests(narrowSpec), /remaining specification budget/);
  assert.equal(transport.invocations.length, 0);
});

test("accounts actual test usage and prevents an unaffordable builder request", async () => {
  const transport = new DeterministicTransport([{
    schemaVersion: "test-agent-response/v1",
    status: "completed",
    summary: "Added a property test.",
    changedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php"],
    tests: [{
      path: "tests/Property/MoneyAllocatorInvariantTest.php",
      purpose: "Prove totals are preserved.",
      invariants: ["sum(allocation) equals total"],
    }],
    usage: { ...usage, estimatedCostUsd: 0.004 },
  }]);
  const provider = new StructuredModelAgentProvider(transport, {
    dailyLimitUsd: 0.006,
    stages: {
      test: { limitUsd: 0.005, reservationUsd: 0.005 },
      build: { limitUsd: 0.004, reservationUsd: 0.003 },
    },
  }, validCredentials(), routingPolicy, endpointPolicy, new InMemoryModelCostBudgetState());

  const testResult = await provider.generateTests(context);
  assert.equal(testResult.budgetDecision?.actualCostUsd, 0.004);
  await assert.rejects(provider.build(context), /remaining daily budget/);
  assert.equal(transport.invocations.length, 1);
});

test("rejects reported usage above the reserved transport budget", async () => {
  const transport = new DeterministicTransport([{
    schemaVersion: "test-agent-response/v1",
    status: "completed",
    summary: "Added a property test.",
    changedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php"],
    tests: [{
      path: "tests/Property/MoneyAllocatorInvariantTest.php",
      purpose: "Prove totals are preserved.",
      invariants: [],
    }],
    usage: { ...usage, estimatedCostUsd: 0.005 },
  }]);
  const provider = new StructuredModelAgentProvider(transport, budgets, validCredentials(), routingPolicy, endpointPolicy);
  await assert.rejects(provider.generateTests(context), /exceeds its reserved budget/);
  assert.equal(transport.invocations.length, 1);
});

test("retries only classified transient failures with deterministic timing and per-attempt cost reservations", async () => {
  const transport = new DeterministicTransport([
    new ModelTransportFailure("transient", "sensitive upstream timeout detail"),
    testResponse,
  ]);
  const delays: number[] = [];
  const provider = new StructuredModelAgentProvider(
    transport,
    { ...budgets, dailyLimitUsd: 0.02 },
    validCredentials(),
    routingPolicy,
    endpointPolicy,
    new InMemoryModelCostBudgetState(),
    { maxAttempts: 3, delaysMs: [25, 50] },
    { async wait(delayMs) { delays.push(delayMs); } },
  );

  const result = await provider.generateTests(context);

  assert.deepEqual(delays, [25]);
  assert.equal(transport.invocations.length, 2);
  assert.equal(result.budgetDecision?.dailyCommittedBeforeUsd, 0.004);
  assert.equal(result.budgetDecision?.dailyCommittedAfterUsd, 0.006);
  assert.deepEqual(result.requestAttempts, {
    schemaVersion: "model-request-attempts/v1",
    maxAttempts: 3,
    attempts: [
      {
        attempt: 1,
        classification: "transient",
        retryDelayMs: 25,
        budgetDecision: {
          schemaVersion: "model-cost-budget-decision/v2",
          status: "approved",
          accounting: "conservative-reservation",
          stage: "test",
          stageLimitUsd: 0.006,
          dailyLimitUsd: 0.02,
          specificationLimitUsd: 1.5,
          reservedCostUsd: 0.004,
          actualCostUsd: 0.004,
          dailyCommittedBeforeUsd: 0,
          dailyCommittedAfterUsd: 0.004,
          specificationCommittedBeforeUsd: 0,
          specificationCommittedAfterUsd: 0.004,
        },
      },
      {
        attempt: 2,
        classification: "completed",
        budgetDecision: result.budgetDecision,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result.requestAttempts), /sensitive upstream timeout detail/);
});

test("does not retry permanent, malformed-response, policy, or budget failures", async () => {
  const cases: readonly {
    readonly expected: "permanent" | "malformed-response" | "policy" | "budget";
    readonly response: unknown;
  }[] = [
    { expected: "permanent", response: new ModelTransportFailure("permanent", "credential rejected") },
    { expected: "malformed-response", response: { status: "completed" } },
    { expected: "policy", response: { ...testResponse, changedFiles: ["app/Domain/MoneyAllocator.php"] } },
    { expected: "budget", response: { ...testResponse, usage: { ...usage, estimatedCostUsd: 0.005 } } },
  ];

  for (const item of cases) {
    const transport = new DeterministicTransport([item.response, testResponse]);
    const provider = new StructuredModelAgentProvider(
      transport,
      budgets,
      validCredentials(),
      routingPolicy,
      endpointPolicy,
      new InMemoryModelCostBudgetState(),
      { maxAttempts: 2, delaysMs: [0] },
      { async wait() { throw new Error("Unexpected retry timing."); } },
    );
    await assert.rejects(provider.generateTests(context), (error) => {
      assert.ok(error instanceof StructuredModelRequestFailure);
      assert.equal(error.classification, item.expected);
      assert.equal(error.requestAttempts.attempts.length, 1);
      return true;
    });
    assert.equal(transport.invocations.length, 1);
  }
});

test("bounds retry configuration and stops after the configured transient attempt count", async () => {
  assert.throws(() => new StructuredModelAgentProvider(
    new DeterministicTransport([]),
    budgets,
    validCredentials(),
    routingPolicy,
    endpointPolicy,
    new InMemoryModelCostBudgetState(),
    { maxAttempts: 6, delaysMs: [0, 0, 0, 0, 0] },
  ), /maxAttempts/);

  const transport = new DeterministicTransport([
    new ModelTransportFailure("transient"),
    new ModelTransportFailure("transient"),
    testResponse,
  ]);
  const provider = new StructuredModelAgentProvider(
    transport,
    { ...budgets, dailyLimitUsd: 0.02 },
    validCredentials(),
    routingPolicy,
    endpointPolicy,
    new InMemoryModelCostBudgetState(),
    { maxAttempts: 2, delaysMs: [0] },
    { async wait() {} },
  );
  await assert.rejects(provider.generateTests(context), (error) => {
    assert.ok(error instanceof StructuredModelRequestFailure);
    assert.equal(error.classification, "transient");
    assert.equal(error.requestAttempts.attempts.length, 2);
    return true;
  });
  assert.equal(transport.invocations.length, 2);
});

test("fails closed before a retry transport call when conservative usage exhausts the daily budget", async () => {
  const transport = new DeterministicTransport([
    new ModelTransportFailure("transient"),
    testResponse,
  ]);
  const provider = new StructuredModelAgentProvider(
    transport,
    { ...budgets, dailyLimitUsd: 0.007 },
    validCredentials(),
    routingPolicy,
    endpointPolicy,
    new InMemoryModelCostBudgetState(),
    { maxAttempts: 2, delaysMs: [0] },
    { async wait() {} },
  );

  await assert.rejects(provider.generateTests(context), (error) => {
    assert.ok(error instanceof StructuredModelRequestFailure);
    assert.equal(error.classification, "budget");
    assert.equal(error.requestAttempts.attempts[0]?.budgetDecision.accounting, "conservative-reservation");
    assert.equal(error.requestAttempts.attempts[0]?.budgetDecision.dailyCommittedAfterUsd, 0.004);
    return true;
  });
  assert.equal(transport.invocations.length, 1);
});
