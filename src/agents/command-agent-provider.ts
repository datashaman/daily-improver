import type { AgentContext, AgentProvider } from "./agent-provider.js";
import { CommandRunner } from "../infra/command-runner.js";
import { isAbsolute, relative } from "node:path";
import {
  PlatformBuilderNetworkIsolation,
  validateBuilderNetworkPolicy,
} from "./builder-network-isolation.js";
import type { BuilderNetworkIsolation, BuilderNetworkPolicy } from "./builder-network-isolation.js";
import {
  PackageManagerBuilderDependencyIsolation,
  validateBuilderDependencyInstallationPolicy,
} from "./builder-dependency-installation.js";
import type {
  BuilderDependencyInstallationIsolation,
  BuilderDependencyInstallationPolicy,
} from "./builder-dependency-installation.js";
import {
  PlatformBuilderResourceIsolation,
  validateBuilderResourceLimits,
} from "./builder-resource-limits.js";
import type {
  BuilderCommandExecutor,
  BuilderResourceIsolation,
  BuilderResourceLimits,
} from "./builder-resource-limits.js";
import { RepositoryPublicationBuilderIsolation } from "./builder-repository-publication.js";
import type { BuilderRepositoryPublicationIsolation } from "./builder-repository-publication.js";

const maximumPathEnvironmentLength = 8_192;
const maximumSpecificationPathLength = 4_096;

export interface CommandAgentRuntimeEnvironment {
  readonly PATH: string;
}

export interface CommandAgentOptions {
  readonly testCommand: string;
  readonly buildCommand: string;
  readonly runtimeEnvironment: CommandAgentRuntimeEnvironment;
  readonly builderNetworkPolicy?: BuilderNetworkPolicy;
  readonly builderDependencyInstallationPolicy?: BuilderDependencyInstallationPolicy;
  readonly builderResourceLimits: BuilderResourceLimits;
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
    private readonly builderNetworkIsolation: BuilderNetworkIsolation = new PlatformBuilderNetworkIsolation(),
    private readonly builderDependencyInstallationIsolation: BuilderDependencyInstallationIsolation = new PackageManagerBuilderDependencyIsolation(),
    private readonly builderRepositoryPublicationIsolation: BuilderRepositoryPublicationIsolation = new RepositoryPublicationBuilderIsolation(),
    private readonly builderResourceIsolation: BuilderResourceIsolation = new PlatformBuilderResourceIsolation(),
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
    const agentEnvironment = {
      ...runtimeEnvironment,
      DAILY_IMPROVER_AGENT_STAGE: stage,
      DAILY_IMPROVER_SPEC_PATH: context.specPath,
    };
    const commandArguments = ["/bin/sh", "-c", command];
    let execute: BuilderCommandExecutor = async (nextCommand, cwd, limits, environment) =>
      await this.runner.runBoundedWithExactEnvironment(nextCommand, cwd, limits, environment);
    if (stage === "build" && validateBuilderNetworkPolicy(this.options.builderNetworkPolicy).outbound === "deny") {
      execute = async (nextCommand, cwd, limits, environment) =>
        await this.builderNetworkIsolation.run(nextCommand, cwd, limits, environment);
    }
    let result;
    if (stage === "build") {
      const resourceLimits = validateBuilderResourceLimits(this.options.builderResourceLimits);
      const executeWithResources: BuilderCommandExecutor = async (nextCommand, cwd, _limits, environment) =>
        await this.builderResourceIsolation.run(nextCommand, cwd, resourceLimits, environment, execute);
      const executeWithoutPublication: BuilderCommandExecutor = async (nextCommand, cwd, limits, environment) =>
        await this.builderRepositoryPublicationIsolation.run(nextCommand, cwd, limits, environment, executeWithResources);
      result = validateBuilderDependencyInstallationPolicy(this.options.builderDependencyInstallationPolicy).installation === "deny"
        ? await this.builderDependencyInstallationIsolation.run(
          commandArguments, context.repository, resourceLimits, agentEnvironment, executeWithoutPublication,
        )
        : await executeWithoutPublication(commandArguments, context.repository, resourceLimits, agentEnvironment);
    } else {
      result = await this.runner.runWithExactEnvironment(commandArguments, context.repository, 20 * 60_000, agentEnvironment);
    }
    if (result.resourceExhausted) {
      throw new Error(`build agent exhausted its ${result.resourceExhausted} resource limit.`);
    }
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
