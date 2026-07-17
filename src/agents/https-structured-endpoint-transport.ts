import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { ModelTransportFailure } from "./model-request-retry.js";
import type {
  ModelTransport,
  ModelTransportInvocation,
} from "./structured-model-agent-provider.js";

export const modelEndpointResolutionSchemaVersion = "model-endpoint-resolution/v1" as const;
export const structuredModelEndpointRequestSchemaVersion = "structured-model-endpoint-request/v1" as const;

const minimumTimeoutMs = 1_000;
const maximumTimeoutMs = 120_000;
const minimumBodyBytes = 1_024;
const maximumBodyBytes = 1_048_576;

export interface ModelEndpointResolution {
  readonly schemaVersion: typeof modelEndpointResolutionSchemaVersion;
  readonly endpointId: string;
  readonly url: string;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

export interface TrustedModelEndpointResolver {
  resolve(endpointId: string): Promise<unknown>;
}

export interface BoundedHttpsRequest {
  readonly url: URL;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface BoundedHttpsResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Uint8Array;
}

export interface BoundedHttpsClient {
  send(request: BoundedHttpsRequest): Promise<BoundedHttpsResponse>;
}

export type BoundedHttpsClientFailureKind = "connection" | "timeout" | "response-too-large";

export class BoundedHttpsClientFailure extends Error {
  override readonly name = "BoundedHttpsClientFailure";

  constructor(readonly kind: BoundedHttpsClientFailureKind) {
    super("The bounded HTTPS request failed.");
  }
}

export class NodeBoundedHttpsClient implements BoundedHttpsClient {
  async send(request: BoundedHttpsRequest): Promise<BoundedHttpsResponse> {
    return new Promise<BoundedHttpsResponse>((resolve, reject) => {
      const outbound = httpsRequest(request.url, {
        method: request.method,
        headers: request.headers,
        signal: AbortSignal.timeout(request.timeoutMs),
      }, (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          receivedBytes += buffer.byteLength;
          if (receivedBytes > request.maxResponseBytes) {
            response.destroy(new BoundedHttpsClientFailure("response-too-large"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks, receivedBytes),
        }));
        response.on("error", (error: Error) => reject(normalizeClientError(error)));
      });
      outbound.on("error", (error: Error) => reject(normalizeClientError(error)));
      outbound.end(request.body);
    });
  }
}

export class HttpsStructuredEndpointTransport implements ModelTransport {
  constructor(
    private readonly resolver: TrustedModelEndpointResolver,
    private readonly client: BoundedHttpsClient = new NodeBoundedHttpsClient(),
  ) {}

  async invoke(invocation: ModelTransportInvocation): Promise<unknown> {
    let resolution: ModelEndpointResolution;
    try {
      resolution = parseResolution(await this.resolver.resolve(invocation.endpoint.id), invocation.endpoint.id);
    } catch {
      throw new ModelTransportFailure("policy", "The configured model endpoint is unavailable.");
    }

    const wireRequest = {
      schemaVersion: structuredModelEndpointRequestSchemaVersion,
      stage: invocation.stage,
      request: invocation.request,
      route: invocation.route,
      maximumCostUsd: invocation.maximumCostUsd,
    } as const;
    const body = Buffer.from(JSON.stringify(wireRequest), "utf8");
    if (body.byteLength > resolution.maxRequestBytes) {
      throw new ModelTransportFailure("policy", "The structured model request exceeds its configured size limit.");
    }

    let response: BoundedHttpsResponse;
    try {
      response = await this.client.send({
        url: new URL(resolution.url),
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${invocation.credential}`,
          "content-length": String(body.byteLength),
          "content-type": "application/json",
        },
        body,
        timeoutMs: resolution.timeoutMs,
        maxResponseBytes: resolution.maxResponseBytes,
      });
    } catch (error) {
      if (error instanceof BoundedHttpsClientFailure && error.kind === "response-too-large") {
        throw new ModelTransportFailure("malformed-response", "The model endpoint response exceeds its configured size limit.");
      }
      const classification = error instanceof BoundedHttpsClientFailure
        && (error.kind === "connection" || error.kind === "timeout")
        ? "transient"
        : "permanent";
      throw new ModelTransportFailure(classification, "The HTTPS model endpoint request failed.");
    }

    if (response.body.byteLength > resolution.maxResponseBytes) {
      throw new ModelTransportFailure("malformed-response", "The model endpoint response exceeds its configured size limit.");
    }
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new ModelTransportFailure(
        transientHttpStatus(response.statusCode) ? "transient" : "permanent",
        "The model endpoint returned an unsuccessful HTTP status.",
      );
    }
    if (!jsonContentType(response.headers["content-type"])) {
      throw new ModelTransportFailure("malformed-response", "The model endpoint response is not structured JSON.");
    }
    try {
      return JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown;
    } catch {
      throw new ModelTransportFailure("malformed-response", "The model endpoint response is malformed.");
    }
  }
}

function parseResolution(value: unknown, expectedEndpointId: string): ModelEndpointResolution {
  const resolution = exactRecord(value, [
    "schemaVersion",
    "endpointId",
    "url",
    "timeoutMs",
    "maxRequestBytes",
    "maxResponseBytes",
  ]);
  if (resolution.schemaVersion !== modelEndpointResolutionSchemaVersion) {
    throw new Error("Unsupported model endpoint resolution schema.");
  }
  if (resolution.endpointId !== expectedEndpointId) {
    throw new Error("Resolved model endpoint does not match the requested opaque id.");
  }
  if (typeof resolution.url !== "string" || resolution.url.length < 1 || resolution.url.length > 2_048) {
    throw new Error("Resolved model endpoint URL is invalid.");
  }
  const url = new URL(resolution.url);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("Resolved model endpoints must use HTTPS without embedded authentication or fragments.");
  }
  const timeoutMs = boundedInteger(resolution.timeoutMs, minimumTimeoutMs, maximumTimeoutMs, "timeout");
  const maxRequestBytes = boundedInteger(resolution.maxRequestBytes, minimumBodyBytes, maximumBodyBytes, "request size");
  const maxResponseBytes = boundedInteger(resolution.maxResponseBytes, minimumBodyBytes, maximumBodyBytes, "response size");
  return {
    schemaVersion: modelEndpointResolutionSchemaVersion,
    endpointId: expectedEndpointId,
    url: url.toString(),
    timeoutMs,
    maxRequestBytes,
    maxResponseBytes,
  };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Model endpoint resolution must be an object.");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Model endpoint resolution has an invalid shape.");
  }
  return record;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new Error(`Model endpoint ${name} is outside its supported bounds.`);
  }
  return value;
}

function transientHttpStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

function jsonContentType(value: string | readonly string[] | undefined): boolean {
  const contentType = Array.isArray(value) ? value[0] : value;
  return typeof contentType === "string" && /^application\/json(?:\s*;|$)/i.test(contentType);
}

function normalizeClientError(error: Error): BoundedHttpsClientFailure {
  if (error instanceof BoundedHttpsClientFailure) return error;
  if (error.name === "AbortError" || error.name === "TimeoutError") return new BoundedHttpsClientFailure("timeout");
  return new BoundedHttpsClientFailure("connection");
}
