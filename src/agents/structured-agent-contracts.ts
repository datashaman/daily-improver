export const testAgentRequestSchemaVersion = "test-agent-request/v1" as const;
export const testAgentResponseSchemaVersion = "test-agent-response/v1" as const;
export const builderRequestSchemaVersion = "builder-request/v1" as const;
export const builderResponseSchemaVersion = "builder-response/v1" as const;

const limits = {
  string: 4_096,
  identifier: 160,
  path: 1_024,
  commandArgument: 1_024,
  collection: 64,
  commandArguments: 32,
  frameworks: 16,
  tokens: 10_000_000,
  latencyMs: 3_600_000,
  costUsd: 10_000,
  changedLines: 10_000,
  files: 1_000,
} as const;

export interface AgentRepositoryContext {
  readonly language: string;
  readonly frameworks: readonly string[];
}

export interface AgentTask {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly currentBehaviour: string;
  readonly proposedImprovement: string;
  readonly behavioursToPreserve: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly propertyInvariants: readonly string[];
  readonly exclusions: readonly string[];
  readonly evidence: readonly string[];
  readonly limits: {
    readonly maxFiles: number;
    readonly maxChangedLines: number;
    readonly maxCostUsd: number;
  };
}

export interface AgentCommand {
  readonly purpose: string;
  readonly argv: readonly string[];
}

export interface TestAgentRequest {
  readonly schemaVersion: typeof testAgentRequestSchemaVersion;
  readonly stage: "test";
  readonly task: AgentTask;
  readonly repository: AgentRepositoryContext;
  readonly allowedTestPaths: readonly string[];
  readonly commands: readonly AgentCommand[];
  readonly conventions: readonly string[];
}

export interface BuilderRequest {
  readonly schemaVersion: typeof builderRequestSchemaVersion;
  readonly stage: "build";
  readonly task: AgentTask;
  readonly repository: AgentRepositoryContext;
  readonly allowedFiles: readonly string[];
  readonly protectedFiles: readonly string[];
  readonly commands: readonly AgentCommand[];
  readonly conventions: readonly string[];
}

export interface AgentUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly estimatedCostUsd: number;
}

export interface GeneratedTest {
  readonly path: string;
  readonly purpose: string;
  readonly invariants: readonly string[];
}

export interface TestAgentResponse {
  readonly schemaVersion: typeof testAgentResponseSchemaVersion;
  readonly status: "completed";
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly tests: readonly GeneratedTest[];
  readonly usage: AgentUsage;
}

export interface BuilderResponse {
  readonly schemaVersion: typeof builderResponseSchemaVersion;
  readonly status: "completed";
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly implementationNotes: readonly string[];
  readonly usage: AgentUsage;
}

export function parseTestAgentRequest(value: unknown): TestAgentRequest {
  const input = exactRecord(value, ["schemaVersion", "stage", "task", "repository", "allowedTestPaths", "commands", "conventions"], "test-agent request");
  literal(input.schemaVersion, testAgentRequestSchemaVersion, "test-agent request schemaVersion");
  literal(input.stage, "test", "test-agent request stage");
  return {
    schemaVersion: testAgentRequestSchemaVersion,
    stage: "test",
    task: parseTask(input.task),
    repository: parseRepository(input.repository),
    allowedTestPaths: paths(input.allowedTestPaths, "test-agent allowedTestPaths", true),
    commands: commands(input.commands, "test-agent commands"),
    conventions: strings(input.conventions, "test-agent conventions"),
  };
}

export function parseBuilderRequest(value: unknown): BuilderRequest {
  const input = exactRecord(value, ["schemaVersion", "stage", "task", "repository", "allowedFiles", "protectedFiles", "commands", "conventions"], "builder request");
  literal(input.schemaVersion, builderRequestSchemaVersion, "builder request schemaVersion");
  literal(input.stage, "build", "builder request stage");
  return {
    schemaVersion: builderRequestSchemaVersion,
    stage: "build",
    task: parseTask(input.task),
    repository: parseRepository(input.repository),
    allowedFiles: paths(input.allowedFiles, "builder allowedFiles", true),
    protectedFiles: paths(input.protectedFiles, "builder protectedFiles", true),
    commands: commands(input.commands, "builder commands"),
    conventions: strings(input.conventions, "builder conventions"),
  };
}

export function parseTestAgentResponse(value: unknown): TestAgentResponse {
  const input = exactRecord(value, ["schemaVersion", "status", "summary", "changedFiles", "tests", "usage"], "test-agent response");
  literal(input.schemaVersion, testAgentResponseSchemaVersion, "test-agent response schemaVersion");
  literal(input.status, "completed", "test-agent response status");
  const testValues = collection(input.tests, "test-agent tests", true);
  return {
    schemaVersion: testAgentResponseSchemaVersion,
    status: "completed",
    summary: string(input.summary, "test-agent response summary"),
    changedFiles: paths(input.changedFiles, "test-agent changedFiles", true),
    tests: testValues.map((test, index) => parseGeneratedTest(test, index)),
    usage: parseUsage(input.usage, "test-agent response usage"),
  };
}

export function parseBuilderResponse(value: unknown): BuilderResponse {
  const input = exactRecord(value, ["schemaVersion", "status", "summary", "changedFiles", "implementationNotes", "usage"], "builder response");
  literal(input.schemaVersion, builderResponseSchemaVersion, "builder response schemaVersion");
  literal(input.status, "completed", "builder response status");
  return {
    schemaVersion: builderResponseSchemaVersion,
    status: "completed",
    summary: string(input.summary, "builder response summary"),
    changedFiles: paths(input.changedFiles, "builder changedFiles", true),
    implementationNotes: strings(input.implementationNotes, "builder implementationNotes"),
    usage: parseUsage(input.usage, "builder response usage"),
  };
}

