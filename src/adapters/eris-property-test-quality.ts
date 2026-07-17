import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type {
  AdapterGeneratedTestQualityInspection,
  GeneratedTestQualityInspectionRequest,
} from "../contracts.js";
import { assertPropertyTestExecutionProof } from "../domain/property-test-execution-proof.js";
import {
  assertPestGeneratedTestQualityInspection,
  type PestGeneratedTestQualityInspection,
} from "./pest-generated-test-quality.js";
import {
  assertPhpunitGeneratedTestQualityInspection,
  type PhpunitGeneratedTestQualityInspection,
} from "./phpunit-generated-test-quality.js";

export const erisPropertyTestQualitySchemaVersion = "eris-property-test-quality-inspection/v1" as const;

export const erisPropertyTestQualitySignals = [
  "missing-test-trait",
  "missing-generator",
  "unsupported-generator",
  "missing-property-execution",
  "unsupported-iteration-override",
  "missing-target-invocation",
  "missing-invariant-check",
] as const;

export type ErisPropertyTestQualitySignal = (typeof erisPropertyTestQualitySignals)[number];

export interface ErisPropertyTestQualityFact {
  readonly path: string;
  readonly sha256: string;
  readonly testTraitCount: number;
  readonly propertyCount: number;
  readonly generatorCount: number;
  readonly unsupportedGeneratorCount: number;
  readonly thenCount: number;
  readonly targetInvocationCount: number;
  readonly invariantAssertionCount: number;
  readonly iterationOverrideCount: number;
  readonly iterationMode: "eris-default-100";
  readonly executedInputCount: number;
  readonly targetExecutionCount: number;
  readonly invariantCheckCount: number;
  readonly failedInvariantCheckCount: number;
  readonly signals: readonly ErisPropertyTestQualitySignal[];
}

export interface ErisPropertyTestQualityInspection extends AdapterGeneratedTestQualityInspection {
  readonly schemaVersion: typeof erisPropertyTestQualitySchemaVersion;
  readonly adapter: "php";
  readonly framework: "eris";
  readonly runnerFramework: "pest" | "phpunit";
  readonly runnerInspection: PestGeneratedTestQualityInspection | PhpunitGeneratedTestQualityInspection;
  readonly lifecycleSchemaVersion: "generated-test-lifecycle-decision/v1";
  readonly propertyProofSchemaVersion: "property-test-execution-proof/v1";
  readonly lifecyclePhase: "baseline";
  readonly lifecycleAttempts: 3;
  readonly observedTestPaths: readonly string[];
  readonly target: string;
  readonly invariant: string;
  readonly tests: readonly ErisPropertyTestQualityFact[];
  readonly outcome: "accepted" | "rejected";
}

const maximumSourceBytes = 256_000;
const maximumTokens = 40_000;
const maximumMetric = 1_000_000;
const safePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\x00-\x1f\x7f]{1,240}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const supportedGeneratorFactories = new Set([
  "associative", "bind", "bool", "byte", "char", "charprintableascii", "choose", "constant", "date", "elements", "filter",
  "float", "frequency", "int", "map", "names", "nat", "neg", "oneof", "pos", "regex", "seq", "set", "string", "subset",
  "suchthat", "tuple", "vector",
]);

