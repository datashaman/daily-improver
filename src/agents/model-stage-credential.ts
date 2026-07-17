import type { ModelAgentStage } from "./model-cost-budget.js";

export const modelStageCredentialSchemaVersion = "model-stage-credential/v1" as const;
export const maximumModelStageCredentialLifetimeMs = 15 * 60 * 1_000;

export interface ModelStageCredentialRequest {
  readonly stage: ModelAgentStage;
  readonly scope: string;
}

export interface ModelStageCredential {
  readonly schemaVersion: typeof modelStageCredentialSchemaVersion;
  readonly stage: ModelAgentStage;
  readonly scope: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly secret: string;
}

export interface ModelStageCredentialSource {
  acquire(request: ModelStageCredentialRequest): Promise<ModelStageCredential | undefined>;
}

export interface ModelCredentialClock {
  nowMs(): number;
}

export interface ModelStageCredentialPolicy {
  readonly source: ModelStageCredentialSource;
  readonly clock?: ModelCredentialClock;
  readonly maximumLifetimeMs?: number;
}

export type ModelStageCredentialAcquisitionFailureClassification =
  | "transient"
  | "permanent"
  | "malformed-response"
  | "policy";

export class ModelStageCredentialAcquisitionFailure extends Error {
  override readonly name = "ModelStageCredentialAcquisitionFailure";

  constructor(
    readonly classification: ModelStageCredentialAcquisitionFailureClassification,
    message = "The model credential exchange failed.",
  ) {
    super(message);
  }
}

export class ModelStageCredentialError extends Error {
  override readonly name = "ModelStageCredentialError";
}

export const systemModelCredentialClock: ModelCredentialClock = {
  nowMs: () => Date.now(),
};

export const unavailableModelStageCredentialSource: ModelStageCredentialSource = {
  async acquire() {
    return undefined;
  },
};

export function validateModelStageCredential(
  value: unknown,
  request: ModelStageCredentialRequest,
  nowMs: number,
  maximumLifetimeMs = maximumModelStageCredentialLifetimeMs,
): ModelStageCredential {
  if (!isPlainRecord(value)) throw invalidCredential();
  assertExactKeys(value, ["schemaVersion", "stage", "scope", "issuedAtMs", "expiresAtMs", "secret"]);
  if (value.schemaVersion !== modelStageCredentialSchemaVersion) throw invalidCredential();
  if (value.stage !== request.stage || value.scope !== request.scope) throw invalidCredential();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new ModelStageCredentialError("Model credential clock is invalid.");
  if (!Number.isSafeInteger(maximumLifetimeMs) || maximumLifetimeMs < 1 || maximumLifetimeMs > maximumModelStageCredentialLifetimeMs) {
    throw new ModelStageCredentialError("Model credential maximum lifetime is invalid.");
  }
  if (typeof value.issuedAtMs !== "number" || typeof value.expiresAtMs !== "number") throw invalidCredential();
  if (!Number.isSafeInteger(value.issuedAtMs) || !Number.isSafeInteger(value.expiresAtMs)) throw invalidCredential();
  if (value.issuedAtMs < 0 || value.issuedAtMs > nowMs || value.expiresAtMs <= nowMs) throw invalidCredential();
  if (value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > maximumLifetimeMs) throw invalidCredential();
  if (typeof value.secret !== "string" || value.secret.length < 1 || value.secret.length > 8_192) throw invalidCredential();
  return value as unknown as ModelStageCredential;
}

function invalidCredential(): ModelStageCredentialError {
  return new ModelStageCredentialError("A valid short-lived model credential is unavailable for this stage and scope.");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw invalidCredential();
}
