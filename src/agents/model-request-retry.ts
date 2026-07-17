import type { ModelAgentStage, ModelCostBudgetDecision } from "./model-cost-budget.js";

export const modelRequestAttemptsSchemaVersion = "model-request-attempts/v1" as const;

export type ModelRequestFailureClassification =
  | "transient"
  | "permanent"
  | "malformed-response"
  | "policy"
  | "budget";

export type ModelRequestAttemptClassification = ModelRequestFailureClassification | "completed";

export interface ModelRequestAttempt {
  readonly attempt: number;
  readonly classification: ModelRequestAttemptClassification;
  readonly retryDelayMs?: number;
  readonly budgetDecision: ModelCostBudgetDecision;
}

export interface ModelRequestAttempts {
  readonly schemaVersion: typeof modelRequestAttemptsSchemaVersion;
  readonly maxAttempts: number;
  readonly attempts: readonly ModelRequestAttempt[];
}

export interface ModelRetryPolicy {
  readonly maxAttempts: number;
  readonly delaysMs: readonly number[];
}

export interface ModelRetryTiming {
  wait(delayMs: number): Promise<void>;
}

export const noModelRetries: ModelRetryPolicy = { maxAttempts: 1, delaysMs: [] };

export class ModelTransportFailure extends Error {
  override readonly name = "ModelTransportFailure";

  constructor(
    readonly classification: "transient" | "permanent",
    message = "The model transport request failed.",
  ) {
    super(message);
  }
}

export class StructuredModelRequestFailure extends Error {
  override readonly name = "StructuredModelRequestFailure";

  constructor(
    readonly stage: ModelAgentStage,
    readonly classification: ModelRequestFailureClassification,
    readonly requestAttempts: ModelRequestAttempts,
    message: string,
  ) {
    super(message);
  }
}

export function validateModelRetryPolicy(policy: ModelRetryPolicy): ModelRetryPolicy {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 5) {
    throw new Error("Model request maxAttempts must be an integer from 1 through 5.");
  }
  if (policy.delaysMs.length !== policy.maxAttempts - 1) {
    throw new Error("Model request delaysMs must contain one delay for every possible retry.");
  }
  for (const delayMs of policy.delaysMs) {
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
      throw new Error("Model request retry delays must be integer milliseconds from 0 through 60000.");
    }
  }
  return policy;
}

export const systemModelRetryTiming: ModelRetryTiming = {
  async wait(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  },
};
