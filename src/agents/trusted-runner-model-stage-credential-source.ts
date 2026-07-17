import {
  BoundedHttpsClientFailure,
  NodeBoundedHttpsClient,
  type BoundedHttpsClient,
  type BoundedHttpsResponse,
} from "./https-structured-endpoint-transport.js";
import {
  maximumModelStageCredentialLifetimeMs,
  ModelStageCredentialAcquisitionFailure,
  systemModelCredentialClock,
  validateModelStageCredential,
  type ModelCredentialClock,
  type ModelStageCredential,
  type ModelStageCredentialRequest,
  type ModelStageCredentialSource,
} from "./model-stage-credential.js";

export const trustedRunnerIdentitySchemaVersion = "trusted-runner-identity/v1" as const;
export const modelCredentialExchangeResolutionSchemaVersion = "model-credential-exchange-resolution/v1" as const;
export const modelCredentialExchangeRequestSchemaVersion = "model-credential-exchange-request/v1" as const;

const minimumTimeoutMs = 1_000;
const maximumTimeoutMs = 120_000;
const minimumBodyBytes = 1_024;
const maximumBodyBytes = 1_048_576;
const maximumAssertionBytes = 16_384;
const scopePattern = /^sha256:[a-f0-9]{64}$/;

export interface TrustedRunnerIdentityRequest extends ModelStageCredentialRequest {
  readonly issuer: string;
  readonly audience: string;
}

export interface TrustedRunnerIdentity {
  readonly schemaVersion: typeof trustedRunnerIdentitySchemaVersion;
  readonly issuer: string;
  readonly audience: string;
  readonly stage: ModelStageCredentialRequest["stage"];
  readonly scope: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly assertion: string;
}

export interface TrustedRunnerIdentitySource {
  acquire(request: TrustedRunnerIdentityRequest): Promise<unknown>;
}

export interface TrustedModelCredentialExchangeResolver {
  resolve(): Promise<unknown>;
}

export interface ModelCredentialExchangeResolution {
  readonly schemaVersion: typeof modelCredentialExchangeResolutionSchemaVersion;
  readonly url: string;
  readonly issuer: string;
  readonly audience: string;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

export class TrustedRunnerModelStageCredentialSource implements ModelStageCredentialSource {
  constructor(
    private readonly identities: TrustedRunnerIdentitySource,
    private readonly resolver: TrustedModelCredentialExchangeResolver,
    private readonly client: BoundedHttpsClient = new NodeBoundedHttpsClient(),
    private readonly clock: ModelCredentialClock = systemModelCredentialClock,
  ) {}

