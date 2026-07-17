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

export type ModelRequest = TestAgentRequest | BuilderRequest;

export interface ModelTransportInvocation {
  readonly stage: "test" | "build";
  readonly request: ModelRequest;
  readonly workingDirectory: string;
}

export interface ModelTransport {
  invoke(invocation: ModelTransportInvocation): Promise<unknown>;
}

export class StructuredModelAgentProvider implements AgentProvider {
  constructor(private readonly transport: ModelTransport) {}

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
    const response = parseTestAgentResponse(await this.transport.invoke({
      stage: "test",
      request,
      workingDirectory: context.repository,
    }));
    assertAllowed(response.changedFiles, request.allowedTestPaths, "test-agent response");
    for (const test of response.tests) {
      if (!response.changedFiles.includes(test.path)) {
        throw new Error(`test-agent response test is not declared as changed: ${test.path}`);
      }
    }
    return {
      usage: response.usage,
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
    const response = parseBuilderResponse(await this.transport.invoke({
      stage: "build",
      request,
      workingDirectory: context.repository,
    }));
    assertAllowed(response.changedFiles, request.allowedFiles, "builder response");
    for (const file of response.changedFiles) {
      if (request.protectedFiles.some((pattern) => matches(file, pattern))) {
        throw new Error(`builder response declares a protected file: ${file}`);
      }
    }
    return {
      usage: response.usage,
      rationale: {
        summary: response.summary,
        changedFiles: response.changedFiles,
        implementationNotes: response.implementationNotes,
      },
    };
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