export async function inspectErisPropertyTestQuality(
  request: GeneratedTestQualityInspectionRequest,
  runnerInspection: PestGeneratedTestQualityInspection | PhpunitGeneratedTestQualityInspection,
): Promise<ErisPropertyTestQualityInspection> {
  const expected = validateRequest(request);
  const proof = expected.propertyProof!;
  const validatedRunnerInspection = assertRunnerInspection(runnerInspection, expected);
  const tests = await Promise.all(expected.observedTestPaths.map(async (path) => {
    const source = await readBoundedSource(expected.root, path);
    const sha256 = digest(source);
    if (expected.baselineLifecycle.testSha256[path] !== sha256) {
      throw new Error(`Eris property-test inspection is not bound to baseline source: ${path}.`);
    }
    const tokens = tokenizePhp(source);
    const selected = path === proof.testPath;
    const testTraitCount = countErisTestTraits(tokens);
    const structures = inspectPropertyStructures(tokens, targetSymbol(proof.target));
    const signals: ErisPropertyTestQualitySignal[] = [];
    if (selected && testTraitCount < 1) signals.push("missing-test-trait");
    if (selected && structures.generatorCount < 1) signals.push("missing-generator");
    if (selected && structures.unsupportedGeneratorCount > 0) signals.push("unsupported-generator");
    if (selected && (structures.propertyCount < 1 || structures.thenCount !== structures.propertyCount)) signals.push("missing-property-execution");
    if (selected && structures.iterationOverrideCount > 0) signals.push("unsupported-iteration-override");
    if (selected && structures.targetInvocationCount < structures.propertyCount) signals.push("missing-target-invocation");
    if (selected && structures.invariantAssertionCount < structures.propertyCount) signals.push("missing-invariant-check");
    return {
      path,
      sha256,
      testTraitCount,
      propertyCount: structures.propertyCount,
      generatorCount: structures.generatorCount,
      unsupportedGeneratorCount: structures.unsupportedGeneratorCount,
      thenCount: structures.thenCount,
      targetInvocationCount: structures.targetInvocationCount,
      invariantAssertionCount: structures.invariantAssertionCount,
      iterationOverrideCount: structures.iterationOverrideCount,
      iterationMode: "eris-default-100" as const,
      executedInputCount: selected ? proof.inputDigests.length : 0,
      targetExecutionCount: selected ? proof.targetExecutionCount : 0,
      invariantCheckCount: selected ? proof.invariantCheckCount : 0,
      failedInvariantCheckCount: selected ? proof.failedInvariantCheckCount : 0,
      signals,
    };
  }));
  return assertErisPropertyTestQualityInspection({
    schemaVersion: erisPropertyTestQualitySchemaVersion,
    adapter: "php",
    framework: "eris",
    runnerFramework: expected.framework,
    runnerInspection: validatedRunnerInspection,
    selectedTestPath: expected.selectedTestPath,
    lifecycleSchemaVersion: expected.baselineLifecycle.schemaVersion,
    propertyProofSchemaVersion: proof.schemaVersion,
    lifecyclePhase: "baseline",
    lifecycleAttempts: 3,
    observedTestPaths: expected.observedTestPaths,
    target: proof.target,
    invariant: proof.invariant,
    tests,
    outcome: tests.some((test) => test.signals.length > 0) ? "rejected" : "accepted",
  }, expected);
}

export function assertErisPropertyTestQualityInspection(
  value: unknown,
  request: GeneratedTestQualityInspectionRequest,
): ErisPropertyTestQualityInspection {
  const expected = validateRequest(request);
  const proof = expected.propertyProof!;
  const inspection = exactRecord(value, [
    "adapter", "framework", "invariant", "lifecycleAttempts", "lifecyclePhase", "lifecycleSchemaVersion", "observedTestPaths",
    "outcome", "propertyProofSchemaVersion", "runnerFramework", "runnerInspection", "schemaVersion", "selectedTestPath", "target", "tests",
  ], "Eris property-test inspection");
  if (inspection.schemaVersion !== erisPropertyTestQualitySchemaVersion || inspection.adapter !== "php" || inspection.framework !== "eris") {
    throw new Error("Eris property-test inspection has an unsupported identity or schema version.");
  }
  if (inspection.runnerFramework !== expected.framework) throw new Error("Eris property-test inspection is not bound to the detected runner framework.");
  const runnerInspection = assertRunnerInspection(inspection.runnerInspection, expected);
  if (inspection.selectedTestPath !== proof.testPath || inspection.selectedTestPath !== expected.selectedTestPath) {
    throw new Error("Eris property-test inspection is not bound to the selected proof test path.");
  }
  if (inspection.lifecycleSchemaVersion !== expected.baselineLifecycle.schemaVersion || inspection.lifecyclePhase !== "baseline" || inspection.lifecycleAttempts !== 3) {
    throw new Error("Eris property-test inspection is not bound to the baseline lifecycle.");
  }
  if (inspection.propertyProofSchemaVersion !== proof.schemaVersion || inspection.target !== proof.target || inspection.invariant !== proof.invariant) {
    throw new Error("Eris property-test inspection is not bound to the property execution proof, target, and invariant.");
  }
  const observedTestPaths = stringArray(inspection.observedTestPaths, "observed test paths");
  if (!sameArray(observedTestPaths, expected.observedTestPaths)) throw new Error("Eris property-test inspection does not cover the lifecycle test paths.");
  if (!Array.isArray(inspection.tests) || inspection.tests.length !== observedTestPaths.length) throw new Error("Eris property-test inspection has an invalid test collection.");
  const tests = inspection.tests.map((test, index) => parseFact(test, observedTestPaths[index]!, expected));
  const outcome = tests.some((test) => test.signals.length > 0) ? "rejected" : "accepted";
  if (inspection.outcome !== outcome) throw new Error("Eris property-test inspection outcome is inconsistent.");
  if (outcome === "accepted" && runnerInspection.outcome !== "accepted") throw new Error("Accepted Eris property-test inspection requires accepted runner evidence.");
  return {
    schemaVersion: erisPropertyTestQualitySchemaVersion,
    adapter: "php",
    framework: "eris",
    runnerFramework: expected.framework as "pest" | "phpunit",
    runnerInspection,
    selectedTestPath: proof.testPath,
    lifecycleSchemaVersion: "generated-test-lifecycle-decision/v1",
    propertyProofSchemaVersion: "property-test-execution-proof/v1",
    lifecyclePhase: "baseline",
    lifecycleAttempts: 3,
    observedTestPaths,
    target: proof.target,
    invariant: proof.invariant,
    tests,
    outcome,
  };
}

