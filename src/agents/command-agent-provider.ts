import type { AgentContext, AgentProvider } from "./agent-provider.js";
import { CommandRunner } from "../infra/command-runner.js";

export interface CommandAgentOptions {
  readonly testCommand: string;
  readonly buildCommand: string;
}

export class CommandAgentProvider implements AgentProvider {
  constructor(
    private readonly options: CommandAgentOptions,
    private readonly runner = new CommandRunner(),
  ) {}

  async generateTests(context: AgentContext): Promise<void> {
    await this.execute("test", this.options.testCommand, context);
  }

  async build(context: AgentContext): Promise<void> {
    await this.execute("build", this.options.buildCommand, context);
  }

  private async execute(stage: "test" | "build", command: string, context: AgentContext): Promise<void> {
    const result = await this.runner.run(
      ["/bin/sh", "-lc", command],
      context.repository,
      20 * 60_000,
      {
        DAILY_IMPROVER_AGENT_STAGE: stage,
        DAILY_IMPROVER_SPEC_PATH: context.specPath,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`${stage} agent failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }
}
