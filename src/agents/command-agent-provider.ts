import type { AgentContext, AgentProvider } from "./agent-provider.js";
import { CommandRunner } from "../infra/command-runner.js";
import { isAbsolute, relative } from "node:path";

const maximumPathEnvironmentLength = 8_192;
const maximumSpecificationPathLength = 4_096;

export interface CommandAgentRuntimeEnvironment {
  readonly PATH: string;
}

export interface CommandAgentOptions {
  readonly testCommand: string;
  readonly buildCommand: string;
  readonly runtimeEnvironment: CommandAgentRuntimeEnvironment;
}

export function createCommandAgentRuntimeEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): CommandAgentRuntimeEnvironment {
  const path = source.PATH;
  if (typeof path !== "string" || path.length === 0 || path.length > maximumPathEnvironmentLength
    || path.includes("\0") || path.split(":").some((entry) => entry.length === 0 || !isAbsolute(entry))) {
    throw new Error("A safe absolute PATH is required for command-backed agents.");
  }
  return Object.freeze({ PATH: path });
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
    const runtimeEnvironment = validateRuntimeEnvironment(this.options.runtimeEnvironment);
    assertSpecificationPath(context);
    const result = await this.runner.runWithExactEnvironment(
      ["/bin/sh", "-c", command],
      context.repository,
      20 * 60_000,
      {
        ...runtimeEnvironment,
        DAILY_IMPROVER_AGENT_STAGE: stage,
        DAILY_IMPROVER_SPEC_PATH: context.specPath,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`${stage} agent failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }
}

function validateRuntimeEnvironment(value: CommandAgentRuntimeEnvironment): CommandAgentRuntimeEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !("PATH" in value)) {
    throw new Error("Command-backed agents require an exact runner-owned runtime environment.");
  }
  return createCommandAgentRuntimeEnvironment({ PATH: value.PATH });
}

function assertSpecificationPath(context: AgentContext): void {
  if (!isAbsolute(context.repository) || !isAbsolute(context.specPath)
    || context.specPath.length > maximumSpecificationPathLength || context.specPath.includes("\0")) {
    throw new Error("Command-backed agents require an absolute bounded specification path.");
  }
  const specification = relative(context.repository, context.specPath);
  if (specification === "" || specification === ".." || specification.startsWith("../") || isAbsolute(specification)) {
    throw new Error("Command-backed agent specification path must remain inside the current repository.");
  }
}