function parseTask(value: unknown): AgentTask {
  const task = exactRecord(value, ["id", "title", "objective", "currentBehaviour", "proposedImprovement", "behavioursToPreserve", "acceptanceCriteria", "propertyInvariants", "exclusions", "evidence", "limits"], "agent task");
  const taskLimits = exactRecord(task.limits, ["maxFiles", "maxChangedLines", "maxCostUsd"], "agent task limits");
  return {
    id: string(task.id, "agent task id", limits.identifier),
    title: string(task.title, "agent task title"),
    objective: string(task.objective, "agent task objective"),
    currentBehaviour: string(task.currentBehaviour, "agent task currentBehaviour"),
    proposedImprovement: string(task.proposedImprovement, "agent task proposedImprovement"),
    behavioursToPreserve: strings(task.behavioursToPreserve, "agent task behavioursToPreserve"),
    acceptanceCriteria: strings(task.acceptanceCriteria, "agent task acceptanceCriteria", true),
    propertyInvariants: strings(task.propertyInvariants, "agent task propertyInvariants"),
    exclusions: strings(task.exclusions, "agent task exclusions"),
    evidence: strings(task.evidence, "agent task evidence", true),
    limits: {
      maxFiles: integer(taskLimits.maxFiles, "agent task maxFiles", 1, limits.files),
      maxChangedLines: integer(taskLimits.maxChangedLines, "agent task maxChangedLines", 1, limits.changedLines),
      maxCostUsd: finiteNumber(taskLimits.maxCostUsd, "agent task maxCostUsd", 0, limits.costUsd),
    },
  };
}

function parseRepository(value: unknown): AgentRepositoryContext {
  const repository = exactRecord(value, ["language", "frameworks"], "agent repository context");
  return {
    language: string(repository.language, "agent repository language", limits.identifier),
    frameworks: strings(repository.frameworks, "agent repository frameworks", false, limits.frameworks, limits.identifier),
  };
}

function parseGeneratedTest(value: unknown, index: number): GeneratedTest {
  const test = exactRecord(value, ["path", "purpose", "invariants"], `test-agent test ${index}`);
  return {
    path: path(test.path, `test-agent test ${index} path`),
    purpose: string(test.purpose, `test-agent test ${index} purpose`),
    invariants: strings(test.invariants, `test-agent test ${index} invariants`),
  };
}

function parseUsage(value: unknown, name: string): AgentUsage {
  const usage = exactRecord(value, ["provider", "model", "inputTokens", "outputTokens", "latencyMs", "estimatedCostUsd"], name);
  return {
    provider: string(usage.provider, `${name} provider`, limits.identifier),
    model: string(usage.model, `${name} model`, limits.identifier),
    inputTokens: integer(usage.inputTokens, `${name} inputTokens`, 0, limits.tokens),
    outputTokens: integer(usage.outputTokens, `${name} outputTokens`, 0, limits.tokens),
    latencyMs: integer(usage.latencyMs, `${name} latencyMs`, 0, limits.latencyMs),
    estimatedCostUsd: finiteNumber(usage.estimatedCostUsd, `${name} estimatedCostUsd`, 0, limits.costUsd),
  };
}

function commands(value: unknown, name: string): readonly AgentCommand[] {
  return collection(value, name, true).map((entry, index) => {
    const command = exactRecord(entry, ["purpose", "argv"], `${name} ${index}`);
    const argv = collection(command.argv, `${name} ${index} argv`, true, limits.commandArguments)
      .map((argument, argumentIndex) => argumentIndex === 0
        ? string(argument, `${name} ${index} argv ${argumentIndex}`, limits.commandArgument)
        : boundedString(argument, `${name} ${index} argv ${argumentIndex}`, limits.commandArgument));
    return { purpose: string(command.purpose, `${name} ${index} purpose`, limits.identifier), argv };
  });
}

function paths(value: unknown, name: string, nonEmpty = false): readonly string[] {
  return collection(value, name, nonEmpty).map((entry, index) => path(entry, `${name} ${index}`));
}

function path(value: unknown, name: string): string {
  const result = string(value, name, limits.path);
  if (result.startsWith("/") || result.includes("\\") || result.includes("\0")) throw new Error(`${name} must be a repository-relative POSIX path.`);
  const parts = result.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`${name} must not contain empty or traversal segments.`);
  return result;
}

function strings(value: unknown, name: string, nonEmpty = false, maximum: number = limits.collection, maximumLength: number = limits.string): readonly string[] {
  return collection(value, name, nonEmpty, maximum).map((entry, index) => string(entry, `${name} ${index}`, maximumLength));
}

function collection(value: unknown, name: string, nonEmpty = false, maximum: number = limits.collection): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum || (nonEmpty && value.length === 0)) {
    throw new Error(`${name} must contain ${nonEmpty ? "between 1 and" : "at most"} ${maximum} entries.`);
  }
  return value;
}

function string(value: unknown, name: string, maximum: number = limits.string): string {
  const result = boundedString(value, name, maximum);
  if (result.length === 0) throw new Error(`${name} must not be empty.`);
  return result;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) throw new Error(`${name} must be a string of at most ${maximum} characters.`);
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function literal<T extends string>(value: unknown, expected: T, name: string): asserts value is T {
  if (value !== expected) throw new Error(`${name} must equal ${expected}.`);
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${keys.join(", ")}.`);
  }
  return record;
}
