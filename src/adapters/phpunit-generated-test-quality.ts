import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterGeneratedTestQualityInspection,
  GeneratedTestQualityInspectionRequest,
} from "../contracts.js";

export const phpunitGeneratedTestQualitySchemaVersion = "phpunit-generated-test-quality-inspection/v1" as const;

export const phpunitGeneratedTestQualitySignals = [
  "skipped-test",
  "incomplete-test",
  "assertion-free-test",
  "empty-data-provider",
  "unsupported-data-provider",
] as const;

export type PhpunitGeneratedTestQualitySignal = (typeof phpunitGeneratedTestQualitySignals)[number];

export interface PhpunitGeneratedTestQualityFact {
  readonly path: string;
  readonly sha256: string;
  readonly testClassCount: number;
  readonly declarationCount: number;
  readonly conventionDeclarationCount: number;
  readonly attributeDeclarationCount: number;
  readonly docblockDeclarationCount: number;
  readonly assertionExpressionCount: number;
  readonly assertionFreeDeclarationCount: number;
  readonly lifecycleAssertionCount: number;
  readonly skippedCount: number;
  readonly incompleteCount: number;
  readonly dataProviderCount: number;
  readonly dataProviderCaseCount: number;
  readonly emptyDataProviderCount: number;
  readonly unsupportedDataProviderCount: number;
  readonly dataProviderCoverage: "not-applicable" | "covered";
  readonly signals: readonly PhpunitGeneratedTestQualitySignal[];
}

export interface PhpunitGeneratedTestQualityInspection extends AdapterGeneratedTestQualityInspection {
  readonly schemaVersion: typeof phpunitGeneratedTestQualitySchemaVersion;
  readonly adapter: "php";
  readonly framework: "phpunit";
  readonly lifecycleSchemaVersion: "generated-test-lifecycle-decision/v1";
  readonly lifecyclePhase: "baseline";
  readonly lifecycleAttempts: 3;
  readonly observedTestPaths: readonly string[];
  readonly tests: readonly PhpunitGeneratedTestQualityFact[];
  readonly outcome: "accepted" | "rejected";
}

interface Method {
  readonly name: string;
  readonly prefix: readonly Token[];
  readonly body: readonly Token[];
  readonly isPublic: boolean;
}

interface Token {
  readonly kind: "symbol" | "identifier" | "string" | "docblock";
  readonly value: string;
}

const maximumSourceBytes = 256_000;
const maximumTokens = 40_000;
const maximumMetric = 1_000_000;
const safePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\x00-\x1f\x7f]{1,240}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

