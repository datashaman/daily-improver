import {
  HttpsStructuredEndpointTransport,
  NodeBoundedHttpsClient,
  type BoundedHttpsClient,
  type TrustedModelEndpointResolver,
} from "./https-structured-endpoint-transport.js";
import {
  InMemoryModelCostBudgetState,
  validateModelCostBudgets,
  type ModelCostBudgets,
  type ModelCostBudgetState,
} from "./model-cost-budget.js";
import {
  systemModelCredentialClock,
  type ModelCredentialClock,
} from "./model-stage-credential.js";
import {
  systemModelRetryTiming,
  validateModelRetryPolicy,
  type ModelRetryPolicy,
  type ModelRetryTiming,
} from "./model-request-retry.js";
import { validateModelEndpointPolicy, type ModelEndpointPolicy } from "./model-endpoint.js";
import { validateModelRoutingPolicy, type ModelRoutingPolicy } from "./model-routing.js";
import { StructuredModelAgentProvider } from "./structured-model-agent-provider.js";
import {
  TrustedRunnerModelStageCredentialSource,
  type TrustedModelCredentialExchangeResolver,
  type TrustedRunnerIdentitySource,
} from "./trusted-runner-model-stage-credential-source.js";

export const trustedRunnerStructuredProviderConfigurationSchemaVersion =
  "trusted-runner-structured-provider-configuration/v1" as const;

export interface TrustedRunnerStructuredProviderConfiguration {
  readonly schemaVersion: typeof trustedRunnerStructuredProviderConfigurationSchemaVersion;
  readonly budgets: ModelCostBudgets;
  readonly retryPolicy: ModelRetryPolicy;
  readonly routingPolicy: ModelRoutingPolicy;
  readonly endpointPolicy: ModelEndpointPolicy;
}

export interface TrustedRunnerStructuredProviderInputs {
  readonly endpointResolver: TrustedModelEndpointResolver;
  readonly identitySource: TrustedRunnerIdentitySource;
  readonly credentialExchangeResolver: TrustedModelCredentialExchangeResolver;
  readonly httpsClient?: BoundedHttpsClient;
  readonly clock?: ModelCredentialClock;
  readonly budgetState?: ModelCostBudgetState;
  readonly retryTiming?: ModelRetryTiming;
}

/**
 * Production composition boundary for a customer-controlled runner.
 *
 * None of these inputs are loaded from the target repository. The runner must
 * own the versioned policy and every injected resolver/source passed here.
 */
export function createTrustedRunnerStructuredProvider(
  configurationValue: unknown,
  inputs: TrustedRunnerStructuredProviderInputs,
): StructuredModelAgentProvider {
  const configuration = parseConfiguration(configurationValue);
  validateInputs(inputs);
  const client = inputs.httpsClient ?? new NodeBoundedHttpsClient();
  const clock = inputs.clock ?? systemModelCredentialClock;
  const credentials = new TrustedRunnerModelStageCredentialSource(
    inputs.identitySource,
    inputs.credentialExchangeResolver,
    client,
    clock,
  );
  const transport = new HttpsStructuredEndpointTransport(inputs.endpointResolver, client);
  return new StructuredModelAgentProvider(
    transport,
    configuration.budgets,
    { source: credentials, clock },
    configuration.routingPolicy,
    configuration.endpointPolicy,
    inputs.budgetState ?? new InMemoryModelCostBudgetState(),
    configuration.retryPolicy,
    inputs.retryTiming ?? systemModelRetryTiming,
  );
}

function parseConfiguration(value: unknown): TrustedRunnerStructuredProviderConfiguration {
  const input = exactRecord(value, [
    "schemaVersion",
    "budgets",
    "retryPolicy",
    "routingPolicy",
    "endpointPolicy",
  ], "trusted runner structured provider configuration");
  if (input.schemaVersion !== trustedRunnerStructuredProviderConfigurationSchemaVersion) {
    throw new Error(
      `trusted runner structured provider configuration schemaVersion must equal ${trustedRunnerStructuredProviderConfigurationSchemaVersion}.`,
    );
  }
  const budgets = parseBudgets(input.budgets);
  const retryPolicy = parseRetryPolicy(input.retryPolicy);
  const routingPolicy = validateModelRoutingPolicy(input.routingPolicy as ModelRoutingPolicy);
  const endpointPolicy = validateModelEndpointPolicy(input.endpointPolicy as ModelEndpointPolicy, routingPolicy);
  return {
    schemaVersion: trustedRunnerStructuredProviderConfigurationSchemaVersion,
    budgets,
    retryPolicy,
    routingPolicy,
    endpointPolicy,
  };
}

function parseBudgets(value: unknown): ModelCostBudgets {
  const budgets = exactRecord(value, ["dailyLimitUsd", "stages"], "trusted runner model budgets");
  const stages = exactRecord(budgets.stages, ["test", "build"], "trusted runner model budget stages");
  const test = exactRecord(stages.test, ["limitUsd", "reservationUsd"], "trusted runner test budget");
  const build = exactRecord(stages.build, ["limitUsd", "reservationUsd"], "trusted runner build budget");
  return validateModelCostBudgets({
    dailyLimitUsd: budgets.dailyLimitUsd as number,
    stages: {
      test: { limitUsd: test.limitUsd as number, reservationUsd: test.reservationUsd as number },
      build: { limitUsd: build.limitUsd as number, reservationUsd: build.reservationUsd as number },
    },
  });
}

function parseRetryPolicy(value: unknown): ModelRetryPolicy {
  const policy = exactRecord(value, ["maxAttempts", "delaysMs"], "trusted runner model retry policy");
  if (!Array.isArray(policy.delaysMs)) {
    throw new Error("trusted runner model retry policy delaysMs must be an array.");
  }
  return validateModelRetryPolicy({
    maxAttempts: policy.maxAttempts as number,
    delaysMs: policy.delaysMs as readonly number[],
  });
}

function validateInputs(inputs: TrustedRunnerStructuredProviderInputs): void {
  if (typeof inputs !== "object" || inputs === null
    || typeof inputs.endpointResolver?.resolve !== "function"
    || typeof inputs.identitySource?.acquire !== "function"
    || typeof inputs.credentialExchangeResolver?.resolve !== "function") {
    throw new Error("Trusted runner endpoint, identity, and credential exchange inputs are required.");
  }
  if (inputs.httpsClient !== undefined && typeof inputs.httpsClient.send !== "function") {
    throw new Error("The trusted runner HTTPS client is invalid.");
  }
  if (inputs.clock !== undefined && typeof inputs.clock.nowMs !== "function") {
    throw new Error("The trusted runner credential clock is invalid.");
  }
  if (inputs.budgetState !== undefined
    && (typeof inputs.budgetState.reserve !== "function"
      || typeof inputs.budgetState.settle !== "function"
      || typeof inputs.budgetState.consumeReservation !== "function")) {
    throw new Error("The trusted runner budget state is invalid.");
  }
  if (inputs.retryTiming !== undefined && typeof inputs.retryTiming.wait !== "function") {
    throw new Error("The trusted runner retry timing is invalid.");
  }
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${keys.join(", ")}.`);
  }
  return record;
}
