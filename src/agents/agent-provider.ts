import type { ImprovementSpec } from "../domain/model.js";

export interface AgentContext {
  readonly repository: string;
  readonly spec: ImprovementSpec;
  readonly specPath: string;
}

export interface AgentProvider {
  generateTests(context: AgentContext): Promise<void>;
  build(context: AgentContext): Promise<void>;
}
