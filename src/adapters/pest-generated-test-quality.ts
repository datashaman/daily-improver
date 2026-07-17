import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterGeneratedTestQualityInspection,
  GeneratedTestQualityInspectionRequest,
} from "../contracts.js";

export const pestGeneratedTestQualitySchemaVersion = "pest-generated-test-quality-inspection/v1" as const;

export const pestGeneratedTestQualitySignals = [
  "focused-test",
  "skipped-test",
  "todo-test",
  "assertion-free-test",
  "empty-data-provider",
  "unsupported-data-provider",
] as const;

export type PestGeneratedTestQualitySignal = (typeof pestGeneratedTestQualitySignals)[number];

export interface PestGeneratedTestQualityFact {
  readonly path: string;
  readonly sha256: string;
  readonly declarationCount: number;
  readonly assertionExpressionCount: number;
  readonly lifecycleAssertionCount: number;
  readonly focusedCount: number;
  readonly skippedCount: number;
  readonly todoCount: number;
  readonly dataProviderCount: number;
  readonly dataProviderCaseCount: number;
  readonly emptyDataProviderCount: number;
  readonly unsupportedDataProviderCount: number;
  readonly dataProviderCoverage: "not-applicable" | "covered";
  readonly signals: readonly PestGeneratedTestQualitySignal[];
}

export interface PestGeneratedTestQualityInspection extends AdapterGeneratedTestQualityInspection {
  readonly schemaVersion: typeof pestGeneratedTestQualitySchemaVersion;
  readonly adapter: "php";
  readonly framework: "pest";
  readonly lifecycleSchemaVersion: "generated-test-lifecycle-decision/v1";
  readonly lifecyclePhase: "baseline";
  readonly lifecycleAttempts: 3;
  readonly observedTestPaths: readonly string[];
  readonly tests: readonly PestGeneratedTestQualityFact[];
  readonly outcome: "accepted" | "rejected";
}

const maximumSourceBytes = 256_000;
const maximumTokens = 40_000;
const maximumMetric = 1_000_000;
const safePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\x00-\x1f\x7f]{1,240}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

export async function inspectPestGeneratedTestQuality(
  request: GeneratedTestQualityInspectionRequest,
): Promise<PestGeneratedTestQualityInspection> {
  const expected = validateRequest(request);
  const tests = await Promise.all(expected.observedTestPaths.map(async (path) => {
    const source = await readBoundedSource(expected.root, path);
    const sha256 = digest(source);
    if (expected.baselineLifecycle.testSha256[path] !== sha256) {
      throw new Error(`Pest generated-test inspection is not bound to baseline source: ${path}.`);
    }
    const tokens = tokenizePhp(source);
    const declarationCount = countCalls(tokens, new Set(["it", "test"]));
    if (declarationCount < 1) throw new Error(`Pest generated test has unsupported discovery syntax: ${path}.`);
    const assertionExpressionCount = countAssertions(tokens);
    const focusedCount = countCalls(tokens, new Set(["only"]));
    const skippedCount = countCalls(tokens, new Set(["skip"]));
    const todoCount = countCalls(tokens, new Set(["todo"]));
    const providers = inspectProviders(tokens);
    const lifecycleAssertionCount = lifecycleAssertions(expected.baselineLifecycle, path);
    const signals: PestGeneratedTestQualitySignal[] = [];
    if (focusedCount > 0) signals.push("focused-test");
    if (skippedCount > 0) signals.push("skipped-test");
    if (todoCount > 0) signals.push("todo-test");
    if (assertionExpressionCount < declarationCount || lifecycleAssertionCount < declarationCount) signals.push("assertion-free-test");
    if (providers.emptyCount > 0) signals.push("empty-data-provider");
    if (providers.unsupportedCount > 0) signals.push("unsupported-data-provider");
    return {
      path,
      sha256,
      declarationCount,
      assertionExpressionCount,
      lifecycleAssertionCount,
      focusedCount,
      skippedCount,
      todoCount,
      dataProviderCount: providers.count,
      dataProviderCaseCount: providers.caseCount,
      emptyDataProviderCount: providers.emptyCount,
      unsupportedDataProviderCount: providers.unsupportedCount,
      dataProviderCoverage: providers.count === 0 ? "not-applicable" as const : "covered" as const,
      signals,
    };
  }));
  return assertPestGeneratedTestQualityInspection({
    schemaVersion: pestGeneratedTestQualitySchemaVersion,
    adapter: "php",
    framework: "pest",
    selectedTestPath: expected.selectedTestPath,
    lifecycleSchemaVersion: expected.baselineLifecycle.schemaVersion,
    lifecyclePhase: "baseline",
    lifecycleAttempts: 3,
    observedTestPaths: expected.observedTestPaths,
    tests,
    outcome: tests.some((test) => test.signals.length > 0) ? "rejected" : "accepted",
  }, expected);
}

