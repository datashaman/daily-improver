import { createHash } from "node:crypto";

export const requiredVerifierUnavailableSchemaVersion = "required-verifier-unavailable/v1" as const;

export const requiredVerifierResultSchemas = {
  "ordinary-command": "verification-check-binding/v1",
  "static-analysis": "static-analysis-result/v1",
  "static-analysis-ignored-findings": "static-analysis-ignored-findings-result/v1",
  "broad-exception-swallowing": "broad-exception-swallowing-result/v1",
  "validation-boundaries": "validation-boundary-result/v1",
  "test-strength": "test-strength-result/v1",
  "protected-repository-changes": "protected-repository-change-result/v1",
  "secret-scan": "secret-scan-result/v1",
  "public-api-surface": "public-api-surface-result/v1",
  "targeted-mutation": "targeted-mutation-result/v2",
  "objective-verification": "objective-verification-result/v1",
} as const;

export type RequiredVerifierContract = keyof typeof requiredVerifierResultSchemas;
export type RequiredVerifierUnavailableBoundary = "command" | "adapter" | "tool";
export type RequiredVerifierUnavailableReason = "executable-unavailable" | "capability-unavailable" | "tool-unavailable";

const boundaryReasons: Readonly<Record<RequiredVerifierUnavailableBoundary, RequiredVerifierUnavailableReason>> = {
  command: "executable-unavailable",
  adapter: "capability-unavailable",
  tool: "tool-unavailable",
};

export interface RequiredVerifierUnavailableDecision {
  readonly schemaVersion: typeof requiredVerifierUnavailableSchemaVersion;
  readonly verifierContract: RequiredVerifierContract;
  readonly requiredResultSchemaVersion: (typeof requiredVerifierResultSchemas)[RequiredVerifierContract];
  readonly boundary: RequiredVerifierUnavailableBoundary;
  readonly reason: RequiredVerifierUnavailableReason;
  readonly selectionSha256: string;
  readonly outcome: "unavailable";
}

export class RequiredVerifierUnavailableError extends Error {
  readonly decision: RequiredVerifierUnavailableDecision;

  constructor(decision: unknown) {
    const validated = assertRequiredVerifierUnavailableDecision(decision);
    super(`Required verifier ${validated.verifierContract} is unavailable at its ${validated.boundary} boundary.`);
    this.name = "RequiredVerifierUnavailableError";
    this.decision = validated;
  }
}

export function createRequiredVerifierUnavailableDecision(
  verifierContract: RequiredVerifierContract,
  boundary: RequiredVerifierUnavailableBoundary,
  reason: RequiredVerifierUnavailableReason,
  selection: string,
): RequiredVerifierUnavailableDecision {
  if (typeof selection !== "string" || !selection || selection.length > 16_384 || selection.includes("\0")) {
    throw new Error("Required-verifier selection identity is malformed or excessive.");
  }
  return assertRequiredVerifierUnavailableDecision({
    schemaVersion: requiredVerifierUnavailableSchemaVersion,
    verifierContract,
    requiredResultSchemaVersion: requiredVerifierResultSchemas[verifierContract],
    boundary,
    reason,
    selectionSha256: createHash("sha256").update(JSON.stringify([verifierContract, selection])).digest("hex"),
    outcome: "unavailable",
  });
}

export function assertRequiredVerifierUnavailableDecision(value: unknown): RequiredVerifierUnavailableDecision {
  const decision = exactRecord(value);
  if (decision.schemaVersion !== requiredVerifierUnavailableSchemaVersion || decision.outcome !== "unavailable") {
    throw new Error("Required-verifier unavailability decision uses an unsupported schema or outcome.");
  }
  if (typeof decision.verifierContract !== "string" || !(decision.verifierContract in requiredVerifierResultSchemas)) {
    throw new Error("Required-verifier unavailability contract is unsupported.");
  }
  const verifierContract = decision.verifierContract as RequiredVerifierContract;
  if (decision.requiredResultSchemaVersion !== requiredVerifierResultSchemas[verifierContract]) {
    throw new Error("Required-verifier unavailability decision identifies an inconsistent result contract.");
  }
  if (decision.boundary !== "command" && decision.boundary !== "adapter" && decision.boundary !== "tool") {
    throw new Error("Required-verifier unavailability boundary is unsupported.");
  }
  if (decision.reason !== "executable-unavailable" && decision.reason !== "capability-unavailable" && decision.reason !== "tool-unavailable") {
    throw new Error("Required-verifier unavailability reason is unsupported.");
  }
  if (decision.reason !== boundaryReasons[decision.boundary]) {
    throw new Error("Required-verifier unavailability boundary and reason are inconsistent.");
  }
  if (typeof decision.selectionSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(decision.selectionSha256)) {
    throw new Error("Required-verifier unavailability selection identity is malformed.");
  }
  return Object.freeze({
    schemaVersion: requiredVerifierUnavailableSchemaVersion,
    verifierContract,
    requiredResultSchemaVersion: requiredVerifierResultSchemas[verifierContract],
    boundary: decision.boundary,
    reason: decision.reason,
    selectionSha256: decision.selectionSha256,
    outcome: "unavailable",
  });
}

export function throwRequiredVerifierUnavailable(
  verifierContract: RequiredVerifierContract,
  boundary: RequiredVerifierUnavailableBoundary,
  reason: RequiredVerifierUnavailableReason,
  selection: string,
): never {
  throw new RequiredVerifierUnavailableError(
    createRequiredVerifierUnavailableDecision(verifierContract, boundary, reason, selection),
  );
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Required-verifier unavailability decision is malformed.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const expected = [
    "boundary", "outcome", "reason", "requiredResultSchemaVersion", "schemaVersion", "selectionSha256", "verifierContract",
  ];
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Required-verifier unavailability decision is extended or incomplete.");
  }
  return record;
}