export async function inspectPhpunitGeneratedTestQuality(
  request: GeneratedTestQualityInspectionRequest,
): Promise<PhpunitGeneratedTestQualityInspection> {
  const expected = validateRequest(request);
  const tests = await Promise.all(expected.observedTestPaths.map(async (path) => {
    const source = await readBoundedSource(expected.root, path);
    const sha256 = digest(source);
    if (expected.baselineLifecycle.testSha256[path] !== sha256) {
      throw new Error(`PHPUnit generated-test inspection is not bound to baseline source: ${path}.`);
    }
    const tokens = tokenizePhp(source);
    const testClasses = testClassBodies(tokens);
    const testClassCount = testClasses.length;
    if (testClassCount < 1) throw new Error(`PHPUnit generated test has unsupported test-class discovery syntax: ${path}.`);
    const classMethods = testClasses.map(parseMethods);
    const declarations = classMethods.flatMap((methods) => methods.map(classifyDeclaration).filter((value): value is NonNullable<typeof value> => value !== undefined));
    if (declarations.length < 1) throw new Error(`PHPUnit generated test has unsupported test-method discovery syntax: ${path}.`);
    if (declarations.some((declaration) => !declaration.method.isPublic)) {
      throw new Error(`PHPUnit generated test contains a non-public discovered test method: ${path}.`);
    }
    let assertionExpressionCount = 0;
    let skippedCount = 0;
    let incompleteCount = 0;
    let dataProviderCount = 0;
    let dataProviderCaseCount = 0;
    let emptyDataProviderCount = 0;
    let unsupportedDataProviderCount = 0;
    let assertionFreeDeclarations = 0;
    for (const methods of classMethods) {
      const providerMethods = new Map(methods.map((method) => [method.name.toLowerCase(), method]));
      const classDeclarations = methods.map(classifyDeclaration).filter((value): value is NonNullable<typeof value> => value !== undefined);
      for (const declaration of classDeclarations) {
        const assertions = countAssertions(declaration.method.body);
        assertionExpressionCount += assertions;
        if (assertions < 1) assertionFreeDeclarations++;
        skippedCount += countCalls(declaration.method.body, new Set(["marktestskipped"]));
        incompleteCount += countCalls(declaration.method.body, new Set(["marktestincomplete"]));
        const providers = inspectProviders(declaration.method, providerMethods);
        dataProviderCount += providers.count;
        dataProviderCaseCount += providers.caseCount;
        emptyDataProviderCount += providers.emptyCount;
        unsupportedDataProviderCount += providers.unsupportedCount;
      }
    }
    const lifecycleAssertionCount = lifecycleAssertions(expected.baselineLifecycle, path);
    const signals: PhpunitGeneratedTestQualitySignal[] = [];
    if (skippedCount > 0) signals.push("skipped-test");
    if (incompleteCount > 0) signals.push("incomplete-test");
    if (assertionFreeDeclarations > 0 || lifecycleAssertionCount < declarations.length) signals.push("assertion-free-test");
    if (emptyDataProviderCount > 0) signals.push("empty-data-provider");
    if (unsupportedDataProviderCount > 0) signals.push("unsupported-data-provider");
    return {
      path,
      sha256,
      testClassCount,
      declarationCount: declarations.length,
      conventionDeclarationCount: declarations.filter((value) => value.discovery === "convention").length,
      attributeDeclarationCount: declarations.filter((value) => value.discovery === "attribute").length,
      docblockDeclarationCount: declarations.filter((value) => value.discovery === "docblock").length,
      assertionExpressionCount,
      assertionFreeDeclarationCount: assertionFreeDeclarations,
      lifecycleAssertionCount,
      skippedCount,
      incompleteCount,
      dataProviderCount,
      dataProviderCaseCount,
      emptyDataProviderCount,
      unsupportedDataProviderCount,
      dataProviderCoverage: dataProviderCount === 0 ? "not-applicable" as const : "covered" as const,
      signals,
    };
  }));
  return assertPhpunitGeneratedTestQualityInspection({
    schemaVersion: phpunitGeneratedTestQualitySchemaVersion,
    adapter: "php",
    framework: "phpunit",
    selectedTestPath: expected.selectedTestPath,
    lifecycleSchemaVersion: expected.baselineLifecycle.schemaVersion,
    lifecyclePhase: "baseline",
    lifecycleAttempts: 3,
    observedTestPaths: expected.observedTestPaths,
    tests,
    outcome: tests.some((test) => test.signals.length > 0) ? "rejected" : "accepted",
  }, expected);
}

