import { createHash } from "node:crypto";
import { minimatch } from "minimatch";
import type {
  AgentContext,
  AgentProvider,
  BuilderExecution,
  TestAgentExecution,
} from "./agent-provider.js";
import {
  builderRequestSchemaVersion,
  parseBuilderRequest,
  parseBuilderResponse,
  parseTestAgentRequest,
  parseTestAgentResponse,
  testAgentRequestSchemaVersion,
  type AgentUsage,
  type BuilderRequest,
  type TestAgentRequest,
} from "./structured-agent-contracts.js";
import {
  InMemoryModelCostBudgetState,
  validateModelCostBudgets,
  type ModelAgentStage,
  type ModelCostBudgets,
  type ModelCostBudgetState,
  type ModelCostReservation,
} from "./model-cost-budget.js";
import {
  modelRequestAttemptsSchemaVersion,
  ModelTransportFailure,
  noModelRetries,
  StructuredModelRequestFailure,
  systemModelRetryTiming,
  validateModelRetryPolicy,
  type ModelRequestAttempt,
  type ModelRequestAttempts,
  type ModelRequestFailureClassification,
  type ModelRetryPolicy,
  type ModelRetryTiming,
} from "./model-request-retry.js";
import {
  maximumModelStageCredentialLifetimeMs,
  systemModelCredentialClock,
  validateModelStageCredential,
  type ModelStageCredentialPolicy,
} from "./model-stage-credential.js";
import {
  selectModelRoute,
  validateModelRoutingPolicy,
  type ModelRoute,
  type ModelRoutingPolicy,
  type TaskComplexityDecision,
} from "./model-routing.js";
import {
  endpointForRoute,
  validateModelEndpointPolicy,
  type ModelEndpointInvocation,
  type ModelEndpointPolicy,
} from "./model-endpoint.js";

export { ModelTransportFailure, StructuredModelRequestFailure } from "./model-request-retry.js";
export type {
  ModelRequestAttempt,
  ModelRequestAttempts,
  ModelRequestFailureClassification,
  ModelRetryPolicy,
  ModelRetryTiming,
} from "./model-request-retry.js";

export type ModelRequest = TestAgentRequest | BuilderRequest;

export interface ModelTransportInvocation {
  readonly stage: "test" | "build";
  readonly request: ModelRequest;
  readonly workingDirectory: string;
  readonly maximumCostUsd: number;
  readonly credential: string;
  readonly route: ModelRoute;
  readonly endpoint: ModelEndpointInvocation;
}

export interface ModelTransport {
  invoke(invocation: ModelTransportInvocation): Promise<unknown>;
}

export class StructuredModelAgentProvider implements AgentProvider {
  private readonly budgets: ModelCostBudgets;
  private readonly retryPolicy: ModelRetryPolicy;
  private readonly credentials: Required<ModelStageCredentialPolicy>;
  private readonly routingPolicy: ModelRoutingPolicy;
  private readonly endpointPolicy: ModelEndpointPolicy;
  private readonly credentialStages = new Map<string, ModelAgentStage>();

  constructor(
    private readonly transport: ModelTransport,
    budgets: ModelCostBudgets,
    credentialPolicy: ModelStageCredentialPolicy,
    routingPolicy: ModelRoutingPolicy,
    endpointPolicy: ModelEndpointPolicy,
    private readonly budgetState: ModelCostBudgetState = new InMemoryModelCostBudgetState(),
    retryPolicy: ModelRetryPolicy = noModelRetries,
    private readonly retryTiming: ModelRetryTiming = systemModelRetryTiming,
  ) {
    this.budgets = validateModelCostBudgets(budgets);
    this.routingPolicy = validateModelRoutingPolicy(routingPolicy);
    this.endpointPolicy = validateModelEndpointPolicy(endpointPolicy, this.routingPolicy);
    this.retryPolicy = validateModelRetryPolicy(retryPolicy);
    this.credentials = {
      source: credentialPolicy.source,
      clock: credentialPolicy.clock ?? systemModelCredentialClock,
      maximumLifetimeMs: credentialPolicy.maximumLifetimeMs ?? maximumModelStageCredentialLifetimeMs,
    };
  }