function assertRunnerInspection(
  value: unknown,
  request: GeneratedTestQualityInspectionRequest,
): PestGeneratedTestQualityInspection | PhpunitGeneratedTestQualityInspection {
  if (request.framework === "pest") return assertPestGeneratedTestQualityInspection(value, request);
  return assertPhpunitGeneratedTestQualityInspection(value, request);
}

export function requireAcceptedErisPropertyTestQuality(inspection: ErisPropertyTestQualityInspection): void {
  if (inspection.outcome === "rejected") {
    const signals = inspection.tests.flatMap((test) => test.signals.map((signal) => `${test.path}:${signal}`));
    throw new Error(`Generated Eris property test failed quality inspection: ${signals.join(", ")}.`);
  }
}

function validateRequest(request: GeneratedTestQualityInspectionRequest): GeneratedTestQualityInspectionRequest {
  if (request.propertyFramework !== "eris") throw new Error("Eris property-test inspection requires the Eris property framework.");
  if (request.framework !== "phpunit" && request.framework !== "pest") throw new Error("Eris property-test inspection requires a supported PHPUnit runner.");
  if (typeof request.root !== "string" || request.root.length === 0) throw new Error("Eris property-test inspection root is malformed.");
  const selectedTestPath = safePath(request.selectedTestPath, "selected test path");
  const observedTestPaths = request.observedTestPaths.map((path) => safePath(path, "observed test path")).sort();
  if (observedTestPaths.length < 1 || observedTestPaths.length > 32 || new Set(observedTestPaths).size !== observedTestPaths.length || !observedTestPaths.includes(selectedTestPath)) {
    throw new Error("Eris property-test inspection path selection is malformed.");
  }
  const lifecycle = request.baselineLifecycle;
  if (lifecycle.schemaVersion !== "generated-test-lifecycle-decision/v1" || lifecycle.phase !== "baseline" || lifecycle.outcome !== "accepted" || lifecycle.attempts.length !== 3) {
    throw new Error("Eris property-test inspection requires an accepted three-attempt baseline lifecycle.");
  }
  if (!sameArray(Object.keys(lifecycle.testSha256).sort(), observedTestPaths)) throw new Error("Eris property-test inspection paths are not bound to baseline lifecycle hashes.");
  const suppliedProof = request.propertyProof;
  if (!suppliedProof) {
    throw new Error("Eris property-test inspection requires an exact bounded property execution proof.");
  }
  let proof;
  try {
    proof = assertPropertyTestExecutionProof(suppliedProof, {
      executionNonce: suppliedProof.executionNonce,
      target: suppliedProof.target,
      approvedInvariants: [suppliedProof.invariant],
      changedTestPaths: observedTestPaths,
      baselineMustFail: suppliedProof.failedInvariantCheckCount > 0,
    });
  } catch {
    throw new Error("Eris property-test inspection requires an exact bounded property execution proof.");
  }
  if (proof.testPath !== selectedTestPath) throw new Error("Eris property-test inspection proof is not bound to the selected test path.");
  safePath(proof.target, "property target");
  if (proof.invariant.length < 1 || proof.invariant.length > 4_096 || proof.invariant.trim() !== proof.invariant) throw new Error("Eris property-test inspection invariant is malformed.");
  return { ...request, selectedTestPath, observedTestPaths, propertyProof: proof };
}