export function assertPhpunitGeneratedTestQualityInspection(
  value: unknown,
  request: GeneratedTestQualityInspectionRequest,
): PhpunitGeneratedTestQualityInspection {
  const expected = validateRequest(request);
  const inspection = exactRecord(value, [
    "adapter", "framework", "lifecycleAttempts", "lifecyclePhase", "lifecycleSchemaVersion", "observedTestPaths",
    "outcome", "schemaVersion", "selectedTestPath", "tests",
  ], "PHPUnit generated-test inspection");
  if (inspection.schemaVersion !== phpunitGeneratedTestQualitySchemaVersion || inspection.adapter !== "php" || inspection.framework !== "phpunit") {
    throw new Error("PHPUnit generated-test inspection has an unsupported identity or schema version.");
  }
  if (inspection.selectedTestPath !== expected.selectedTestPath) throw new Error("PHPUnit generated-test inspection is not bound to the selected test path.");
  if (inspection.lifecycleSchemaVersion !== expected.baselineLifecycle.schemaVersion || inspection.lifecyclePhase !== "baseline" || inspection.lifecycleAttempts !== 3) {
    throw new Error("PHPUnit generated-test inspection is not bound to the baseline lifecycle.");
  }
  const observedTestPaths = stringArray(inspection.observedTestPaths, "observed test paths");
  if (!sameArray(observedTestPaths, expected.observedTestPaths)) throw new Error("PHPUnit generated-test inspection does not cover the lifecycle test paths.");
  if (!Array.isArray(inspection.tests) || inspection.tests.length !== observedTestPaths.length) throw new Error("PHPUnit generated-test inspection has an invalid test collection.");
  const tests = inspection.tests.map((test, index) => parseFact(test, observedTestPaths[index]!, expected));
  const outcome = tests.some((test) => test.signals.length > 0) ? "rejected" : "accepted";
  if (inspection.outcome !== outcome) throw new Error("PHPUnit generated-test inspection outcome is inconsistent.");
  return {
    schemaVersion: phpunitGeneratedTestQualitySchemaVersion,
    adapter: "php",
    framework: "phpunit",
    selectedTestPath: expected.selectedTestPath,
    lifecycleSchemaVersion: "generated-test-lifecycle-decision/v1",
    lifecyclePhase: "baseline",
    lifecycleAttempts: 3,
    observedTestPaths,
    tests,
    outcome,
  };
}

export function requireAcceptedPhpunitGeneratedTestQuality(inspection: PhpunitGeneratedTestQualityInspection): void {
  if (inspection.outcome === "rejected") {
    const signals = inspection.tests.flatMap((test) => test.signals.map((signal) => `${test.path}:${signal}`));
    throw new Error(`Generated PHPUnit test failed quality inspection: ${signals.join(", ")}.`);
  }
}

function validateRequest(request: GeneratedTestQualityInspectionRequest): GeneratedTestQualityInspectionRequest {
  if (request.framework !== "phpunit") throw new Error("PHPUnit generated-test inspection requires the PHPUnit framework.");
  if (typeof request.root !== "string" || request.root.length === 0) throw new Error("PHPUnit generated-test inspection root is malformed.");
  const selectedTestPath = safePath(request.selectedTestPath, "selected test path");
  const observedTestPaths = request.observedTestPaths.map((path) => safePath(path, "observed test path")).sort();
  if (observedTestPaths.length < 1 || observedTestPaths.length > 32 || new Set(observedTestPaths).size !== observedTestPaths.length || !observedTestPaths.includes(selectedTestPath)) {
    throw new Error("PHPUnit generated-test inspection path selection is malformed.");
  }
  const lifecycle = request.baselineLifecycle;
  if (lifecycle.schemaVersion !== "generated-test-lifecycle-decision/v1" || lifecycle.phase !== "baseline" || lifecycle.outcome !== "accepted" || lifecycle.attempts.length !== 3) {
    throw new Error("PHPUnit generated-test inspection requires an accepted three-attempt baseline lifecycle.");
  }
  if (!sameArray(Object.keys(lifecycle.testSha256).sort(), observedTestPaths)) throw new Error("PHPUnit generated-test inspection paths are not bound to baseline lifecycle hashes.");
  return { ...request, selectedTestPath, observedTestPaths };
}

