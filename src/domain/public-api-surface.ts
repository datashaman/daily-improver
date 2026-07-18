import { createHash } from "node:crypto";

export const publicApiSurfacePlanSchemaVersion = "public-api-surface-plan/v1" as const;
export const publicApiSurfaceResultSchemaVersion = "public-api-surface-result/v1" as const;
export const publicApiSurfaceComparisonSchemaVersion = "public-api-surface-comparison/v1" as const;

const maximumSymbols = 20_000;
const maximumTargetPaths = 64;
const maximumCommandParts = 128;

export interface PublicApiSurfacePlan {
  readonly schemaVersion: typeof publicApiSurfacePlanSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly configurationSha256: string;
  readonly targetScope: "composer-autoload";
  readonly targetPaths: readonly string[];
  readonly command: readonly string[];
  readonly timeoutMs: number;
}

export interface PublicApiSurfaceExecution {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly resourceExhausted?: string;
}

export interface PublicApiSymbolIdentity {
  readonly identitySha256: string;
  readonly signatureSha256: string;
}

export interface PublicApiSurfaceResult {
  readonly schemaVersion: typeof publicApiSurfaceResultSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly configurationSha256: string;
  readonly targetScope: "composer-autoload";
  readonly targetPaths: readonly string[];
  readonly outcome: "completed";
  readonly symbolIdentitySemantics: string;
  readonly symbols: readonly PublicApiSymbolIdentity[];
  readonly durationMs: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

export interface PublicApiSurfaceComparison {
  readonly schemaVersion: typeof publicApiSurfaceComparisonSchemaVersion;
  readonly adapter: string;
  readonly tool: string;
  readonly configurationSha256: string;
  readonly targetScope: "composer-autoload";
  readonly targetPaths: readonly string[];
  readonly symbolIdentitySemantics: string;
  readonly baselineSymbolCount: number;
  readonly currentSymbolCount: number;
  readonly addedSymbolCount: number;
  readonly outcome: "clean" | "additive-compatible" | "unchanged";
}

export function assertPublicApiSurfacePlan(value: unknown): PublicApiSurfacePlan {
  const plan = exactRecord(value, ["adapter", "command", "configurationSha256", "schemaVersion", "targetPaths", "targetScope", "timeoutMs", "tool"], "Public-API surface plan");
  if (plan.schemaVersion !== publicApiSurfacePlanSchemaVersion || plan.targetScope !== "composer-autoload") {
    throw new Error("Public-API surface plan uses an unsupported schema or target scope.");
  }
  if (!Array.isArray(plan.command) || plan.command.length < 1 || plan.command.length > maximumCommandParts) {
    throw new Error("Public-API surface command is missing or excessive.");
  }
  const command = plan.command.map((part) => {
    if (typeof part !== "string" || !part || part.length > 4_096 || part.includes("\0")) throw new Error("Public-API surface command is malformed.");
    return part;
  });
  const targetPaths = paths(plan.targetPaths);
  if (!Number.isInteger(plan.timeoutMs) || (plan.timeoutMs as number) < 1_000 || (plan.timeoutMs as number) > 30 * 60_000) {
    throw new Error("Public-API surface timeout is malformed or excessive.");
  }
  return Object.freeze({
    schemaVersion: publicApiSurfacePlanSchemaVersion,
    adapter: identity(plan.adapter, "adapter"),
    tool: identity(plan.tool, "tool"),
    configurationSha256: hash(plan.configurationSha256, "configuration"),
    targetScope: "composer-autoload",
    targetPaths,
    command: Object.freeze(command),
    timeoutMs: plan.timeoutMs as number,
  });
}

export function assertPublicApiSurfaceResult(value: unknown, plan: PublicApiSurfacePlan): PublicApiSurfaceResult {
  const result = exactRecord(value, ["adapter", "configurationSha256", "durationMs", "outcome", "schemaVersion", "stderrSha256", "stdoutSha256", "symbolIdentitySemantics", "symbols", "targetPaths", "targetScope", "tool"], "Public-API surface result");
  if (result.schemaVersion !== publicApiSurfaceResultSchemaVersion || result.outcome !== "completed" || result.targetScope !== plan.targetScope) {
    throw new Error("Public-API surface result uses an unsupported schema, outcome, or target scope.");
  }
  if (result.adapter !== plan.adapter || result.tool !== plan.tool || result.configurationSha256 !== plan.configurationSha256) {
    throw new Error("Public-API surface result identifies the wrong adapter, tool, or configuration.");
  }
  if (!Array.isArray(result.targetPaths) || JSON.stringify(result.targetPaths) !== JSON.stringify(plan.targetPaths)) {
    throw new Error("Public-API surface result identifies the wrong target paths.");
  }
  if (!Array.isArray(result.symbols) || result.symbols.length > maximumSymbols) {
    throw new Error("Public-API surface symbols are malformed or excessive.");
  }
  const symbols = result.symbols.map((symbol) => {
    const record = exactRecord(symbol, ["identitySha256", "signatureSha256"], "Public-API symbol");
    return Object.freeze({
      identitySha256: hash(record.identitySha256, "symbol"),
      signatureSha256: hash(record.signatureSha256, "signature"),
    });
  }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  if (new Set(symbols.map((symbol) => symbol.identitySha256)).size !== symbols.length) throw new Error("Public-API symbol identities contain duplicates.");
  if (!Number.isInteger(result.durationMs) || (result.durationMs as number) < 0 || (result.durationMs as number) > plan.timeoutMs) {
    throw new Error("Public-API surface duration is malformed or excessive.");
  }
  return Object.freeze({
    schemaVersion: publicApiSurfaceResultSchemaVersion,
    adapter: plan.adapter,
    tool: plan.tool,
    configurationSha256: plan.configurationSha256,
    targetScope: plan.targetScope,
    targetPaths: plan.targetPaths,
    outcome: "completed",
    symbolIdentitySemantics: schemaIdentity(result.symbolIdentitySemantics),
    symbols: Object.freeze(symbols),
    durationMs: result.durationMs as number,
    stdoutSha256: hash(result.stdoutSha256, "stdout"),
    stderrSha256: hash(result.stderrSha256, "stderr"),
  });
}

export function comparePublicApiSurfaces(baselineValue: unknown, currentValue: unknown): PublicApiSurfaceComparison {
  const baseline = comparableResult(baselineValue, "baseline");
  const current = comparableResult(currentValue, "current");
  if (baseline.adapter !== current.adapter || baseline.tool !== current.tool
    || baseline.configurationSha256 !== current.configurationSha256 || baseline.targetScope !== current.targetScope
    || JSON.stringify(baseline.targetPaths) !== JSON.stringify(current.targetPaths)) {
    throw new Error("Public-API surfaces are incomparable across adapter, tool, configuration, or target scope.");
  }
  if (baseline.symbolIdentitySemantics !== current.symbolIdentitySemantics) {
    throw new Error("Public-API surfaces use incomparable symbol-identity semantics.");
  }
  const currentByIdentity = new Map(current.symbols.map((symbol) => [symbol.identitySha256, symbol]));
  for (const symbol of baseline.symbols) {
    const currentSymbol = currentByIdentity.get(symbol.identitySha256);
    if (!currentSymbol) throw new Error("Public-API surface removed a public symbol.");
    if (currentSymbol.signatureSha256 !== symbol.signatureSha256) throw new Error("Public-API surface incompatibly changed a public symbol signature.");
  }
  const addedSymbolCount = current.symbols.length - baseline.symbols.length;
  return Object.freeze({
    schemaVersion: publicApiSurfaceComparisonSchemaVersion,
    adapter: baseline.adapter,
    tool: baseline.tool,
    configurationSha256: baseline.configurationSha256,
    targetScope: baseline.targetScope,
    targetPaths: baseline.targetPaths,
    symbolIdentitySemantics: baseline.symbolIdentitySemantics,
    baselineSymbolCount: baseline.symbols.length,
    currentSymbolCount: current.symbols.length,
    addedSymbolCount,
    outcome: baseline.symbols.length === 0 && current.symbols.length === 0 ? "clean" : addedSymbolCount > 0 ? "additive-compatible" : "unchanged",
  });
}

export function publicApiSurfaceHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparableResult(value: unknown, label: string): PublicApiSurfaceResult {
  const record = exactRecord(value, ["adapter", "configurationSha256", "durationMs", "outcome", "schemaVersion", "stderrSha256", "stdoutSha256", "symbolIdentitySemantics", "symbols", "targetPaths", "targetScope", "tool"], `Public-API ${label} result`);
  const plan = assertPublicApiSurfacePlan({
    schemaVersion: publicApiSurfacePlanSchemaVersion,
    adapter: record.adapter,
    tool: record.tool,
    configurationSha256: record.configurationSha256,
    targetScope: record.targetScope,
    targetPaths: record.targetPaths,
    command: ["comparison-only"],
    timeoutMs: 30 * 60_000,
  });
  return assertPublicApiSurfaceResult(record, plan);
}

function paths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumTargetPaths) throw new Error("Public-API target paths are missing or excessive.");
  const checked = value.map((path) => {
    if (typeof path !== "string" || path.length > 512 || path.startsWith("/") || path.includes("\\")
      || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Public-API target path is malformed or escaped.");
    return path.replace(/\/$/u, "");
  }).sort();
  if (new Set(checked).size !== checked.length) throw new Error("Public-API target paths contain duplicates.");
  return Object.freeze(checked);
}

function identity(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error(`Public-API ${name} is malformed.`);
  return value;
}

function schemaIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/v[1-9][0-9]{0,5}$/u.test(value)) throw new Error("Public-API symbol-identity semantics are malformed.");
  return value;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Public-API ${name} identity is malformed.`);
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${name} is extended or incomplete.`);
  return record;
}