function parseFact(value: unknown, expectedPath: string, request: GeneratedTestQualityInspectionRequest): ErisPropertyTestQualityFact {
  const fact = exactRecord(value, [
    "executedInputCount", "failedInvariantCheckCount", "generatorCount", "invariantAssertionCount", "invariantCheckCount", "iterationMode", "iterationOverrideCount",
    "path", "propertyCount", "sha256", "signals", "targetExecutionCount", "targetInvocationCount", "testTraitCount", "thenCount", "unsupportedGeneratorCount",
  ], "Eris property-test fact");
  if (fact.path !== expectedPath) throw new Error("Eris property-test fact is not bound to its observed path.");
  if (typeof fact.sha256 !== "string" || !digestPattern.test(fact.sha256) || fact.sha256 !== request.baselineLifecycle.testSha256[expectedPath]) {
    throw new Error("Eris property-test fact is not bound to baseline source identity.");
  }
  const testTraitCount = metric(fact.testTraitCount, "test-trait count");
  const propertyCount = metric(fact.propertyCount, "property count");
  const generatorCount = metric(fact.generatorCount, "generator count");
  const unsupportedGeneratorCount = metric(fact.unsupportedGeneratorCount, "unsupported-generator count");
  const thenCount = metric(fact.thenCount, "then count");
  const targetInvocationCount = metric(fact.targetInvocationCount, "target-invocation count");
  const invariantAssertionCount = metric(fact.invariantAssertionCount, "invariant-assertion count");
  const iterationOverrideCount = metric(fact.iterationOverrideCount, "iteration-override count");
  if (fact.iterationMode !== "eris-default-100") throw new Error("Eris property-test iteration mode is unsupported.");
  const selected = expectedPath === request.propertyProof!.testPath;
  const proof = request.propertyProof!;
  const executedInputCount = metric(fact.executedInputCount, "executed-input count");
  const targetExecutionCount = metric(fact.targetExecutionCount, "target-execution count");
  const invariantCheckCount = metric(fact.invariantCheckCount, "invariant-check count");
  const failedInvariantCheckCount = metric(fact.failedInvariantCheckCount, "failed-invariant count");
  const expectedCounts = selected
    ? [proof.inputDigests.length, proof.targetExecutionCount, proof.invariantCheckCount, proof.failedInvariantCheckCount]
    : [0, 0, 0, 0];
  if (![executedInputCount, targetExecutionCount, invariantCheckCount, failedInvariantCheckCount].every((count, index) => count === expectedCounts[index])) {
    throw new Error("Eris property-test fact does not match the property execution proof.");
  }
  if (!Array.isArray(fact.signals) || fact.signals.length > erisPropertyTestQualitySignals.length
    || fact.signals.some((signal) => !erisPropertyTestQualitySignals.includes(signal as ErisPropertyTestQualitySignal))
    || new Set(fact.signals).size !== fact.signals.length) throw new Error("Eris property-test quality signals are malformed.");
  const signals = fact.signals as ErisPropertyTestQualitySignal[];
  const expectedSignals: ErisPropertyTestQualitySignal[] = [];
  if (selected && testTraitCount < 1) expectedSignals.push("missing-test-trait");
  if (selected && generatorCount < 1) expectedSignals.push("missing-generator");
  if (selected && unsupportedGeneratorCount > 0) expectedSignals.push("unsupported-generator");
  if (selected && (propertyCount < 1 || thenCount !== propertyCount)) expectedSignals.push("missing-property-execution");
  if (selected && iterationOverrideCount > 0) expectedSignals.push("unsupported-iteration-override");
  if (selected && targetInvocationCount < propertyCount) expectedSignals.push("missing-target-invocation");
  if (selected && invariantAssertionCount < propertyCount) expectedSignals.push("missing-invariant-check");
  for (const signal of expectedSignals) if (!signals.includes(signal)) throw new Error("Eris property-test quality signals are inconsistent with their metrics.");
  for (const signal of signals) if (!expectedSignals.includes(signal)) throw new Error("Eris property-test quality signals are inconsistent with their metrics.");
  return { path: expectedPath, sha256: fact.sha256, testTraitCount, propertyCount, generatorCount, unsupportedGeneratorCount, thenCount, targetInvocationCount, invariantAssertionCount, iterationOverrideCount, iterationMode: "eris-default-100", executedInputCount, targetExecutionCount, invariantCheckCount, failedInvariantCheckCount, signals };
}