function parseFact(value: unknown, expectedPath: string, request: GeneratedTestQualityInspectionRequest): PhpunitGeneratedTestQualityFact {
  const fact = exactRecord(value, [
    "assertionExpressionCount", "assertionFreeDeclarationCount", "attributeDeclarationCount", "conventionDeclarationCount", "dataProviderCaseCount", "dataProviderCount",
    "dataProviderCoverage", "declarationCount", "docblockDeclarationCount", "emptyDataProviderCount", "incompleteCount",
    "lifecycleAssertionCount", "path", "sha256", "signals", "skippedCount", "testClassCount", "unsupportedDataProviderCount",
  ], "PHPUnit generated-test fact");
  if (fact.path !== expectedPath) throw new Error("PHPUnit generated-test fact is not bound to its observed path.");
  if (typeof fact.sha256 !== "string" || !digestPattern.test(fact.sha256) || fact.sha256 !== request.baselineLifecycle.testSha256[expectedPath]) {
    throw new Error("PHPUnit generated-test fact is not bound to baseline source identity.");
  }
  const testClassCount = positiveMetric(fact.testClassCount, "test class count");
  const declarationCount = positiveMetric(fact.declarationCount, "declaration count");
  const conventionDeclarationCount = metric(fact.conventionDeclarationCount, "convention declaration count");
  const attributeDeclarationCount = metric(fact.attributeDeclarationCount, "attribute declaration count");
  const docblockDeclarationCount = metric(fact.docblockDeclarationCount, "docblock declaration count");
  if (conventionDeclarationCount + attributeDeclarationCount + docblockDeclarationCount !== declarationCount) throw new Error("PHPUnit generated-test discovery metrics are inconsistent.");
  const assertionExpressionCount = metric(fact.assertionExpressionCount, "assertion expression count");
  const assertionFreeDeclarationCount = metric(fact.assertionFreeDeclarationCount, "assertion-free declaration count");
  if (assertionFreeDeclarationCount > declarationCount) throw new Error("PHPUnit generated-test assertion metrics are inconsistent.");
  const lifecycleAssertionCount = metric(fact.lifecycleAssertionCount, "lifecycle assertion count");
  if (lifecycleAssertionCount !== lifecycleAssertions(request.baselineLifecycle, expectedPath)) throw new Error("PHPUnit generated-test fact does not match lifecycle assertions.");
  const skippedCount = metric(fact.skippedCount, "skipped count");
  const incompleteCount = metric(fact.incompleteCount, "incomplete count");
  const dataProviderCount = metric(fact.dataProviderCount, "data-provider count");
  const dataProviderCaseCount = metric(fact.dataProviderCaseCount, "data-provider case count");
  const emptyDataProviderCount = metric(fact.emptyDataProviderCount, "empty data-provider count");
  const unsupportedDataProviderCount = metric(fact.unsupportedDataProviderCount, "unsupported data-provider count");
  if (emptyDataProviderCount + unsupportedDataProviderCount > dataProviderCount) throw new Error("PHPUnit generated-test provider classifications are unbounded.");
  const dataProviderCoverage = fact.dataProviderCoverage;
  if ((dataProviderCount === 0 && (dataProviderCoverage !== "not-applicable" || dataProviderCaseCount !== 0))
    || (dataProviderCount > 0 && dataProviderCoverage !== "covered")) throw new Error("PHPUnit generated-test data-provider coverage is inconsistent.");
  if (!Array.isArray(fact.signals) || fact.signals.length > phpunitGeneratedTestQualitySignals.length
    || fact.signals.some((signal) => !phpunitGeneratedTestQualitySignals.includes(signal as PhpunitGeneratedTestQualitySignal))
    || new Set(fact.signals).size !== fact.signals.length) throw new Error("PHPUnit generated-test quality signals are malformed.");
  const signals = fact.signals as PhpunitGeneratedTestQualitySignal[];
  if ((skippedCount > 0) !== signals.includes("skipped-test")
    || (incompleteCount > 0) !== signals.includes("incomplete-test")
    || (assertionFreeDeclarationCount > 0 || lifecycleAssertionCount < declarationCount) !== signals.includes("assertion-free-test")
    || (emptyDataProviderCount > 0) !== signals.includes("empty-data-provider")
    || (unsupportedDataProviderCount > 0) !== signals.includes("unsupported-data-provider")) {
    throw new Error("PHPUnit generated-test quality signals are inconsistent with their metrics.");
  }
  if (dataProviderCount > 0 && dataProviderCaseCount < dataProviderCount && emptyDataProviderCount === 0 && unsupportedDataProviderCount === 0) {
    throw new Error("PHPUnit generated-test provider signals are inconsistent with their coverage.");
  }
  return { path: expectedPath, sha256: fact.sha256, testClassCount, declarationCount, conventionDeclarationCount, attributeDeclarationCount, docblockDeclarationCount, assertionExpressionCount, assertionFreeDeclarationCount, lifecycleAssertionCount, skippedCount, incompleteCount, dataProviderCount, dataProviderCaseCount, emptyDataProviderCount, unsupportedDataProviderCount, dataProviderCoverage: dataProviderCoverage as "not-applicable" | "covered", signals };
}