  async generateTests(context: AgentContext): Promise<TestAgentExecution> {
    const request = parseTestAgentRequest({
      schemaVersion: testAgentRequestSchemaVersion,
      stage: "test",
      task: task(context),
      repository: context.inputs.repository,
      allowedTestPaths: context.inputs.allowedTestPaths,
      commands: context.inputs.commands,
      conventions: context.inputs.testConventions,
    });
    const response = await this.invoke(context, parseTestAgentResponse, {
      stage: "test", request, workingDirectory: context.repository,
    }, (parsed) => {
      assertAllowed(parsed.changedFiles, request.allowedTestPaths, "test-agent response");
      for (const test of parsed.tests) {
        if (!parsed.changedFiles.includes(test.path)) {
          throw new Error(`test-agent response test is not declared as changed: ${test.path}`);
        }
      }
    });
    return {
      usage: response.usage,
      budgetDecision: response.budgetDecision,
      requestAttempts: response.requestAttempts,
      routingDecision: response.routingDecision,
      rationale: {
        summary: response.summary,
        changedFiles: response.changedFiles,
        tests: response.tests,
      },
    };
  }

  async build(context: AgentContext): Promise<BuilderExecution> {
    const request = parseBuilderRequest({
      schemaVersion: builderRequestSchemaVersion,
      stage: "build",
      task: task(context),
      repository: context.inputs.repository,
      allowedFiles: context.spec.allowedFiles,
      protectedFiles: context.inputs.protectedFiles,
      commands: context.inputs.commands,
      conventions: context.inputs.builderConventions,
    });
    const response = await this.invoke(context, parseBuilderResponse, {
      stage: "build", request, workingDirectory: context.repository,
    }, (parsed) => {
      assertAllowed(parsed.changedFiles, request.allowedFiles, "builder response");
      for (const file of parsed.changedFiles) {
        if (request.protectedFiles.some((pattern) => matches(file, pattern))) {
          throw new Error(`builder response declares a protected file: ${file}`);
        }
      }
    });
    return {
      usage: response.usage,
      budgetDecision: response.budgetDecision,
      requestAttempts: response.requestAttempts,
      routingDecision: response.routingDecision,
      rationale: {
        summary: response.summary,
        changedFiles: response.changedFiles,
        implementationNotes: response.implementationNotes,
      },
    };
  }

  private reserve(stage: ModelAgentStage, context: AgentContext): ModelCostReservation {
    const stageBudget = this.budgets.stages[stage];
    return this.budgetState.reserve({
      scope: `${context.repository}\0${context.spec.id}`,
      stage,
      stageLimitUsd: stageBudget.limitUsd,
      dailyLimitUsd: this.budgets.dailyLimitUsd,
      specificationLimitUsd: context.spec.constraints.maxCostUsd,
      reservationUsd: stageBudget.reservationUsd,
    });
  }

