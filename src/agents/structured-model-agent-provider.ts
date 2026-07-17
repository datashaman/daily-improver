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

export type ModelRequest = TestAgentRequest | BuilderRequest;

export interface ModelTransportInvocation {
  readonly stage: "test" | "build";
  readonly request: ModelRequest;
  readonly workingDirectory: string;
  readonly maximumCostUsd: number;
}

export interface ModelTransport {
  invoke(invocation: ModelTransportInvocation): Promise<unknown>;
}

export class StructuredModelAgentProvider implements AgentProvider {
  private readonly budgets: ModelCostBudgets;

  constructor(
    private readonly transport: ModelTransport,
    budgets: ModelCostBudgets,
    private readonly budgetState: ModelCostBudgetState = new InMemoryModelCostBudgetState(),
  ) {
    this.budgets = validateModelCostBudgets(budgets);
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
    const reservation = this.reserve("test", context);
    const response = await this.invoke(reservation, parseTestAgentResponse, {
      stage: "test", request, workingDirectory: context.repository,
    });
    assertAllowed(response.changedFiles, request.allowedTestPaths, "test-agent response");
    for (const test of response.tests) {
      if (!response.changedFiles.includes(test.path)) {
        throw new Error(`test-agent response test is not declared as changed: ${test.path}`);
      }
    }
    return {
      usage: response.usage,
      budgetDecision: response.budgetDecision,
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
    const reservation = this.reserve("build", context);
    const response = await this.invoke(reservation, parseBuilderResponse, {
      stage: "build", request, workingDirectory: context.repository,
    });
    assertAllowed(response.changedFiles, request.allowedFiles, "builder response");
    for (const file of response.changedFiles) {
      if (request.protectedFiles.some((pattern) => matches(file, pattern))) {
        throw new Error(`builder response declares a protected file: ${file}`);
      }
    }
    return {
      usage: response.usage,
      budgetDecision: response.budgetDecision,
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

  private async invoke<T extends { readonly usage: { readonly estimatedCostUsd: number } }>(
    reservation: ModelCostReservation,
    parser: (value: unknown) => T,
    invocation: Omit<ModelTransportInvocation, "maximumCostUsd">,
  ): Promise<T & { readonly budgetDecision: ReturnType<ModelCostBudgetState["settle"]> }> {
    try {
      const response = parser(await this.transport.invoke({
        ...invocation,
        maximumCostUsd: reservation.request.reservationUsd,
      }));
      const budgetDecision = this.budgetState.settle(reservation, response.usage.estimatedCostUsd);
      return { ...response, budgetDecision };
    } catch (error) {
      try {
        this.budgetState.consumeReservation(reservation);
      } catch {
        // The reservation was settled before an over-budget response was rejected.
      }
      throw error;
    }
  }
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