function classifyDeclaration(method: Method): { method: Method; discovery: "convention" | "attribute" | "docblock" } | undefined {
  if (/^test[A-Za-z0-9_]*$/u.test(method.name)) return { method, discovery: "convention" };
  if (hasAttribute(method.prefix, "test")) return { method, discovery: "attribute" };
  if (method.prefix.some((token) => token.kind === "docblock" && /(?:^|\s)@test(?:\s|$)/iu.test(token.value))) return { method, discovery: "docblock" };
  return undefined;
}

function inspectProviders(method: Method, methods: ReadonlyMap<string, Method>): { count: number; caseCount: number; emptyCount: number; unsupportedCount: number } {
  let count = 0;
  let caseCount = 0;
  let emptyCount = 0;
  let unsupportedCount = 0;
  const named = providerNames(method.prefix);
  for (const name of named.names) {
    count++;
    const provider = methods.get(name.toLowerCase());
    const cases = provider ? providerCaseCount(provider.body) : undefined;
    if (cases === undefined) unsupportedCount++;
    else if (cases === 0) emptyCount++;
    else caseCount += cases;
  }
  count += named.unsupported;
  unsupportedCount += named.unsupported;
  const inline = inlineProviderCases(method.prefix);
  count += inline.count;
  caseCount += inline.caseCount;
  emptyCount += inline.emptyCount;
  unsupportedCount += inline.unsupportedCount;
  return { count, caseCount, emptyCount, unsupportedCount };
}

function providerNames(prefix: readonly Token[]): { names: readonly string[]; unsupported: number } {
  const names: string[] = [];
  let unsupported = 0;
  for (const token of prefix) {
    if (token.kind !== "docblock") continue;
    const matches = [...token.value.matchAll(/@dataProvider\s+([A-Za-z_][A-Za-z0-9_]*)/giu)];
    for (const match of matches) names.push(match[1]!);
    const declarations = token.value.match(/@dataProvider\b/giu)?.length ?? 0;
    unsupported += declarations - matches.length;
    unsupported += token.value.match(/@testWith\b/giu)?.length ?? 0;
  }
  for (let index = 0; index < prefix.length; index++) {
    if (identifier(prefix[index]) === "dataproviderexternal") unsupported++;
    if (identifier(prefix[index]) === "testwithjson") unsupported++;
    if (identifier(prefix[index]) !== "dataprovider" || prefix[index + 1]?.value !== "(") continue;
    const closing = matching(prefix, index + 1, "(", ")");
    const argument = prefix[index + 2];
    if (closing === index + 3 && argument?.kind === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(argument.value)) names.push(argument.value);
    else unsupported++;
    index = closing;
  }
  return { names, unsupported };
}

function inlineProviderCases(prefix: readonly Token[]): { count: number; caseCount: number; emptyCount: number; unsupportedCount: number } {
  let count = 0;
  let caseCount = 0;
  let emptyCount = 0;
  let unsupportedCount = 0;
  for (let index = 0; index < prefix.length; index++) {
    if (identifier(prefix[index]) !== "testwith" || prefix[index + 1]?.value !== "(") continue;
    count++;
    const closing = matching(prefix, index + 1, "(", ")");
    const argument = prefix.slice(index + 2, closing);
    if (argument[0]?.value !== "[" || argument.at(-1)?.value !== "]") unsupportedCount++;
    else if (topLevelElements(argument.slice(1, -1), "[", "]") < 1) emptyCount++;
    else caseCount++;
    index = closing;
  }
  return { count, caseCount, emptyCount, unsupportedCount };
}

