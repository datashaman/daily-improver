import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  TestExecutionStatus,
  TestExpectationStrength,
  TestStrengthEntry,
  TestStrengthPlan,
  TestStrengthResult,
} from "../domain/test-strength.js";
import { testStrengthHash } from "../domain/test-strength.js";

const targetPaths = ["tests"] as const;
const testIdentitySemantics = "php-test-declaration/v1";
const expectationIdentitySemantics = "php-test-expectation-position/v1";
const caseIdentitySemantics = "php-test-data-case/v1";
const maximumFiles = 20_000;
const maximumFileBytes = 512_000;
const maximumAggregateBytes = 64 * 1024 * 1024;
const maximumTests = 100_000;
const policyIdentity = {
  schemaVersion: "php-test-strength-policy/v1",
  frameworks: ["pest", "phpunit", "php-script"],
  targetPaths,
  testIdentitySemantics,
  expectationIdentitySemantics,
  caseIdentitySemantics,
} as const;
const policySha256 = testStrengthHash(JSON.stringify(policyIdentity));

interface Declaration {
  readonly key: string;
  readonly status: TestExecutionStatus;
  readonly body: string;
  readonly suffix: string;
  readonly cases: readonly string[];
}

interface FunctionDeclaration {
  readonly name: string;
  readonly prefix: string;
  readonly body: string;
}

export async function preparePhpTestStrength(): Promise<TestStrengthPlan> {
  return {
    schemaVersion: "test-strength-plan/v1",
    adapter: "php",
    policySha256,
    targetScope: "adapter-test-sources",
    targetPaths,
  };
}

export async function inspectPhpTestStrength(root: string, plan: TestStrengthPlan): Promise<TestStrengthResult> {
  if (plan.adapter !== "php" || plan.policySha256 !== policySha256
    || JSON.stringify(plan.targetPaths) !== JSON.stringify(targetPaths)) {
    throw new Error("Verifier test-strength plan was redirected or uses an unsupported policy.");
  }
  const paths = await testFiles(root);
  let aggregateBytes = 0;
  const tests: TestStrengthEntry[] = [];
  for (const path of paths) {
    const absolute = join(await realpath(root), path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumFileBytes) {
      throw new Error("Verifier test-strength input is unsupported or excessive.");
    }
    aggregateBytes += metadata.size;
    if (aggregateBytes > maximumAggregateBytes) throw new Error("Verifier test-strength inputs are excessive.");
    const source = await readFile(absolute, "utf8");
    const declarations = inspectDeclarations(source);
    for (const declaration of declarations) {
      const identitySha256 = testStrengthHash(JSON.stringify([testIdentitySemantics, path, declaration.key]));
      const expectations = inspectExpectations(identitySha256, `${declaration.body}\n${declaration.suffix}`);
      const caseIdentities = opaqueCases(identitySha256, declaration.cases);
      tests.push({ identitySha256, status: declaration.status, expectations, caseIdentities });
      if (tests.length > maximumTests) throw new Error("Verifier test-strength inventory is excessive.");
    }
  }
  tests.sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  return {
    schemaVersion: "test-strength-result/v1",
    adapter: "php",
    policySha256,
    targetScope: "adapter-test-sources",
    targetPaths,
    testIdentitySemantics,
    expectationIdentitySemantics,
    caseIdentitySemantics,
    tests,
    inventorySha256: testStrengthHash(JSON.stringify([
      testIdentitySemantics, expectationIdentitySemantics, caseIdentitySemantics, tests,
    ])),
  };
}