interface PropertyStructures {
  readonly propertyCount: number;
  readonly generatorCount: number;
  readonly unsupportedGeneratorCount: number;
  readonly thenCount: number;
  readonly targetInvocationCount: number;
  readonly invariantAssertionCount: number;
  readonly iterationOverrideCount: number;
}

function inspectPropertyStructures(tokens: readonly string[], target: string): PropertyStructures {
  let propertyCount = 0;
  let generatorCount = 0;
  let unsupportedGeneratorCount = 0;
  let thenCount = 0;
  let targetInvocationCount = 0;
  let invariantAssertionCount = 0;
  const iterationOverrideCount = countCalls(tokens, new Set(["limitto", "erisrepeat"]));
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index]?.toLowerCase() !== "forall" || tokens[index + 1] !== "(") continue;
    propertyCount++;
    const argumentsEnd = matching(tokens, index + 1, "(", ")");
    const argumentsTokens = tokens.slice(index + 2, argumentsEnd);
    const generators = inspectGeneratorCalls(argumentsTokens);
    generatorCount += generators.supported;
    unsupportedGeneratorCount += generators.unsupported;
    if (generators.supported < 1 || containsDynamicGenerator(argumentsTokens)) unsupportedGeneratorCount++;
    if (tokens[argumentsEnd + 1] !== "->" || tokens[argumentsEnd + 2]?.toLowerCase() !== "then" || tokens[argumentsEnd + 3] !== "(") continue;
    thenCount++;
    const thenEnd = matching(tokens, argumentsEnd + 3, "(", ")");
    const thenTokens = tokens.slice(argumentsEnd + 4, thenEnd);
    targetInvocationCount += countTargetInvocations(thenTokens, target);
    invariantAssertionCount += countAssertions(thenTokens);
    index = thenEnd;
  }
  return { propertyCount, generatorCount, unsupportedGeneratorCount, thenCount, targetInvocationCount, invariantAssertionCount, iterationOverrideCount };
}

function countErisTestTraits(tokens: readonly string[]): number {
  let count = 0;
  let braceDepth = 0;
  let classSeen = false;
  for (let index = 0; index < tokens.length - 2; index++) {
    if (tokens[index]?.toLowerCase() === "class") classSeen = true;
    if (tokens[index] === "{") braceDepth++;
    if (tokens[index] === "}") braceDepth--;
    if (tokens[index]?.toLowerCase() !== "use" || !classSeen || braceDepth < 1) continue;
    const statement = tokens.slice(index + 1, tokens.indexOf(";", index + 1) < 0 ? tokens.length : tokens.indexOf(";", index + 1)).join("").replace(/^\\/u, "").toLowerCase();
    if (statement === "eris\\testtrait" || statement === "testtrait") count++;
  }
  return count;
}

function inspectGeneratorCalls(tokens: readonly string[]): { supported: number; unsupported: number } {
  let supported = 0;
  let unsupported = 0;
  for (let index = 0; index < tokens.length - 3; index++) {
    const current = tokens[index]?.toLowerCase();
    if (current !== "generators" || tokens[index + 1] !== "::" || !isIdentifier(tokens[index + 2]!) || tokens[index + 3] !== "(") continue;
    if (supportedGeneratorFactories.has(tokens[index + 2]!.toLowerCase())) supported++;
    else unsupported++;
  }
  return { supported, unsupported };
}

function containsDynamicGenerator(tokens: readonly string[]): boolean {
  return tokens.some((token, index) => token === "$" && isIdentifier(tokens[index + 1] ?? ""));
}