function providerCaseCount(body: readonly Token[]): number | undefined {
  let cases = 0;
  for (let index = 0; index < body.length; index++) {
    const current = identifier(body[index]);
    if (current === "yield") cases++;
    if (current !== "return") continue;
    const value = body[index + 1];
    if (value?.value !== "[") return undefined;
    const closing = matching(body, index + 1, "[", "]");
    if (body[closing + 1]?.value !== ";") return undefined;
    const entries = body.slice(index + 2, closing);
    if (entries.some((token) => token.value === "..." || token.value === "$")) return undefined;
    cases += topLevelElements(entries, "[", "]");
  }
  for (let index = 0; index < body.length - 1; index++) if (identifier(body[index]) === "yield" && identifier(body[index + 1]) === "from") return undefined;
  if (cases === 0 && body.some((token) => identifier(token) === "return" || identifier(token) === "yield")) return 0;
  return cases > 0 ? cases : undefined;
}

function testClassBodies(tokens: readonly Token[]): readonly (readonly Token[])[] {
  const bodies: Token[][] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (identifier(tokens[index]) !== "class") continue;
    const opening = tokens.slice(index).findIndex((token) => token.value === "{");
    if (opening < 0) continue;
    const header = tokens.slice(index, index + opening);
    const extendsIndex = header.findIndex((token) => identifier(token) === "extends");
    const bodyStart = index + opening;
    const bodyEnd = matching(tokens, bodyStart, "{", "}");
    if (extendsIndex >= 0 && header.slice(extendsIndex + 1).some((token) => identifier(token) === "testcase")) {
      bodies.push(tokens.slice(bodyStart + 1, bodyEnd));
    }
    index = bodyEnd;
  }
  return bodies;
}

function parseMethods(tokens: readonly Token[]): readonly Method[] {
  const methods: Method[] = [];
  let boundary = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (identifier(tokens[index]) !== "function") continue;
    const name = tokens[index + 1];
    if (name?.kind !== "identifier" || tokens[index + 2]?.value !== "(") continue;
    const parametersEnd = matching(tokens, index + 2, "(", ")");
    let bodyStart = parametersEnd + 1;
    while (bodyStart < tokens.length && tokens[bodyStart]?.value !== "{" && tokens[bodyStart]?.value !== ";") bodyStart++;
    if (tokens[bodyStart]?.value !== "{") continue;
    const bodyEnd = matching(tokens, bodyStart, "{", "}");
    const prefix = tokens.slice(boundary, index);
    methods.push({ name: name.value, prefix, body: tokens.slice(bodyStart + 1, bodyEnd), isPublic: !prefix.some((token) => identifier(token) === "private" || identifier(token) === "protected") });
    boundary = bodyEnd + 1;
    index = bodyEnd;
  }
  return methods;
}

function countAssertions(tokens: readonly Token[]): number {
  let count = 0;
  for (let index = 0; index < tokens.length - 1; index++) {
    const name = tokens[index]?.kind === "identifier" ? tokens[index]!.value : "";
    if (tokens[index + 1]?.value === "(" && (name === "fail" || /^assert[A-Z][A-Za-z0-9_]*$/u.test(name) || /^expectException(?:Code|Message|MessageMatches|Object)?$/u.test(name))) count++;
  }
  return count;
}

function countCalls(tokens: readonly Token[], names: ReadonlySet<string>): number {
  let count = 0;
  for (let index = 0; index < tokens.length - 1; index++) if (names.has(identifier(tokens[index])) && tokens[index + 1]?.value === "(") count++;
  return count;
}

async function readBoundedSource(root: string, path: string): Promise<string> {
  const absolute = join(root, path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile()) throw new Error(`PHPUnit generated test must be a regular file: ${path}.`);
  if (metadata.size < 1 || metadata.size > maximumSourceBytes) throw new Error(`PHPUnit generated test must contain 1-${maximumSourceBytes} bytes: ${path}.`);
  return await readFile(absolute, "utf8");
}

