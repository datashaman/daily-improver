import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingHttpHeaders } from "node:http";
import {
  BoundedHttpsClientFailure,
  HttpsStructuredEndpointTransport,
  modelEndpointResolutionSchemaVersion,
  structuredModelEndpointRequestSchemaVersion,
  type BoundedHttpsClient,
  type BoundedHttpsRequest,
  type BoundedHttpsResponse,
  type TrustedModelEndpointResolver,
} from "../src/agents/https-structured-endpoint-transport.js";
import { ModelTransportFailure } from "../src/agents/model-request-retry.js";
import type { ModelTransportInvocation } from "../src/agents/structured-model-agent-provider.js";

const privateLocator = "https://models.customer.example/private/structured";
const credential = "ephemeral-test-secret";

const invocation: ModelTransportInvocation = {
  stage: "test",
  request: {
    schemaVersion: "test-agent-request/v1",
    stage: "test",
    task: {
      id: "spec-money-allocation",
      title: "Preserve allocation totals",
      objective: "Ensure integer allocations preserve the requested total.",
      currentBehaviour: "Remainders are discarded.",
      proposedImprovement: "Distribute the remainder deterministically.",
      behavioursToPreserve: ["Reject invalid part counts."],
      acceptanceCriteria: ["Every allocation sums to the requested total."],
      propertyInvariants: ["sum(allocation) equals total"],
      exclusions: ["Public API changes"],
      evidence: ["An escaped mutation removes remainder distribution."],
      limits: { maxFiles: 2, maxChangedLines: 80, maxCostUsd: 1.5 },
    },
    repository: { language: "php", frameworks: ["laravel"] },
    allowedTestPaths: ["tests/Property/**"],
    commands: [{ purpose: "test", argv: ["php", "tests/run.php"] }],
    conventions: ["Use the repository test harness."],
  },
  workingDirectory: "/private/customer/repository",
  maximumCostUsd: 0.004,
  credential,
  route: {
    id: "customer-test-lower",
    provider: "customer-model-provider",
    model: "customer-model-v1",
  },
  endpoint: {
    id: "customer-private-model-endpoint",
    capabilities: {
      protocol: "structured-agent/v1",
      stages: ["test"],
      authentication: "ephemeral-credential",
      costLimit: "maximum-cost-usd",
    },
  },
};

const successBody = {
  schemaVersion: "test-agent-response/v1",
  status: "completed",
  summary: "Added an allocation property test.",
  changedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php"],
  tests: [{
    path: "tests/Property/MoneyAllocatorInvariantTest.php",
    purpose: "Prove totals are preserved.",
    invariants: ["sum(allocation) equals total"],
  }],
  usage: {
    provider: "customer-model-provider",
    model: "customer-model-v1",
    inputTokens: 240,
    outputTokens: 90,
    latencyMs: 18,
    estimatedCostUsd: 0.002,
  },
} as const;

class RecordingResolver implements TrustedModelEndpointResolver {
  readonly endpointIds: string[] = [];

  constructor(private readonly resolution: unknown = validResolution()) {}

  async resolve(endpointId: string): Promise<unknown> {
    this.endpointIds.push(endpointId);
    return this.resolution;
  }
}

class RecordingClient implements BoundedHttpsClient {
  readonly requests: BoundedHttpsRequest[] = [];

  constructor(private readonly result: BoundedHttpsResponse | Error = response(200, successBody)) {}