function countTargetInvocations(tokens: readonly string[], target: string): number {
  let count = 0;
  let targetConstructed = false;
  for (let index = 0; index < tokens.length - 2; index++) {
    if (tokens[index]?.toLowerCase() === "new" && tokens[index + 1]?.toLowerCase() === target.toLowerCase() && tokens[index + 2] === "(") targetConstructed = true;
    if (tokens[index]?.toLowerCase() === target.toLowerCase() && tokens[index + 1] === "::" && isIdentifier(tokens[index + 2] ?? "") && tokens[index + 3] === "(") count++;
    if (targetConstructed && tokens[index] === "->" && isIdentifier(tokens[index + 1] ?? "") && tokens[index + 2] === "(") count++;
  }
  return count;
}

function countAssertions(tokens: readonly string[]): number {
  let count = 0;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index]?.toLowerCase() ?? "";
    if ((/^assert[A-Za-z0-9_]*$/iu.test(token) || token === "expect") && tokens[index + 1] === "(") count++;
    if (tokens[index] === "->" && /^(?:to|and)[A-Za-z0-9_]+$/iu.test(tokens[index + 1] ?? "") && tokens[index + 2] === "(") count++;
  }
  return count;
}

function targetSymbol(path: string): string {
  return basename(path, extname(path));
}

async function readBoundedSource(root: string, path: string): Promise<string> {
  const absolute = join(root, path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile()) throw new Error(`Eris generated test must be a regular file: ${path}.`);
  if (metadata.size < 1 || metadata.size > maximumSourceBytes) throw new Error(`Eris generated test must contain 1-${maximumSourceBytes} bytes: ${path}.`);
  return await readFile(absolute, "utf8");
}

function tokenizePhp(source: string): readonly string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if (/\s/u.test(current)) { index++; continue; }
    if ((current === "/" && next === "/") || current === "#") { while (index < source.length && source[index] !== "\n") index++; continue; }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Eris generated test has malformed lexical structure.");
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
      if (!closed) throw new Error("Eris generated test has malformed lexical structure.");
      tokens.push("STRING"); continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/u)?.[0];
    if (identifier) { tokens.push(identifier); index += identifier.length; continue; }
    const three = source.slice(index, index + 3);
    const two = source.slice(index, index + 2);
    if (three === "..." || ["->", "=>", "::", "#["].includes(two)) {
      const token = three === "..." ? three : two; tokens.push(token); index += token.length; continue;
    }
    tokens.push(current); index++;
    if (tokens.length > maximumTokens) throw new Error(`Eris generated test exceeds ${maximumTokens} lexical tokens.`);
  }
  validateBalancedSyntax(tokens);
  return tokens;
}

function validateBalancedSyntax(tokens: readonly string[]): void {
  const openings: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (const token of tokens) {
    if (openings[token]) stack.push(openings[token]!);
    else if ([")", "]", "}"].includes(token) && stack.pop() !== token) throw new Error("Eris generated test has malformed lexical structure.");
  }
  if (stack.length > 0) throw new Error("Eris generated test has malformed lexical structure.");
}

function matching(tokens: readonly string[], start: number, opening: string, closing: string): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index] === opening) depth++;
    if (tokens[index] === closing && --depth === 0) return index;
  }
  throw new Error("Eris generated test has malformed lexical structure.");
}

function countCalls(tokens: readonly string[], names: ReadonlySet<string>): number {
  let count = 0;
  for (let index = 0; index < tokens.length - 1; index++) if (names.has(tokens[index]!.toLowerCase()) && (tokens[index + 1] === "(" || tokens[index + 1] === "#[")) count++;
  return count;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function safePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !safePathPattern.test(value)) throw new Error(`Eris property-test inspection ${name} is malformed.`);
  return value;
}

function digest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function metric(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximumMetric) throw new Error(`Eris property-test ${name} is out of bounds.`);
  return value as number;
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an exact object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (!sameArray(actual, expected)) throw new Error(`${name} must have an exact schema.`);
  return record;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((entry) => typeof entry !== "string")) throw new Error(`Eris property-test ${name} are malformed.`);
  return value as string[];
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
