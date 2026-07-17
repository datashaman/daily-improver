import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import test from "node:test";
import {
  BoundedHttpsClientFailure,
  type BoundedHttpsClient,
  type BoundedHttpsRequest,
  type BoundedHttpsResponse,
} from "../src/agents/https-structured-endpoint-transport.js";
import {
  modelCredentialExchangeRequestSchemaVersion,
  modelCredentialExchangeResolutionSchemaVersion,
  TrustedRunnerModelStageCredentialSource,
  trustedRunnerIdentitySchemaVersion,
  type TrustedModelCredentialExchangeResolver,
  type TrustedRunnerIdentityRequest,
  type TrustedRunnerIdentitySource,
} from "../src/agents/trusted-runner-model-stage-credential-source.js";
import {
  ModelStageCredentialAcquisitionFailure,
  modelStageCredentialSchemaVersion,
  type ModelStageCredentialRequest,
} from "../src/agents/model-stage-credential.js";

const nowMs = 1_784_236_800_000;
const scope = `sha256:${"a".repeat(64)}`;
const request: ModelStageCredentialRequest = { stage: "test", scope };
const assertion = "trusted-runner-oidc-assertion";
const credentialSecret = "short-lived-test-stage-credential";
const exchangeUrl = "https://control.daily-improver.example/model-credentials";
const issuer = "https://token.actions.githubusercontent.com/";
const audience = "daily-improver-model-credential-exchange";

class RecordingIdentitySource implements TrustedRunnerIdentitySource {
  readonly requests: TrustedRunnerIdentityRequest[] = [];

  constructor(private readonly result: unknown = validIdentity()) {}

  async acquire(identityRequest: TrustedRunnerIdentityRequest): Promise<unknown> {
    this.requests.push(identityRequest);
    return this.result;
  }
}

class StaticResolver implements TrustedModelCredentialExchangeResolver {
  calls = 0;

  constructor(private readonly result: unknown = validResolution()) {}

  async resolve(): Promise<unknown> {
    this.calls++;
    return this.result;
  }
}

class RecordingClient implements BoundedHttpsClient {
  readonly requests: BoundedHttpsRequest[] = [];

  constructor(private readonly result: BoundedHttpsResponse | Error = response(200, validCredential())) {}