  async acquire(request: ModelStageCredentialRequest): Promise<ModelStageCredential> {
    validateCredentialRequest(request);
    const resolution = await this.resolve();
    const nowMs = this.clock.nowMs();
    const identityRequest = {
      stage: request.stage,
      scope: request.scope,
      issuer: resolution.issuer,
      audience: resolution.audience,
    } as const;
    let identity: TrustedRunnerIdentity;
    try {
      identity = parseIdentity(await this.acquireIdentity(identityRequest), identityRequest, nowMs);
    } catch {
      throw failure("policy");
    }
    const wireRequest = {
      schemaVersion: modelCredentialExchangeRequestSchemaVersion,
      stage: request.stage,
      scope: request.scope,
      identity: {
        schemaVersion: identity.schemaVersion,
        issuer: identity.issuer,
        audience: identity.audience,
        issuedAtMs: identity.issuedAtMs,
        expiresAtMs: identity.expiresAtMs,
      },
    } as const;
    const body = Buffer.from(JSON.stringify(wireRequest), "utf8");
    if (body.byteLength + Buffer.byteLength(identity.assertion, "utf8") > resolution.maxRequestBytes) throw failure("policy");

    const response = await this.exchange(resolution, identity.assertion, body);
    if (response.body.byteLength > resolution.maxResponseBytes) throw failure("malformed-response");
    if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
      throw failure("malformed-response");
    }
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw failure(transientHttpStatus(response.statusCode) ? "transient" : "permanent");
    }
    if (!jsonContentType(response.headers["content-type"])) throw failure("malformed-response");
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown;
    } catch {
      throw failure("malformed-response");
    }
    try {
      return validateModelStageCredential(value, request, this.clock.nowMs());
    } catch {
      throw failure("malformed-response");
    }
  }

  private async resolve(): Promise<ModelCredentialExchangeResolution> {
    try {
      return parseResolution(await this.resolver.resolve());
    } catch {
      throw failure("policy");
    }
  }

  private async acquireIdentity(request: TrustedRunnerIdentityRequest): Promise<unknown> {
    try {
      return await this.identities.acquire(request);
    } catch (error) {
      if (error instanceof ModelStageCredentialAcquisitionFailure) throw failure(error.classification);
      throw failure("policy");
    }
  }

  private async exchange(
    resolution: ModelCredentialExchangeResolution,
    assertion: string,
    body: Uint8Array,
  ): Promise<BoundedHttpsResponse> {
    try {
      return await this.client.send({
        url: new URL(resolution.url),
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${assertion}`,
          "content-length": String(body.byteLength),
          "content-type": "application/json",
        },
        body,
        timeoutMs: resolution.timeoutMs,
        maxResponseBytes: resolution.maxResponseBytes,
      });
    } catch (error) {
      if (error instanceof BoundedHttpsClientFailure && error.kind === "response-too-large") {
        throw failure("malformed-response");
      }
      if (error instanceof BoundedHttpsClientFailure && (error.kind === "connection" || error.kind === "timeout")) {
        throw failure("transient");
      }
      throw failure("permanent");
    }
  }
}

function validateCredentialRequest(request: ModelStageCredentialRequest): void {
  if ((request.stage !== "test" && request.stage !== "build") || !scopePattern.test(request.scope)) throw failure("policy");
}

function parseResolution(value: unknown): ModelCredentialExchangeResolution {
  const resolution = exactRecord(value, [
    "schemaVersion", "url", "issuer", "audience", "timeoutMs", "maxRequestBytes", "maxResponseBytes",
  ]);
  if (resolution.schemaVersion !== modelCredentialExchangeResolutionSchemaVersion) throw new Error("Unsupported exchange resolution.");
  const url = secureUrl(resolution.url);
  const issuer = secureUrl(resolution.issuer);
  const audience = boundedString(resolution.audience, 1, 512);
  return {
    schemaVersion: modelCredentialExchangeResolutionSchemaVersion,
    url: url.toString(),
    issuer: issuer.toString(),
    audience,
    timeoutMs: boundedInteger(resolution.timeoutMs, minimumTimeoutMs, maximumTimeoutMs),
    maxRequestBytes: boundedInteger(resolution.maxRequestBytes, minimumBodyBytes, maximumBodyBytes),
    maxResponseBytes: boundedInteger(resolution.maxResponseBytes, minimumBodyBytes, maximumBodyBytes),
  };
}

function parseIdentity(value: unknown, request: TrustedRunnerIdentityRequest, nowMs: number): TrustedRunnerIdentity {
  const identity = exactRecord(value, [
    "schemaVersion", "issuer", "audience", "stage", "scope", "issuedAtMs", "expiresAtMs", "assertion",
  ]);
  if (identity.schemaVersion !== trustedRunnerIdentitySchemaVersion
    || identity.issuer !== request.issuer
    || identity.audience !== request.audience
    || identity.stage !== request.stage
    || identity.scope !== request.scope) throw failure("policy");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0
    || !Number.isSafeInteger(identity.issuedAtMs) || !Number.isSafeInteger(identity.expiresAtMs)
    || typeof identity.issuedAtMs !== "number" || typeof identity.expiresAtMs !== "number"
    || identity.issuedAtMs < 0 || identity.issuedAtMs > nowMs || identity.expiresAtMs <= nowMs
    || identity.expiresAtMs <= identity.issuedAtMs
    || identity.expiresAtMs - identity.issuedAtMs > maximumModelStageCredentialLifetimeMs) throw failure("policy");
  const assertion = boundedString(identity.assertion, 1, maximumAssertionBytes);
  return { ...identity, assertion } as unknown as TrustedRunnerIdentity;
}

function secureUrl(value: unknown): URL {
  const raw = boundedString(value, 1, 2_048);
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") throw new Error("HTTPS URL required.");
  return url;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object.");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("Unexpected object shape.");
  return record;
}

function boundedString(value: unknown, minimumBytes: number, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error("Expected a string.");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) throw new Error("String is outside supported bounds.");
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error("Integer is outside supported bounds.");
  return value;
}

function transientHttpStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

function jsonContentType(value: string | readonly string[] | undefined): boolean {
  const contentType = Array.isArray(value) ? value[0] : value;
  return typeof contentType === "string" && /^application\/json(?:\s*;|$)/i.test(contentType);
}

function failure(classification: ModelStageCredentialAcquisitionFailure["classification"]): ModelStageCredentialAcquisitionFailure {
  return new ModelStageCredentialAcquisitionFailure(classification);
}
