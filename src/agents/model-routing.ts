import type { ModelAgentStage } from "./model-cost-budget.js";
import type { BuilderRequest, TestAgentRequest } from "./structured-agent-contracts.js";

type ModelRequest = TestAgentRequest | BuilderRequest;

export const modelRoutingPolicySchemaVersion = "model-routing-policy/v1" as const;
export const taskComplexityDecisionSchemaVersion = "task-complexity-decision/v1" as const;

export const taskComplexityLevels = ["lower", "higher"] as const;
export type TaskComplexityLevel = (typeof taskComplexityLevels)[number];

export interface ModelRoute {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
}

export interface ModelRoutingPolicy {
  readonly schemaVersion: typeof modelRoutingPolicySchemaVersion;
  readonly routes: Readonly<Record<TaskComplexityLevel, Readonly<Record<ModelAgentStage, ModelRoute>>>>;
}

export interface TaskComplexityDecision {
  readonly schemaVersion: typeof taskComplexityDecisionSchemaVersion;
  readonly stage: ModelAgentStage;
  readonly complexity: TaskComplexityLevel;
  readonly score: number;
  readonly inputs: {
    readonly maxFiles: number;
    readonly maxChangedLines: number;
    readonly acceptanceCriteria: number;
    readonly propertyInvariants: number;
    readonly evidenceItems: number;
  };
  readonly route: ModelRoute;
}

export function validateModelRoutingPolicy(value: ModelRoutingPolicy): ModelRoutingPolicy {
  const input = exactRecord(value, ["schemaVersion", "routes"], "model routing policy");
  if (input.schemaVersion !== modelRoutingPolicySchemaVersion) {
    throw new Error(`model routing policy schemaVersion must equal ${modelRoutingPolicySchemaVersion}.`);
  }
  const routes = exactRecord(input.routes, taskComplexityLevels, "model routing policy routes");
  const parsed = {
    schemaVersion: modelRoutingPolicySchemaVersion,
    routes: {
      lower: parseStageRoutes(routes.lower, "lower"),
      higher: parseStageRoutes(routes.higher, "higher"),
    },
  } as const;
  const routeIds = taskComplexityLevels.flatMap((level) => [
    parsed.routes[level].test.id,
    parsed.routes[level].build.id,
  ]);
  if (new Set(routeIds).size !== routeIds.length) {
    throw new Error("model routing policy route ids must be unique.");
  }
  for (const stage of ["test", "build"] as const) {
    const lower = parsed.routes.lower[stage];
    const higher = parsed.routes.higher[stage];
    if (lower.provider === higher.provider && lower.model === higher.model) {
      throw new Error(`model routing policy ${stage} routes must select distinct lower and higher model targets.`);
    }
  }
  return parsed;
}

export function selectModelRoute(request: ModelRequest, policy: ModelRoutingPolicy): TaskComplexityDecision {
  const validatedPolicy = validateModelRoutingPolicy(policy);
  const inputs = {
    maxFiles: request.task.limits.maxFiles,
    maxChangedLines: request.task.limits.maxChangedLines,
    acceptanceCriteria: request.task.acceptanceCriteria.length,
    propertyInvariants: request.task.propertyInvariants.length,
    evidenceItems: request.task.evidence.length,
  } as const;
  const score =
    (inputs.maxFiles > 2 ? 2 : 0)
    + (inputs.maxChangedLines > 100 ? 2 : 0)
    + (inputs.acceptanceCriteria > 4 ? 1 : 0)
    + (inputs.propertyInvariants > 2 ? 1 : 0)
    + (inputs.evidenceItems > 4 ? 1 : 0);
  const complexity: TaskComplexityLevel = score >= 2 ? "higher" : "lower";
  return {
    schemaVersion: taskComplexityDecisionSchemaVersion,
    stage: request.stage,
    complexity,
    score,
    inputs,
    route: validatedPolicy.routes[complexity][request.stage],
  };
}

function parseStageRoutes(value: unknown, level: TaskComplexityLevel): Readonly<Record<ModelAgentStage, ModelRoute>> {
  const routes = exactRecord(value, ["test", "build"], `model routing policy ${level} routes`);
  return {
    test: parseRoute(routes.test, `${level} test`),
    build: parseRoute(routes.build, `${level} build`),
  };
}

function parseRoute(value: unknown, name: string): ModelRoute {
  const route = exactRecord(value, ["id", "provider", "model"], `model routing policy ${name} route`);
  return {
    id: identifier(route.id, `model routing policy ${name} route id`),
    provider: identifier(route.provider, `model routing policy ${name} provider`),
    model: identifier(route.model, `model routing policy ${name} model`),
  };
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw new Error(`${name} must be a bounded model identifier.`);
  }
  return value;
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