  private async invoke<T extends { readonly usage: AgentUsage }>(
    context: AgentContext,
    parser: (value: unknown) => T,
    invocation: Omit<ModelTransportInvocation, "maximumCostUsd" | "credential" | "route" | "endpoint">,
    validatePolicy: (response: T) => void,
  ): Promise<T & {
    readonly budgetDecision: ReturnType<ModelCostBudgetState["settle"]>;
    readonly requestAttempts: ModelRequestAttempts;
    readonly routingDecision: TaskComplexityDecision;
  }> {
    const routingDecision = selectModelRoute(invocation.request, this.routingPolicy);
    const endpoint = endpointForRoute(this.endpointPolicy, routingDecision.route, invocation.stage);
    const attempts: ModelRequestAttempt[] = [];
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt++) {
      let reservation: ModelCostReservation;
      try {
        reservation = this.reserve(invocation.stage, context);
      } catch (error) {
        throw this.failure(invocation.stage, "budget", attempts, message(error, "Model request budget is unavailable."));
      }

      let credential: string;
      try {
        credential = await this.acquireCredential(invocation.stage, context);
      } catch {
        attempts.push({
          attempt,
          classification: "policy",
          budgetDecision: this.budgetState.settle(reservation, 0),
        });
        throw this.failure(invocation.stage, "policy", attempts, "A valid model credential is unavailable for this stage and scope.");
      }

      let rawResponse: unknown;
      try {
        rawResponse = await this.transport.invoke({
          ...invocation,
          maximumCostUsd: reservation.request.reservationUsd,
          credential,
          route: routingDecision.route,
          endpoint,
        });
      } catch (error) {
        const classification = transportFailureClassification(error);
        const willRetry = classification === "transient" && attempt < this.retryPolicy.maxAttempts;
        const retryDelayMs = willRetry ? this.retryPolicy.delaysMs[attempt - 1] : undefined;
        attempts.push({
          attempt,
          classification,
          ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
          budgetDecision: this.budgetState.consumeReservation(reservation),
        });
        if (willRetry && retryDelayMs !== undefined) {
          await this.retryTiming.wait(retryDelayMs);
          continue;
        }
        throw this.failure(invocation.stage, classification, attempts, "The model transport request failed.");
      }

      let response: T;
      try {
        response = parser(rawResponse);
      } catch (error) {
        attempts.push({
          attempt,
          classification: "malformed-response",
          budgetDecision: this.budgetState.consumeReservation(reservation),
        });
        throw this.failure(invocation.stage, "malformed-response", attempts, message(error, "The model response is malformed."));
      }

      if (response.usage.estimatedCostUsd > reservation.request.reservationUsd) {
        attempts.push({
          attempt,
          classification: "budget",
          budgetDecision: this.budgetState.consumeReservation(reservation),
        });
        throw this.failure(invocation.stage, "budget", attempts, `${invocation.stage} stage actual model cost exceeds its reserved budget.`);
      }

      const budgetDecision = this.budgetState.settle(reservation, response.usage.estimatedCostUsd);
      try {
        if (response.usage.provider !== routingDecision.route.provider || response.usage.model !== routingDecision.route.model) {
          throw new Error(`${invocation.stage} stage response usage does not match its selected model route.`);
        }
        validatePolicy(response);
      } catch (error) {
        attempts.push({ attempt, classification: "policy", budgetDecision });
        throw this.failure(invocation.stage, "policy", attempts, message(error, "The model response violates stage policy."));
      }
      attempts.push({ attempt, classification: "completed", budgetDecision });
      return {
        ...response,
        budgetDecision,
        requestAttempts: this.attemptLog(attempts),
        routingDecision,
      };
    }
    throw new Error("Unreachable model retry state.");
  }

  private async acquireCredential(stage: ModelAgentStage, context: AgentContext): Promise<string> {
    const request = { stage, scope: credentialScope(context) } as const;
    const credential = validateModelStageCredential(
      await this.credentials.source.acquire(request),
      request,
      this.credentials.clock.nowMs(),
      this.credentials.maximumLifetimeMs,
    );
    const fingerprint = createHash("sha256").update(credential.secret).digest("hex");
    const priorStage = this.credentialStages.get(fingerprint);
    if (priorStage !== undefined && priorStage !== stage) {
      throw new Error("A model credential cannot be reused across stages.");
    }
    this.credentialStages.set(fingerprint, stage);
    return credential.secret;
  }

  private failure(
    stage: ModelAgentStage,
    classification: ModelRequestFailureClassification,
    attempts: readonly ModelRequestAttempt[],
    failureMessage: string,
  ): StructuredModelRequestFailure {
    return new StructuredModelRequestFailure(stage, classification, this.attemptLog(attempts), failureMessage);
  }

  private attemptLog(attempts: readonly ModelRequestAttempt[]): ModelRequestAttempts {
    return {
      schemaVersion: modelRequestAttemptsSchemaVersion,
      maxAttempts: this.retryPolicy.maxAttempts,
      attempts: [...attempts],
    };
  }
}

function credentialScope(context: AgentContext): string {
  return `sha256:${createHash("sha256").update(context.repository).update("\0").update(context.spec.id).digest("hex")}`;
}

function task(context: AgentContext) {
  const { spec } = context;
  return {
    id: spec.id,
    title: spec.title,
    objective: spec.objective,
    currentBehaviour: spec.currentBehaviour,
    proposedImprovement: spec.proposedImprovement,
    behavioursToPreserve: spec.behavioursToPreserve,
    acceptanceCriteria: spec.acceptanceCriteria,
    propertyInvariants: spec.propertyInvariants,
    exclusions: spec.exclusions,
    evidence: spec.evidence,
    limits: {
      maxFiles: spec.constraints.maxFiles,
      maxChangedLines: spec.constraints.maxChangedLines,
      maxCostUsd: spec.constraints.maxCostUsd,
    },
  };
}

function assertAllowed(files: readonly string[], allowlist: readonly string[], name: string): void {
  for (const file of files) {
    if (!allowlist.some((pattern) => matches(file, pattern))) {
      throw new Error(`${name} declares a file outside its path permissions: ${file}`);
    }
  }
}

function matches(file: string, pattern: string): boolean {
  return file === pattern || file.startsWith(`${pattern.replace(/\/$/, "")}/`) || minimatch(file, pattern);
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function transportFailureClassification(error: unknown): "transient" | "permanent" {
  if (!(error instanceof ModelTransportFailure)) return "permanent";
  return error.classification === "transient" ? "transient" : "permanent";
}