export function assertPestGeneratedTestQualityInspection(
  value: unknown,
  request: GeneratedTestQualityInspectionRequest,
): PestGeneratedTestQualityInspection {
  const expected = validateRequest(request);
  const inspection = exactRecord(value, [
    "adapter", "framework", "lifecycleAttempts", "lifecyclePhase", "lifecycleSchemaVersion", "observedTestPaths",
    "outcome", "schemaVersion", "selectedTestPath", "tests",
  ], "Pest generated-test inspection");
  if (inspection.schemaVersion !== pestGeneratedTestQualitySchemaVersion || inspection.adapter !== "php" || inspection.framework !== "pest") {
    throw new Error("Pest generated-test inspection has an unsupported identity or schema version.");
  }
  if (inspection.selectedTestPath !== expected.selectedTestPath) throw new Error("Pest generated-test inspection is not bound to the selected test path.");
  if (inspection.lifecycleSchemaVersion !== expected.baselineLifecycle.schemaVersion || inspection.lifecyclePhase !== "baseline" || inspection.lifecycleAttempts !== 3) {
    throw new Error("Pest generated-test inspection is not bound to the baseline lifecycle.");
  }
  const observedTestPaths = stringArray(inspection.observedTestPaths, "observed test paths");
  if (!sameArray(observedTestPaths, expected.observedTestPaths)) throw new Error("Pest generated-test inspection does not cover the lifecycle test paths.");
  if (!Array.isArray(inspection.tests) || inspection.tests.length !== observedTestPaths.length) throw new Error("Pest generated-test inspection has an invalid test collection.");
  const tests = inspection.tests.map((test, index) => parseFact(test, observedTestPaths[index]!, expected));
  const outcome = tests.some((test) => test.signals.length > 0) ? "rejected" : "accepted";
  if (inspection.outcome !== outcome) throw new Error("Pest generated-test inspection outcome is inconsistent.");
  return {
    schemaVersion: pestGeneratedTestQualitySchemaVersion,
    adapter: "php",
    framework: "pest",
    selectedTestPath: expected.selectedTestPath,
    lifecycleSchemaVersion: "generated-test-lifecycle-decision/v1",
    lifecyclePhase: "baseline",
    lifecycleAttempts: 3,
    observedTestPaths,
    tests,
    outcome,
  };
}

export function requireAcceptedPestGeneratedTestQuality(inspection: PestGeneratedTestQualityInspection): void {
  if (inspection.outcome === "rejected") {
    const signals = inspection.tests.flatMap((test) => test.signals.map((signal) => `${test.path}:${signal}`));
    throw new Error(`Generated Pest test failed quality inspection: ${signals.join(", ")}.`);
  }
}

function validateRequest(request: GeneratedTestQualityInspectionRequest): GeneratedTestQualityInspectionRequest {
  if (request.framework !== "pest") throw new Error("Pest generated-test inspection requires the Pest framework.");
  if (typeof request.root !== "string" || request.root.length === 0) throw new Error("Pest generated-test inspection root is malformed.");
  const selectedTestPath = safePath(request.selectedTestPath, "selected test path");
  const observedTestPaths = request.observedTestPaths.map((path) => safePath(path, "observed test path")).sort();
  if (observedTestPaths.length < 1 || observedTestPaths.length > 32 || new Set(observedTestPaths).size !== observedTestPaths.length || !observedTestPaths.includes(selectedTestPath)) {
    throw new Error("Pest generated-test inspection path selection is malformed.");
  }
  const lifecycle = request.baselineLifecycle;
  if (lifecycle.schemaVersion !== "generated-test-lifecycle-decision/v1" || lifecycle.phase !== "baseline" || lifecycle.outcome !== "accepted" || lifecycle.attempts.length !== 3) {
    throw new Error("Pest generated-test inspection requires an accepted three-attempt baseline lifecycle.");
  }
  if (!sameArray(Object.keys(lifecycle.testSha256).sort(), observedTestPaths)) throw new Error("Pest generated-test inspection paths are not bound to baseline lifecycle hashes.");
  return { ...request, selectedTestPath, observedTestPaths };
}