function tokenizePhp(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if (/\s/u.test(current)) { index++; continue; }
    if (current === "/" && next === "/" || current === "#" && next !== "[") { while (index < source.length && source[index] !== "\n") index++; continue; }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("PHPUnit generated test has an unclosed block comment.");
      if (source[index + 2] === "*") tokens.push({ kind: "docblock", value: source.slice(index + 3, end) });
      index = end + 2; continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      index++;
      let value = "";
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") { value += source[index + 1] ?? ""; index += 2; continue; }
        if (source[index] === quote) { index++; closed = true; break; }
        value += source[index]!; index++;
      }
      if (!closed) throw new Error("PHPUnit generated test has an unclosed string.");
      tokens.push({ kind: "string", value }); continue;
    }
    const word = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/u)?.[0];
    if (word) { tokens.push({ kind: "identifier", value: word }); index += word.length; continue; }
    const multi = source.slice(index, index + 3);
    const symbol = multi === "..." ? multi : ["->", "=>", "::", "#["].includes(multi.slice(0, 2)) ? multi.slice(0, 2) : current;
    tokens.push({ kind: "symbol", value: symbol });
    index += symbol.length;
    if (tokens.length > maximumTokens) throw new Error(`PHPUnit generated test exceeds ${maximumTokens} lexical tokens.`);
  }
  if (tokens.length > maximumTokens) throw new Error(`PHPUnit generated test exceeds ${maximumTokens} lexical tokens.`);
  validateBalancedSyntax(tokens);
  return tokens;
}

function hasAttribute(tokens: readonly Token[], name: string): boolean {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.value !== "#[") continue;
    const closing = matching(tokens, index, "[", "]");
    if (tokens.slice(index + 1, closing).some((token) => identifier(token) === name)) return true;
    index = closing;
  }
  return false;
}

function validateBalancedSyntax(tokens: readonly Token[]): void {
  const stack: string[] = [];
  const matchingOpen: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
  for (const token of tokens) {
    const value = token.value === "#[" ? "[" : token.value;
    if (value === "(" || value === "[" || value === "{") stack.push(value);
    if (value === ")" || value === "]" || value === "}") {
      if (stack.pop() !== matchingOpen[value]) throw new Error("PHPUnit generated test has malformed lexical structure.");
    }
  }
  if (stack.length > 0) throw new Error("PHPUnit generated test has malformed lexical structure.");
}

function matching(tokens: readonly Token[], start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const value = tokens[index]?.value === "#[" ? "[" : tokens[index]?.value;
    if (value === open) depth++;
    if (value === close && --depth === 0) return index;
  }
  throw new Error("PHPUnit generated test has unbalanced lexical structure.");
}

function topLevelElements(tokens: readonly Token[], open: string, close: string): number {
  if (tokens.length === 0) return 0;
  let depth = 0;
  let count = 1;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const value = token.value;
    if (value === open || value === "[" || value === "{") depth++;
    else if (value === close || value === "]" || value === "}") depth--;
    else if (value === "," && depth === 0 && index < tokens.length - 1) count++;
  }
  return count;
}

function lifecycleAssertions(lifecycle: GeneratedTestQualityInspectionRequest["baselineLifecycle"], path: string): number {
  const values = lifecycle.attempts.map((attempt) => attempt.tests.find((test) => test.path === path)?.assertionCount);
  if (values.some((value) => value === undefined) || new Set(values).size !== 1) throw new Error(`PHPUnit generated-test inspection lifecycle metrics are malformed: ${path}.`);
  return values[0] as number;
}

function safePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !safePathPattern.test(value) || !value.endsWith(".php")) throw new Error(`PHPUnit generated-test inspection ${name} is malformed.`);
  return value;
}

function metric(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximumMetric) throw new Error(`PHPUnit generated-test inspection ${name} is malformed.`);
  return value as number;
}

function positiveMetric(value: unknown, name: string): number {
  const result = metric(value, name);
  if (result < 1) throw new Error(`PHPUnit generated-test inspection ${name} must be positive.`);
  return result;
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((item) => typeof item !== "string" || !safePathPattern.test(item))) throw new Error(`PHPUnit generated-test inspection ${name} are malformed.`);
  return value as string[];
}

function identifier(token: Token | undefined): string { return token?.kind === "identifier" ? token.value.toLowerCase() : ""; }
function digest(source: string): string { return createHash("sha256").update(source).digest("hex"); }
function sameArray(left: readonly string[], right: readonly string[]): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an exact object.`);
  const record = value as Record<string, unknown>;
  if (!sameArray(Object.keys(record).sort(), [...keys].sort())) throw new Error(`${name} must have an exact schema.`);
  return record;
}
