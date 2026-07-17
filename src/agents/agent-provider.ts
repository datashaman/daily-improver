import type { ImprovementSpec } from "../domain/model.js";
import type {
  AgentCommand,
  AgentRepositoryContext,
  AgentUsage,
} from "./structured-agent-contracts.js";
import type { ModelCostBudgetDecision } from "./model-cost-budget.js";
import type { ModelRequestAttempts } from "./model-request-retry.js";
import type { TaskComplexityDecision } from "./model-routing.js";

export interface AgentStageInputs {
  readonly repository: AgentRepositoryContext;
  readonly allowedTestPaths: readonly string[];
  readonly protectedFiles: readonly string[];
  readonly commands: readonly AgentCommand[];
  readonly testConventions: readonly string[];
  readonly builderConventions: readonly string[];
}

export interface AgentContext {
  readonly repository: string;
  readonly spec: ImprovementSpec;
  readonly specPath: string;
  readonly inputs: AgentStageInputs;
}

export interface TestAgentExecution {
  readonly usage: AgentUsage;
  readonly budgetDecision?: ModelCostBudgetDecision;
  readonly requestAttempts?: ModelRequestAttempts;
  readonly routingDecision?: TaskComplexityDecision;
  readonly rationale: {
    readonly summary: string;
    readonly changedFiles: readonly string[];
    readonly tests: readonly {
      readonly path: string;
      readonly purpose: string;
      readonly invariants: readonly string[];
    }[];
  };
}

export interface BuilderExecution {
  readonly usage: AgentUsage;
  readonly budgetDecision?: ModelCostBudgetDecision;
  readonly requestAttempts?: ModelRequestAttempts;
  readonly routingDecision?: TaskComplexityDecision;
  readonly rationale: {
    readonly summary: string;
    readonly changedFiles: readonly string[];
    readonly implementationNotes: readonly string[];
  };
}

export interface AgentProvider {
  generateTests(context: AgentContext): Promise<TestAgentExecution | void>;
  build(context: AgentContext): Promise<BuilderExecution | void>;
}