async function testFiles(root: string): Promise<readonly string[]> {
  const canonicalRoot = await realpath(root);
  const paths: string[] = [];
  for (const target of targetPaths) {
    const absolute = join(canonicalRoot, target);
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Verifier test-strength target is unsupported: ${target}`);
    }
    await walk(canonicalRoot, absolute, paths);
  }
  if (paths.length > maximumFiles) throw new Error("Verifier test-strength file inventory is excessive.");
  return paths.filter((path) => path.endsWith(".php")).sort();
}

async function walk(root: string, directory: string, paths: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (!path || path.startsWith("../") || path.includes("/../")) throw new Error("Verifier test-strength path escaped the repository.");
    if (entry.isSymbolicLink()) throw new Error("Verifier test-strength input is symbolic.");
    if (entry.isDirectory()) await walk(root, absolute, paths);
    else if (entry.isFile()) paths.push(path);
    else throw new Error("Verifier test-strength input type is unsupported.");
    if (paths.length > maximumFiles) throw new Error("Verifier test-strength file inventory is excessive.");
  }
}

function inspectDeclarations(source: string): readonly Declaration[] {
  const functions = functionDeclarations(source);
  const providers = new Map(functions.map((declaration) => [declaration.name.toLowerCase(), declaration]));
  const className = source.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)[^\{]*(?:extends\s+(?:\\?[A-Za-z_][A-Za-z0-9_]*\\)*TestCase)\b/iu)?.[1];
  const phpunit = functions.filter((declaration) => /^test[A-Za-z0-9_]*$/u.test(declaration.name)
    || /#\[\s*(?:\\?PHPUnit\\Framework\\Attributes\\)?Test\b/iu.test(declaration.prefix)
    || /@test\b/iu.test(declaration.prefix));
  const declarations: Declaration[] = phpunit.map((declaration) => {
    const providerName = dataProviderName(declaration.prefix);
    const provider = providerName ? providers.get(providerName.toLowerCase()) : undefined;
    const cases = provider ? returnedCases(provider.body) : inlinePhpunitCases(declaration.prefix);
    return {
      key: `phpunit:${className ?? "anonymous"}:${declaration.name}`,
      status: phpunitStatus(declaration.prefix, declaration.body),
      body: declaration.body,
      suffix: "",
      cases,
    };
  });
  declarations.push(...pestDeclarations(source));
  if (declarations.length > 0) return declarations;
  return [{
    key: "php-script",
    status: /\b(?:exit|die)\s*\(\s*['"]skip/iu.test(source) ? "skipped" : "executed",
    body: source,
    suffix: "",
    cases: [],
  }];
}

function functionDeclarations(source: string): readonly FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  const pattern = /\b(?:public\s+|protected\s+|private\s+|static\s+|final\s+)*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)[^{;]*\{/giu;
  for (const match of source.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf("{");
    const close = matchingDelimiter(source, open, "{", "}");
    const previousClose = source.lastIndexOf("}", match.index);
    declarations.push({
      name: match[1]!,
      prefix: source.slice(Math.max(previousClose + 1, (match.index ?? 0) - 2_000), match.index),
      body: source.slice(open + 1, close),
    });
  }
  return declarations;
}

function pestDeclarations(source: string): readonly Declaration[] {
  const declarations: Declaration[] = [];
  const pattern = /\b(?:it|test)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*function\b[^\{]*\{/giu;
  for (const match of source.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf("{");
    const close = matchingDelimiter(source, open, "{", "}");
    const semicolon = source.indexOf(";", close);
    const suffix = source.slice(close + 1, semicolon < 0 ? Math.min(source.length, close + 4_000) : semicolon + 1);
    declarations.push({
      key: `pest:${normalize(match[2]!)}`,
      status: /->\s*(?:skip|todo)\s*\(/iu.test(suffix) ? "skipped" : "executed",
      body: source.slice(open + 1, close),
      suffix,
      cases: chainedCases(suffix),
    });
  }
  return declarations;
}

function inspectExpectations(testIdentity: string, body: string): readonly TestExpectationStrength[] {
  const calls: { readonly index: number; readonly strength: number }[] = [];
  const phpunit = /(?:(?:\bself|\bstatic)\s*::|\$this\s*->)\s*((?:assert[A-Za-z0-9_]+|expectException[A-Za-z0-9_]*|fail))\s*\(/giu;
  for (const match of body.matchAll(phpunit)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf("(");
    calls.push({ index: match.index ?? 0, strength: expectationStrength(match[1]!, callArguments(body, open)) });
  }
  const pest = /->\s*((?:to|throws)[A-Za-z0-9_]*)\s*\(/giu;
  for (const match of body.matchAll(pest)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf("(");
    calls.push({ index: match.index ?? 0, strength: expectationStrength(match[1]!, callArguments(body, open)) });
  }
  const scriptAssertions = /\bthrow\s+new\s+(?:\\?[A-Za-z_][A-Za-z0-9_]*\\)*[A-Za-z_][A-Za-z0-9_]*Exception\b/giu;
  for (const match of body.matchAll(scriptAssertions)) calls.push({ index: match.index ?? 0, strength: 1_000_000_000 });
  return calls.sort((left, right) => left.index - right.index).map((call, ordinal) => ({
    identitySha256: testStrengthHash(JSON.stringify([expectationIdentitySemantics, testIdentity, ordinal + 1])),
    strength: call.strength,
  })).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
}

function expectationStrength(name: string, arguments_: readonly string[]): number {
  const normalized = name.toLowerCase();
  if (["assertsame", "asserttrue", "assertfalse", "assertnull", "assertcount", "tobe", "tobetrue", "tobefalse", "tobenull"].includes(normalized)) {
    return 1_000_000_000;
  }
  if (normalized === "assertequals") {
    const tolerance = scalarNumber(arguments_[3]);
    if (tolerance === undefined) return 500_000_000;
    if (tolerance === 0) return 1_000_000_000;
    return Math.max(1, Math.floor(1_000_000_000 / (1 + tolerance * 1_000_000)));
  }
  if (normalized === "assertequalswithdelta" || normalized === "toequalwithdelta") {
    const tolerance = scalarNumber(arguments_[2] ?? arguments_[1]);
    if (tolerance === undefined) return 1;
    if (tolerance === 0) return 1_000_000_000;
    return Math.max(1, Math.floor(1_000_000_000 / (1 + tolerance * 1_000_000)));
  }
  if (normalized === "toequal") return 500_000_000;
  if (/contains|matches|greater|less|instanceof|throws|not/iu.test(normalized)) return 750_000_000;
  return 250_000_000;
}

function phpunitStatus(prefix: string, body: string): TestExecutionStatus {
  if (/\bDisabled\b|@disabled\b/iu.test(prefix)) return "disabled";
  if (/\bmarkTest(?:Skipped|Incomplete)\s*\(/iu.test(body) || /@(?:skip|requires?)\b/iu.test(prefix)) return "skipped";
  return "executed";
}

function dataProviderName(prefix: string): string | undefined {
  return prefix.match(/(?:DataProvider\s*\(\s*['"]|@dataProvider\s+)([A-Za-z_][A-Za-z0-9_]*)/iu)?.[1];
}

function inlinePhpunitCases(prefix: string): readonly string[] {
  const match = /TestWith\s*\(\s*(\[[\s\S]*?\])\s*\)/iu.exec(prefix);
  return match ? topLevelItems(match[1]!.slice(1, -1)) : [];
}

function returnedCases(body: string): readonly string[] {
  const returnIndex = body.search(/\breturn\s*\[/iu);
  if (returnIndex < 0) {
    return [...body.matchAll(/\byield\s+([^;]+);/giu)].map((match) => normalize(match[1]!));
  }
  const open = body.indexOf("[", returnIndex);
  const close = matchingDelimiter(body, open, "[", "]");
  return topLevelItems(body.slice(open + 1, close));
}

function chainedCases(suffix: string): readonly string[] {
  const match = /->\s*with\s*\(\s*\[/iu.exec(suffix);
  if (!match) return [];
  const open = (match.index ?? 0) + match[0].lastIndexOf("[");
  const close = matchingDelimiter(suffix, open, "[", "]");
  return topLevelItems(suffix.slice(open + 1, close));
}

function opaqueCases(testIdentity: string, cases: readonly string[]): readonly string[] {
  const occurrences = new Map<string, number>();
  return cases.map((value) => {
    const normalized = normalize(value);
    const occurrence = (occurrences.get(normalized) ?? 0) + 1;
    occurrences.set(normalized, occurrence);
    return testStrengthHash(JSON.stringify([caseIdentitySemantics, testIdentity, normalized, occurrence]));
  }).sort();
}

function topLevelItems(value: string): readonly string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if ("([{ ".includes(character) && character !== " ") depth++;
    else if (")] }".includes(character) && character !== " ") depth--;
    else if (character === "," && depth === 0) {
      if (value.slice(start, index).trim()) items.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (value.slice(start).trim()) items.push(value.slice(start));
  return items.map(normalize);
}

function callArguments(source: string, open: number): readonly string[] {
  const close = matchingDelimiter(source, open, "(", ")");
  return topLevelItems(source.slice(open + 1, close));
}

function matchingDelimiter(source: string, open: number, opening: string, closing: string): number {
  if (open < 0 || source[open] !== opening) throw new Error("Verifier test-strength PHP structure is malformed.");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < source.length; index++) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === opening) depth++;
    else if (character === closing && --depth === 0) return index;
  }
  throw new Error("Verifier test-strength PHP structure is malformed.");
}

function scalarNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*[0-9]+(?:\.[0-9]+)?\s*$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