  async send(httpsRequest: BoundedHttpsRequest): Promise<BoundedHttpsResponse> {
    this.requests.push(httpsRequest);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

test("exchanges injected trusted runner identity for one exact stage-scoped credential", async () => {
  const identities = new RecordingIdentitySource();
  const resolver = new StaticResolver();
  const client = new RecordingClient();
  const source = new TrustedRunnerModelStageCredentialSource(identities, resolver, client, { nowMs: () => nowMs });

  const credential = await source.acquire(request);

  assert.deepEqual(credential, validCredential());
  assert.equal(resolver.calls, 1);
  assert.deepEqual(identities.requests, [{ stage: "test", scope, issuer, audience }]);
  assert.equal(client.requests.length, 1);
  const outbound = client.requests[0];
  assert.ok(outbound);
  assert.equal(outbound.url.toString(), exchangeUrl);
  assert.equal(outbound.timeoutMs, 20_000);
  assert.equal(outbound.maxResponseBytes, 32_000);
  assert.equal(outbound.headers.authorization, `Bearer ${assertion}`);
  assert.deepEqual(JSON.parse(Buffer.from(outbound.body).toString("utf8")), {
    schemaVersion: modelCredentialExchangeRequestSchemaVersion,
    stage: "test",
    scope,
    identity: {
      schemaVersion: trustedRunnerIdentitySchemaVersion,
      issuer,
      audience,
      issuedAtMs: nowMs - 1_000,
      expiresAtMs: nowMs + 60_000,
    },
  });
  assert.doesNotMatch(Buffer.from(outbound.body).toString("utf8"), /trusted-runner-oidc-assertion|short-lived-test-stage-credential|control\.daily-improver/);
  assert.equal(JSON.stringify(identities.requests).includes(assertion), false);
});

test("rejects untrusted exchange configuration and identity claims before exchange", async () => {
  const invalidResolutions: readonly unknown[] = [
    null,
    { ...validResolution(), url: "http://control.example/exchange" },
    { ...validResolution(), url: "https://user:password@control.example/exchange" },
    { ...validResolution(), url: `${exchangeUrl}#fragment` },
    { ...validResolution(), timeoutMs: 121_000 },
    { ...validResolution(), maxResponseBytes: 1_048_577 },
    { ...validResolution(), repositoryOverride: assertion },
  ];
  for (const resolution of invalidResolutions) {
    const identities = new RecordingIdentitySource();
    const client = new RecordingClient();
    const source = new TrustedRunnerModelStageCredentialSource(
      identities, new StaticResolver(resolution), client, { nowMs: () => nowMs },
    );
    await rejectsSanitized(source.acquire(request), "policy");
    assert.equal(identities.requests.length, 0);
    assert.equal(client.requests.length, 0);
  }

  const invalidIdentities: readonly unknown[] = [
    null,
    { ...validIdentity(), issuer: "https://untrusted.example/" },
    { ...validIdentity(), audience: "another-audience" },
    { ...validIdentity(), stage: "build" },
    { ...validIdentity(), scope: `sha256:${"b".repeat(64)}` },
    { ...validIdentity(), expiresAtMs: nowMs + (15 * 60 * 1_000) },
    { ...validIdentity(), repositoryAssertion: assertion },
  ];
  for (const identity of invalidIdentities) {
    const client = new RecordingClient();
    const source = new TrustedRunnerModelStageCredentialSource(
      new RecordingIdentitySource(identity), new StaticResolver(), client, { nowMs: () => nowMs },
    );
    await rejectsSanitized(source.acquire(request), "policy");
    assert.equal(client.requests.length, 0);
  }
});

test("bounds exchange requests and rejects malformed or mis-scoped credentials", async () => {
  const requestBoundSource = new TrustedRunnerModelStageCredentialSource(
    new RecordingIdentitySource(validIdentity({ assertion: "x".repeat(800) })),
    new StaticResolver(validResolution({ maxRequestBytes: 1_024 })),
    new RecordingClient(),
    { nowMs: () => nowMs },
  );
  await rejectsSanitized(requestBoundSource.acquire(request), "policy");

  const oversizedIdentity = validIdentity({ assertion: "x".repeat(16_385) });
  const source = new TrustedRunnerModelStageCredentialSource(
    new RecordingIdentitySource(oversizedIdentity), new StaticResolver(), new RecordingClient(), { nowMs: () => nowMs },
  );
  await rejectsSanitized(source.acquire(request), "policy");

  const cases: readonly BoundedHttpsResponse[] = [
    response(200, { ...validCredential(), stage: "build" }),
    response(200, { ...validCredential(), scope: `sha256:${"b".repeat(64)}` }),
    response(200, { ...validCredential(), expiresAtMs: nowMs + (15 * 60 * 1_000) }),
    response(200, { ...validCredential(), extra: assertion }),
    response(Number.NaN, validCredential()),
    rawResponse(200, "{bad-json"),
    response(200, validCredential(), { "content-type": "text/plain" }),
    rawResponse(200, "x".repeat(32_001)),
  ];
  for (const result of cases) {
    const exchange = new TrustedRunnerModelStageCredentialSource(
      new RecordingIdentitySource(), new StaticResolver(), new RecordingClient(result), { nowMs: () => nowMs },
    );
    await rejectsSanitized(exchange.acquire(request), "malformed-response");
  }
});

test("classifies exchange retryability without leaking identity or credential material", async () => {
  const cases = [
    { result: new BoundedHttpsClientFailure("connection"), classification: "transient" },
    { result: new BoundedHttpsClientFailure("timeout"), classification: "transient" },
    { result: new BoundedHttpsClientFailure("response-too-large"), classification: "malformed-response" },
    { result: response(429, { error: assertion }), classification: "transient" },
    { result: response(503, { error: credentialSecret }), classification: "transient" },
    { result: response(401, { error: assertion }), classification: "permanent" },
    { result: response(307, { location: exchangeUrl }), classification: "permanent" },
    { result: new Error(`${exchangeUrl} ${assertion}`), classification: "permanent" },
  ] as const;
  for (const item of cases) {
    const source = new TrustedRunnerModelStageCredentialSource(
      new RecordingIdentitySource(), new StaticResolver(), new RecordingClient(item.result), { nowMs: () => nowMs },
    );
    await rejectsSanitized(source.acquire(request), item.classification);
  }
});

function validResolution(overrides: Partial<{ readonly maxRequestBytes: number }> = {}) {
  return {
    schemaVersion: modelCredentialExchangeResolutionSchemaVersion,
    url: exchangeUrl,
    issuer,
    audience,
    timeoutMs: 20_000,
    maxRequestBytes: overrides.maxRequestBytes ?? 32_000,
    maxResponseBytes: 32_000,
  } as const;
}

function validIdentity(overrides: Partial<{ readonly assertion: string }> = {}) {
  return {
    schemaVersion: trustedRunnerIdentitySchemaVersion,
    issuer,
    audience,
    stage: "test",
    scope,
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
    assertion: overrides.assertion ?? assertion,
  } as const;
}

function validCredential() {
  return {
    schemaVersion: modelStageCredentialSchemaVersion,
    stage: "test",
    scope,
    issuedAtMs: nowMs - 500,
    expiresAtMs: nowMs + 30_000,
    secret: credentialSecret,
  } as const;
}

function response(
  statusCode: number,
  body: unknown,
  headers: IncomingHttpHeaders = { "content-type": "application/json" },
): BoundedHttpsResponse {
  return { statusCode, headers, body: Buffer.from(JSON.stringify(body), "utf8") };
}

function rawResponse(statusCode: number, body: string): BoundedHttpsResponse {
  return { statusCode, headers: { "content-type": "application/json" }, body: Buffer.from(body, "utf8") };
}

async function rejectsSanitized(
  promise: Promise<unknown>,
  classification: ModelStageCredentialAcquisitionFailure["classification"],
): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ModelStageCredentialAcquisitionFailure);
    assert.equal(error.classification, classification);
    assert.doesNotMatch(error.message, /actions\.githubusercontent|daily-improver\.example|oidc-assertion|short-lived|password|fragment/);
    return true;
  });
}
