import type { ModelAgentStage } from "./model-cost-budget.js";
import type { ModelRoute, ModelRoutingPolicy } from "./model-routing.js";

export const modelEndpointPolicySchemaVersion = "model-endpoint-policy/v1" as const;
export const structuredModelEndpointProtocol = "structured-agent/v1" as const;
export const ephemeralModelEndpointAuthentication = "ephemeral-credential" as const;
export const maximumCostModelEndpointLimit = "maximum-cost-usd" as const;

export interface ModelEndpointCapabilities {
  readonly protocol: typeof structuredModelEndpointProtocol;
  readonly stages: readonly ModelAgentStage[];
  readonly authentication: typeof ephemeralModelEndpointAuthentication;
  readonly costLimit: typeof maximumCostModelEndpointLimit;
}

export interface ModelEndpoint {
  readonly id: string;
  readonly routeIds: readonly string[];
  readonly capabilities: ModelEndpointCapabilities;
}

export interface ModelEndpointPolicy {
  readonly schemaVersion: typeof modelEndpointPolicySchemaVersion;
  readonly endpoints: readonly ModelEndpoint[];
}

export interface ModelEndpointInvocation {
  readonly id: string;
  readonly capabilities: ModelEndpointCapabilities;
}

export function validateModelEndpointPolicy(
  value: ModelEndpointPolicy,
  routingPolicy: ModelRoutingPolicy,
): ModelEndpointPolicy {
  const input = exactRecord(value, ["schemaVersion", "endpoints"], "model endpoint policy");
  if (input.schemaVersion !== modelEndpointPolicySchemaVersion) {
    throw new Error(`model endpoint policy schemaVersion must equal ${modelEndpointPolicySchemaVersion}.`);
  }
  if (!Array.isArray(input.endpoints) || input.endpoints.length < 1 || input.endpoints.length > 8) {
    throw new Error("model endpoint policy endpoints must contain between one and eight entries.");
  }
  const endpoints = input.endpoints.map((endpoint, index) => parseEndpoint(endpoint, index));
  if (new Set(endpoints.map(({ id }) => id)).size !== endpoints.length) {
    throw new Error("model endpoint policy endpoint ids must be unique.");
  }

  const routes = routingEntries(routingPolicy);
  const expectedRouteIds = new Set(routes.map(({ route }) => route.id));
  const configuredRouteIds = endpoints.flatMap(({ routeIds }) => routeIds);
  if (new Set(configuredRouteIds).size !== configuredRouteIds.length) {
    throw new Error("model endpoint policy route ids must be assigned exactly once.");
  }
  if (configuredRouteIds.length !== expectedRouteIds.size || configuredRouteIds.some((id) => !expectedRouteIds.has(id))) {
    throw new Error("model endpoint policy must assign every configured model route exactly once.");
  }
  for (const { stage, route } of routes) {
    const endpoint = endpoints.find(({ routeIds }) => routeIds.includes(route.id));
    if (endpoint === undefined || !endpoint.capabilities.stages.includes(stage)) {
      throw new Error(`model endpoint policy route ${route.id} is incompatible with its ${stage} stage.`);
    }
  }
  return { schemaVersion: modelEndpointPolicySchemaVersion, endpoints };
}

export function endpointForRoute(
  policy: ModelEndpointPolicy,
  route: ModelRoute,
  stage: ModelAgentStage,
): ModelEndpointInvocation {
  const endpoint = policy.endpoints.find(({ routeIds }) => routeIds.includes(route.id));
  if (endpoint === undefined || !endpoint.capabilities.stages.includes(stage)) {
    throw new Error(`No compatible model endpoint is configured for route ${route.id}.`);
  }
  return { id: endpoint.id, capabilities: endpoint.capabilities };
}

function parseEndpoint(value: unknown, index: number): ModelEndpoint {
  const endpoint = exactRecord(value, ["id", "routeIds", "capabilities"], `model endpoint policy endpoint ${index + 1}`);
  if (!Array.isArray(endpoint.routeIds) || endpoint.routeIds.length < 1 || endpoint.routeIds.length > 4) {
    throw new Error(`model endpoint policy endpoint ${index + 1} routeIds must contain between one and four entries.`);
  }
  const routeIds = endpoint.routeIds.map((routeId) => identifier(routeId, `model endpoint policy endpoint ${index + 1} route id`));
  if (new Set(routeIds).size !== routeIds.length) {
    throw new Error(`model endpoint policy endpoint ${index + 1} routeIds must be unique.`);
  }
  return {
    id: endpointIdentifier(endpoint.id, `model endpoint policy endpoint ${index + 1} id`),
    routeIds,
    capabilities: parseCapabilities(endpoint.capabilities, index),
  };
}

function parseCapabilities(value: unknown, index: number): ModelEndpointCapabilities {
  const name = `model endpoint policy endpoint ${index + 1} capabilities`;
  const capabilities = exactRecord(value, ["protocol", "stages", "authentication", "costLimit"], name);
  if (capabilities.protocol !== structuredModelEndpointProtocol) throw new Error(`${name} protocol is unsupported.`);
  if (capabilities.authentication !== ephemeralModelEndpointAuthentication) throw new Error(`${name} authentication is unsupported.`);
  if (capabilities.costLimit !== maximumCostModelEndpointLimit) throw new Error(`${name} costLimit is unsupported.`);
  if (!Array.isArray(capabilities.stages) || capabilities.stages.length < 1 || capabilities.stages.length > 2) {
    throw new Error(`${name} stages must contain one or two entries.`);
  }
  const stages = capabilities.stages.map((stage) => {
    if (stage !== "test" && stage !== "build") throw new Error(`${name} contains an unsupported stage.`);
    return stage;
  });
  if (new Set(stages).size !== stages.length) throw new Error(`${name} stages must be unique.`);
  return {
    protocol: structuredModelEndpointProtocol,
    stages,
    authentication: ephemeralModelEndpointAuthentication,
    costLimit: maximumCostModelEndpointLimit,
  };
}

function routingEntries(policy: ModelRoutingPolicy): readonly { readonly stage: ModelAgentStage; readonly route: ModelRoute }[] {
  return (["lower", "higher"] as const).flatMap((level) => (["test", "build"] as const).map((stage) => ({
    stage,
    route: policy.routes[level][stage],
  })));
}

function endpointIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${name} must be a bounded opaque identifier.`);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw new Error(`${name} must be a bounded identifier.`);
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