function parseFact(value: unknown, expectedPath: string, request: GeneratedTestQualityInspectionRequest): PestGeneratedTestQualityFact {
  const fact = exactRecord(value, [
    "assertionExpressionCount", "dataProviderCaseCount", "dataProviderCount", "dataProviderCoverage", "declarationCount",
    "emptyDataProviderCount", "focusedCount", "lifecycleAssertionCount", "path", "sha256", "signals", "skippedCount", "todoCount",
    "unsupportedDataProviderCount",
  ], "Pest generated-test fact");
  if (fact.path !== expectedPath) throw new Error("Pest generated-test fact is not bound to its observed path.");
  if (typeof fact.sha256 !== "string" || !digestPattern.test(fact.sha256) || fact.sha256 !== request.baselineLifecycle.testSha256[expectedPath]) {
    throw new Error("Pest generated-test fact is not bound to baseline source identity.");
  }
  const declarationCount = positiveMetric(fact.declarationCount, "declaration count");
  const assertionExpressionCount = metric(fact.assertionExpressionCount, "assertion expression count");
  const lifecycleAssertionCount = metric(fact.lifecycleAssertionCount, "lifecycle assertion count");
  if (lifecycleAssertionCount !== lifecycleAssertions(request.baselineLifecycle, expectedPath)) throw new Error("Pest generated-test fact does not match lifecycle assertions.");
  const focusedCount = metric(fact.focusedCount, "focused count");
  const skippedCount = metric(fact.skippedCount, "skipped count");
  const todoCount = metric(fact.todoCount, "todo count");
  const dataProviderCount = metric(fact.dataProviderCount, "data-provider count");
  const dataProviderCaseCount = metric(fact.dataProviderCaseCount, "data-provider case count");
  const emptyDataProviderCount = metric(fact.emptyDataProviderCount, "empty data-provider count");
  const unsupportedDataProviderCount = metric(fact.unsupportedDataProviderCount, "unsupported data-provider count");
  if (emptyDataProviderCount + unsupportedDataProviderCount > dataProviderCount) throw new Error("Pest generated-test provider classifications are unbounded.");
  const dataProviderCoverage = fact.dataProviderCoverage;
  if ((dataProviderCount === 0 && (dataProviderCoverage !== "not-applicable" || dataProviderCaseCount !== 0))
    || (dataProviderCount > 0 && dataProviderCoverage !== "covered")) {
    throw new Error("Pest generated-test data-provider coverage is inconsistent.");
  }
  if (!Array.isArray(fact.signals) || fact.signals.length > pestGeneratedTestQualitySignals.length
    || fact.signals.some((signal) => !pestGeneratedTestQualitySignals.includes(signal as PestGeneratedTestQualitySignal))
    || new Set(fact.signals).size !== fact.signals.length) throw new Error("Pest generated-test quality signals are malformed.");
  const signals = fact.signals as PestGeneratedTestQualitySignal[];
  if ((focusedCount > 0) !== signals.includes("focused-test")
    || (skippedCount > 0) !== signals.includes("skipped-test")
    || (todoCount > 0) !== signals.includes("todo-test")
    || (assertionExpressionCount < declarationCount || lifecycleAssertionCount < declarationCount) !== signals.includes("assertion-free-test")
    || (emptyDataProviderCount > 0) !== signals.includes("empty-data-provider")
    || (unsupportedDataProviderCount > 0) !== signals.includes("unsupported-data-provider")) {
    throw new Error("Pest generated-test quality signals are inconsistent with their metrics.");
  }
  if (dataProviderCount > 0 && dataProviderCaseCount < dataProviderCount
    && emptyDataProviderCount === 0 && unsupportedDataProviderCount === 0) {
    throw new Error("Pest generated-test provider signals are inconsistent with their coverage.");
  }
  return { path: expectedPath, sha256: fact.sha256, declarationCount, assertionExpressionCount, lifecycleAssertionCount, focusedCount, skippedCount, todoCount, dataProviderCount, dataProviderCaseCount, emptyDataProviderCount, unsupportedDataProviderCount, dataProviderCoverage: dataProviderCoverage as "not-applicable" | "covered", signals };
}

async function readBoundedSource(root: string, path: string): Promise<string> {
  const absolute = join(root, path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile()) throw new Error(`Pest generated test must be a regular file: ${path}.`);
  if (metadata.size < 1 || metadata.size > maximumSourceBytes) throw new Error(`Pest generated test must contain 1-${maximumSourceBytes} bytes: ${path}.`);
  return await readFile(absolute, "utf8");
}

function tokenizePhp(source: string): readonly string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if (/\s/u.test(current)) { index++; continue; }
    if (current === "/" && next === "/" || current === "#") { while (index < source.length && source[index] !== "\n") index++; continue; }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Pest generated test has an unclosed block comment.");
      index = end + 2; continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      index++;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === quote) { index++; closed = true; break; }
        index++;
      }
      if (!closed) throw new Error("Pest generated test has an unclosed string.");
      tokens.push("STRING"); continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/u)?.[0];
    if (identifier) { tokens.push(identifier); index += identifier.length; continue; }
    const multi = source.slice(index, index + 3);
    if (["->", "=>", "::", "..."].includes(multi.slice(0, 2)) || multi === "...") {
      const token = multi === "..." ? multi : multi.slice(0, 2); tokens.push(token); index += token.length; continue;
    }
    tokens.push(current); index++;
    if (tokens.length > maximumTokens) throw new Error(`Pest generated test exceeds ${maximumTokens} lexical tokens.`);
  }
  if (tokens.length > maximumTokens) throw new Error(`Pest generated test exceeds ${maximumTokens} lexical tokens.`);
  validateBalancedSyntax(tokens);
  return tokens;
}