  async send(request: BoundedHttpsRequest): Promise<BoundedHttpsResponse> {
    this.requests.push(request);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

test("resolves an opaque endpoint and sends one bounded authenticated structured HTTPS request", async () => {
  const resolver = new RecordingResolver();
  const client = new RecordingClient();
  const transport = new HttpsStructuredEndpointTransport(resolver, client);

  const result = await transport.invoke(invocation);

  assert.deepEqual(result, successBody);
  assert.deepEqual(resolver.endpointIds, ["customer-private-model-endpoint"]);
  assert.equal(client.requests.length, 1);
  const request = client.requests[0];
  assert.ok(request);
  assert.equal(request.url.toString(), privateLocator);
  assert.equal(request.method, "POST");
  assert.equal(request.timeoutMs, 30_000);
  assert.equal(request.maxResponseBytes, 128_000);
  assert.equal(request.headers.authorization, `Bearer ${credential}`);
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers["content-length"], String(request.body.byteLength));
  assert.deepEqual(JSON.parse(Buffer.from(request.body).toString("utf8")), {
    schemaVersion: structuredModelEndpointRequestSchemaVersion,
    stage: "test",
    request: invocation.request,
    route: invocation.route,
    maximumCostUsd: 0.004,
  });
  assert.doesNotMatch(Buffer.from(request.body).toString("utf8"), /customer\.example|ephemeral-test-secret|private\/customer/);
});

test("fails closed when trusted resolution is missing, mismatched, extended, or not HTTPS", async () => {
  const invalidResolutions: readonly unknown[] = [
    null,
    { ...validResolution(), endpointId: "another-endpoint" },
    { ...validResolution(), url: "http://models.customer.example/private/structured" },
    { ...validResolution(), url: "https://user:password@models.customer.example/private/structured" },
    { ...validResolution(), url: `${privateLocator}#secret-fragment` },
    { ...validResolution(), timeoutMs: 999 },
    { ...validResolution(), maxResponseBytes: 1_048_577 },
    { ...validResolution(), source: "untrusted-repository-input" },
  ];

  for (const resolution of invalidResolutions) {
    const client = new RecordingClient();
    const transport = new HttpsStructuredEndpointTransport(new RecordingResolver(resolution), client);
    await assert.rejects(transport.invoke(invocation), (error) => {
      assert.ok(error instanceof ModelTransportFailure);
      assert.equal(error.classification, "policy");
      assert.doesNotMatch(error.message, /customer\.example|password|secret-fragment|untrusted-repository-input/);
      return true;
    });
    assert.equal(client.requests.length, 0);
  }
});

test("bounds the serialized request before the HTTPS client receives it", async () => {
  const client = new RecordingClient();
  const transport = new HttpsStructuredEndpointTransport(
    new RecordingResolver(validResolution({ maxRequestBytes: 1_024 })),
    client,
  );
  const oversized: ModelTransportInvocation = {
    ...invocation,
    request: {
      ...invocation.request,
      task: { ...invocation.request.task, evidence: ["x".repeat(2_000)] },
    },
  };

  await assert.rejects(transport.invoke(oversized), (error) => {
    assert.ok(error instanceof ModelTransportFailure);
    assert.equal(error.classification, "policy");
    return true;
  });
  assert.equal(client.requests.length, 0);
});

test("classifies connection, timeout, HTTP, oversized, and malformed endpoint failures", async () => {
  const cases: readonly {
    readonly name: string;
    readonly result: BoundedHttpsResponse | Error;
    readonly classification: ModelTransportFailure["classification"];
  }[] = [
    { name: "connection", result: new BoundedHttpsClientFailure("connection"), classification: "transient" },
    { name: "timeout", result: new BoundedHttpsClientFailure("timeout"), classification: "transient" },
    { name: "response too large", result: new BoundedHttpsClientFailure("response-too-large"), classification: "malformed-response" },
    { name: "rate limited", result: response(429, { error: "upstream rate limit detail" }), classification: "transient" },
    { name: "server failure", result: response(503, { error: "upstream failure detail" }), classification: "transient" },
    { name: "authentication rejected", result: response(401, { error: "credential rejected" }), classification: "permanent" },
    { name: "redirect rejected", result: response(307, {}), classification: "permanent" },
    { name: "wrong content type", result: response(200, successBody, { "content-type": "text/plain" }), classification: "malformed-response" },
    { name: "malformed JSON", result: rawResponse(200, "{not-json"), classification: "malformed-response" },
    { name: "oversized response", result: rawResponse(200, "x".repeat(128_001)), classification: "malformed-response" },
    { name: "unknown client failure", result: new Error(`${privateLocator} ${credential}`), classification: "permanent" },
  ];

  for (const item of cases) {
    const transport = new HttpsStructuredEndpointTransport(new RecordingResolver(), new RecordingClient(item.result));
    await assert.rejects(transport.invoke(invocation), (error) => {
      assert.ok(error instanceof ModelTransportFailure, item.name);
      assert.equal(error.classification, item.classification, item.name);
      assert.doesNotMatch(error.message, /customer\.example|ephemeral-test-secret|upstream|credential rejected/, item.name);
      return true;
    });
  }
});

function validResolution(overrides: Partial<{
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}> = {}) {
  return {
    schemaVersion: modelEndpointResolutionSchemaVersion,
    endpointId: "customer-private-model-endpoint",
    url: privateLocator,
    timeoutMs: overrides.timeoutMs ?? 30_000,
    maxRequestBytes: overrides.maxRequestBytes ?? 128_000,
    maxResponseBytes: overrides.maxResponseBytes ?? 128_000,
  } as const;
}

function response(
  statusCode: number,
  body: unknown,
  headers: IncomingHttpHeaders = { "content-type": "application/json; charset=utf-8" },
): BoundedHttpsResponse {
  return { statusCode, headers, body: Buffer.from(JSON.stringify(body), "utf8") };
}

function rawResponse(statusCode: number, body: string): BoundedHttpsResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: Buffer.from(body, "utf8"),
  };
}