function countCalls(tokens: readonly string[], names: ReadonlySet<string>): number {
  let count = 0;
  for (let index = 0; index < tokens.length - 1; index++) if (names.has(tokens[index]!.toLowerCase()) && tokens[index + 1] === "(") count++;
  return count;
}

function countAssertions(tokens: readonly string[]): number {
  let count = 0;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (tokens[index + 1] === "(" && (lower === "expect" || lower === "assert" || /^assert[A-Z][A-Za-z0-9_]*$/u.test(token) || lower === "throws" || lower === "throwsnoexceptions")) count++;
    if (tokens[index - 1] === "->" && /^to[A-Z][A-Za-z0-9_]*$/u.test(token) && tokens[index + 1] === "(") count++;
  }
  return count;
}

function inspectProviders(tokens: readonly string[]): { count: number; caseCount: number; emptyCount: number; unsupportedCount: number } {
  let count = 0;
  let caseCount = 0;
  let emptyCount = 0;
  let unsupportedCount = 0;
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index]?.toLowerCase() !== "with" || tokens[index + 1] !== "(") continue;
    count++;
    const closing = matching(tokens, index + 1, "(", ")");
    const argument = tokens.slice(index + 2, closing);
    if (argument.length === 0) { emptyCount++; index = closing; continue; }
    if (argument.some((token) => token === "$" || token === "fn" || token === "function" || token === "yield") || (argument.length === 1 && argument[0] === "STRING")) {
      unsupportedCount++; index = closing; continue;
    }
    const cases = argument[0] === "[" && argument.at(-1) === "]"
      ? topLevelElements(argument.slice(1, -1), "[", "]")
      : topLevelElements(argument, "(", ")");
    if (cases < 1) emptyCount++;
    caseCount += cases;
    index = closing;
  }
  return { count, caseCount, emptyCount, unsupportedCount };
}

function validateBalancedSyntax(tokens: readonly string[]): void {
  const stack: string[] = [];
  const matchingOpen: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
  for (const token of tokens) {
    if (token === "(" || token === "[" || token === "{") stack.push(token);
    if (token === ")" || token === "]" || token === "}") {
      if (stack.pop() !== matchingOpen[token]) throw new Error("Pest generated test has malformed lexical structure.");
    }
  }
  if (stack.length > 0) throw new Error("Pest generated test has malformed lexical structure.");
}

function matching(tokens: readonly string[], start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index] === open) depth++;
    if (tokens[index] === close && --depth === 0) return index;
  }
  throw new Error("Pest generated test has unbalanced provider syntax.");
}

function topLevelElements(tokens: readonly string[], open: string, close: string): number {
  if (tokens.length === 0) return 0;
  let depth = 0;
  let count = 1;
  for (const token of tokens) {
    if (token === open || token === "[" || token === "{") depth++;
    else if (token === close || token === "]" || token === "}") depth--;
    else if (token === "," && depth === 0) count++;
  }
  return count;
}

function lifecycleAssertions(lifecycle: GeneratedTestQualityInspectionRequest["baselineLifecycle"], path: string): number {
  const values = lifecycle.attempts.map((attempt) => attempt.tests.find((test) => test.path === path)?.assertionCount);
  if (values.some((value) => value === undefined) || new Set(values).size !== 1) throw new Error(`Pest generated-test inspection lifecycle metrics are malformed: ${path}.`);
  return values[0] as number;
}

function safePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !safePathPattern.test(value) || !value.endsWith(".php")) throw new Error(`Pest generated-test inspection ${name} is malformed.`);
  return value;
}

function metric(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximumMetric) throw new Error(`Pest generated-test inspection ${name} is malformed.`);
  return value as number;
}

function positiveMetric(value: unknown, name: string): number {
  const result = metric(value, name);
  if (result < 1) throw new Error(`Pest generated-test inspection ${name} must be positive.`);
  return result;
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((item) => typeof item !== "string" || !safePathPattern.test(item))) throw new Error(`Pest generated-test inspection ${name} are malformed.`);
  return value as string[];
}

function digest(source: string): string { return createHash("sha256").update(source).digest("hex"); }
function sameArray(left: readonly string[], right: readonly string[]): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an exact object.`);
  const record = value as Record<string, unknown>;
  if (!sameArray(Object.keys(record).sort(), [...keys].sort())) throw new Error(`${name} must have an exact schema.`);
  return record;
}
