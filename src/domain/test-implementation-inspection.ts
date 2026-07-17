import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export const testImplementationInspectionSchemaVersion = "test-implementation-inspection/v1" as const;

export const implementationRestatementSignals = [
  "production-source-inspection",
  "exact-token-copy",
  "structural-token-copy",
] as const;

export type ImplementationRestatementSignal = (typeof implementationRestatementSignals)[number];

export interface TestImplementationCriterion {
  readonly kind: "property-invariant" | "acceptance-criterion";
  readonly statement: string;
}

export interface TestImplementationInspection {
  readonly schemaVersion: typeof testImplementationInspectionSchemaVersion;
  readonly testPath: string;
  readonly testSha256: string;
  readonly target: string;
  readonly targetSha256: string;
  readonly criterion: TestImplementationCriterion;
  readonly outcome: "accepted" | "rejected";
  readonly signals: readonly ImplementationRestatementSignal[];
  readonly metrics: {
    readonly productionSourceInspection: boolean;
    readonly longestExactTokenRun: number;
    readonly longestStructuralTokenRun: number;
  };
}

export interface TestImplementationInspectionExpectation {
  readonly root: string;
  readonly testPath: string;
  readonly observedTestPaths: readonly string[];
  readonly target: string;
  readonly criterion: TestImplementationCriterion;
  readonly approvedPropertyInvariants: readonly string[];
  readonly approvedAcceptanceCriteria: readonly string[];
}

const maximumInspectedSourceBytes = 256_000;
const maximumTokens = 40_000;
const exactTokenCopyThreshold = 24;
const structuralTokenCopyThreshold = 48;
const safePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\x00-\x1f\x7f]+$/;
const digestPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /[\p{L}_$][\p{L}\p{N}_$]*|\d+(?:\.\d+)?|===|!==|==|!=|<=|>=|=>|->|::|&&|\|\||\+\+|--|\*\*|\?\?|<<|>>|\.\.\.|[^\s]/gu;
const identifierPattern = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const numberPattern = /^\d+(?:\.\d+)?$/;
const sourceInspectionPattern = /\b(?:file_get_contents|readfile|readfilesync|fopen|open|read_file|readfiletostring|read_file_to_string|read_to_string|readstring|read_text|readalltext|inspect\.getsource|sourcefileloader)\b/i;
const structuralKeywords = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "do", "else", "enum",
  "extends", "false", "final", "finally", "fn", "for", "foreach", "function", "if", "implements", "import",
  "interface", "let", "match", "namespace", "new", "null", "private", "protected", "public", "readonly", "return",
  "static", "switch", "throw", "throws", "trait", "true", "try", "use", "var", "while", "yield", "STRING",
]);

export async function inspectGeneratedTestImplementation(
  expectation: TestImplementationInspectionExpectation,
): Promise<TestImplementationInspection> {
  const validated = validateExpectation(expectation);
  const [testSource, targetSource] = await Promise.all([
    readBoundedSource(validated.root, validated.testPath, "generated test"),
    readBoundedSource(validated.root, validated.target, "selected target"),
  ]);
  const targetTokens = tokenize(targetSource);
  const testTokens = tokenize(testSource);
  const longestExactTokenRun = boundedMetric(longestCommonTokenRun(targetTokens, testTokens));
  const longestStructuralTokenRun = boundedMetric(longestCommonTokenRun(
    targetTokens.map(structuralToken),
    testTokens.map(structuralToken),
  ));
  const productionSourceInspection = inspectsProductionSource(testSource, validated.target);
  const signals: ImplementationRestatementSignal[] = [];
  if (productionSourceInspection) signals.push("production-source-inspection");
  if (longestExactTokenRun >= exactTokenCopyThreshold) signals.push("exact-token-copy");
  if (longestStructuralTokenRun >= structuralTokenCopyThreshold) signals.push("structural-token-copy");
  return assertTestImplementationInspection({
    schemaVersion: testImplementationInspectionSchemaVersion,
    testPath: validated.testPath,
    testSha256: sha256(testSource),
    target: validated.target,
    targetSha256: sha256(targetSource),
    criterion: validated.criterion,
    outcome: signals.length === 0 ? "accepted" : "rejected",
    signals,
    metrics: { productionSourceInspection, longestExactTokenRun, longestStructuralTokenRun },
  }, validated);
}

export function assertTestImplementationInspection(
  value: unknown,
  expectation: Omit<TestImplementationInspectionExpectation, "root">,
): TestImplementationInspection {
  const validated = validateExpectation({ ...expectation, root: "." });
  const inspection = exactRecord(value, [
    "schemaVersion", "testPath", "testSha256", "target", "targetSha256", "criterion", "outcome", "signals", "metrics",
  ], "Test implementation inspection");
  if (inspection.schemaVersion !== testImplementationInspectionSchemaVersion) {
    throw new Error(`Test implementation inspection must use ${testImplementationInspectionSchemaVersion}.`);
  }
  if (inspection.testPath !== validated.testPath || !validated.observedTestPaths.includes(validated.testPath)) {
    throw new Error("Test implementation inspection is not bound to the observed generated test.");
  }
  if (inspection.target !== validated.target) {
    throw new Error("Test implementation inspection is not bound to the selected target.");
  }
  if (typeof inspection.testSha256 !== "string" || !digestPattern.test(inspection.testSha256)
    || typeof inspection.targetSha256 !== "string" || !digestPattern.test(inspection.targetSha256)) {
    throw new Error("Test implementation inspection source hashes are malformed.");
  }
  const criterion = validateCriterion(inspection.criterion, validated.approvedPropertyInvariants, validated.approvedAcceptanceCriteria);
  if (criterion.kind !== validated.criterion.kind || criterion.statement !== validated.criterion.statement) {
    throw new Error("Test implementation inspection is not bound to the approved criterion.");
  }
  if (!Array.isArray(inspection.signals) || inspection.signals.length > implementationRestatementSignals.length
    || inspection.signals.some((signal) => !implementationRestatementSignals.includes(signal as ImplementationRestatementSignal))
    || new Set(inspection.signals).size !== inspection.signals.length) {
    throw new Error("Test implementation inspection signals are malformed.");
  }
  const signals = inspection.signals as ImplementationRestatementSignal[];
  const metrics = exactRecord(inspection.metrics, ["productionSourceInspection", "longestExactTokenRun", "longestStructuralTokenRun"], "Test implementation inspection metrics");
  if (typeof metrics.productionSourceInspection !== "boolean") throw new Error("Test implementation inspection source-access metric is malformed.");
  const longestExactTokenRun = boundedMetric(metrics.longestExactTokenRun);
  const longestStructuralTokenRun = boundedMetric(metrics.longestStructuralTokenRun);
  const expectedSignals: ImplementationRestatementSignal[] = [];
  if (metrics.productionSourceInspection) expectedSignals.push("production-source-inspection");
  if (longestExactTokenRun >= exactTokenCopyThreshold) expectedSignals.push("exact-token-copy");
  if (longestStructuralTokenRun >= structuralTokenCopyThreshold) expectedSignals.push("structural-token-copy");
  if (JSON.stringify(signals) !== JSON.stringify(expectedSignals)) {
    throw new Error("Test implementation inspection signals do not match its metrics.");
  }
  const outcome = signals.length === 0 ? "accepted" : "rejected";
  if (inspection.outcome !== outcome) throw new Error("Test implementation inspection outcome is inconsistent.");
  return {
    schemaVersion: testImplementationInspectionSchemaVersion,
    testPath: validated.testPath,
    testSha256: inspection.testSha256,
    target: validated.target,
    targetSha256: inspection.targetSha256,
    criterion,
    outcome,
    signals,
    metrics: { productionSourceInspection: metrics.productionSourceInspection, longestExactTokenRun, longestStructuralTokenRun },
  };
}

export function requireBlackBoxTest(inspection: TestImplementationInspection): void {
  if (inspection.outcome === "rejected") {
    throw new Error(`Generated test restates selected-target implementation details: ${inspection.signals.join(", ")}.`);
  }
}

function validateExpectation(expectation: TestImplementationInspectionExpectation): TestImplementationInspectionExpectation {
  if (typeof expectation.root !== "string" || expectation.root.length === 0) throw new Error("Inspection root is required.");
  const testPath = safePath(expectation.testPath, "generated test path");
  const target = safePath(expectation.target, "selected target path");
  if (!Array.isArray(expectation.observedTestPaths) || !expectation.observedTestPaths.includes(testPath)) {
    throw new Error("Test implementation inspection requires an observed generated test.");
  }
  const criterion = validateCriterion(
    expectation.criterion,
    expectation.approvedPropertyInvariants,
    expectation.approvedAcceptanceCriteria,
  );
  return { ...expectation, testPath, target, criterion };
}

function validateCriterion(
  value: unknown,
  approvedPropertyInvariants: readonly string[],
  approvedAcceptanceCriteria: readonly string[],
): TestImplementationCriterion {
  const criterion = exactRecord(value, ["kind", "statement"], "Test implementation inspection criterion");
  if (criterion.kind !== "property-invariant" && criterion.kind !== "acceptance-criterion") {
    throw new Error("Test implementation inspection criterion kind is unsupported.");
  }
  if (typeof criterion.statement !== "string" || criterion.statement.length === 0 || criterion.statement.length > 4_096 || criterion.statement.trim() !== criterion.statement) {
    throw new Error("Test implementation inspection criterion statement is malformed.");
  }
  const approved = criterion.kind === "property-invariant" ? approvedPropertyInvariants : approvedAcceptanceCriteria;
  if (!approved.includes(criterion.statement)) throw new Error("Test implementation inspection criterion is not approved.");
  return { kind: criterion.kind, statement: criterion.statement };
}

async function readBoundedSource(root: string, relativePath: string, name: string): Promise<string> {
  const path = join(root, relativePath);
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error(`${name} must be a regular file.`);
  if (metadata.size === 0 || metadata.size > maximumInspectedSourceBytes) {
    throw new Error(`${name} must contain 1-${maximumInspectedSourceBytes} bytes.`);
  }
  return await readFile(path, "utf8");
}

function tokenize(source: string): readonly string[] {
  const withoutCommentsOrStrings = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(^|\s)(?:\/\/|#).*$/gm, "$1 ")
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, " STRING ");
  const tokens = withoutCommentsOrStrings.match(tokenPattern) ?? [];
  if (tokens.length > maximumTokens) throw new Error(`Inspected source exceeds ${maximumTokens} lexical tokens.`);
  return tokens;
}

function structuralToken(token: string): string {
  if (structuralKeywords.has(token.toLowerCase()) || token === "STRING") return token.toLowerCase();
  if (identifierPattern.test(token)) return "IDENTIFIER";
  if (numberPattern.test(token)) return "NUMBER";
  return token;
}

function longestCommonTokenRun(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const states: { length: number; link: number; transitions: Map<string, number> }[] = [
    { length: 0, link: -1, transitions: new Map() },
  ];
  const stateAt = (index: number) => {
    const value = states[index];
    if (!value) throw new Error("Test implementation inspection token state is malformed.");
    return value;
  };
  let last = 0;
  for (const token of left) {
    const current = states.length;
    states.push({ length: stateAt(last).length + 1, link: 0, transitions: new Map() });
    let cursor = last;
    while (cursor >= 0 && !stateAt(cursor).transitions.has(token)) {
      stateAt(cursor).transitions.set(token, current);
      cursor = stateAt(cursor).link;
    }
    if (cursor >= 0) {
      const next = stateAt(cursor).transitions.get(token) as number;
      if (stateAt(cursor).length + 1 === stateAt(next).length) {
        stateAt(current).link = next;
      } else {
        const clone = states.length;
        states.push({
          length: stateAt(cursor).length + 1,
          link: stateAt(next).link,
          transitions: new Map(stateAt(next).transitions),
        });
        while (cursor >= 0 && stateAt(cursor).transitions.get(token) === next) {
          stateAt(cursor).transitions.set(token, clone);
          cursor = stateAt(cursor).link;
        }
        stateAt(next).link = clone;
        stateAt(current).link = clone;
      }
    }
    last = current;
  }
  let state = 0;
  let length = 0;
  let longest = 0;
  for (const token of right) {
    while (state !== 0 && !stateAt(state).transitions.has(token)) {
      state = stateAt(state).link;
      length = stateAt(state).length;
    }
    const next = stateAt(state).transitions.get(token);
    if (next === undefined) {
      state = 0;
      length = 0;
      continue;
    }
    state = next;
    length++;
    if (length > longest) longest = length;
  }
  return longest;
}

function inspectsProductionSource(testSource: string, target: string): boolean {
  if (!sourceInspectionPattern.test(testSource)) return false;
  const basename = target.split("/").at(-1) ?? target;
  return testSource.includes(target) || testSource.includes(basename);
}

function safePath(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || value.trim() !== value || !safePathPattern.test(value)) {
    throw new Error(`Test implementation inspection ${name} is malformed.`);
  }
  return value;
}

function boundedMetric(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximumTokens) {
    throw new Error("Test implementation inspection metric is malformed.");
  }
  return value as number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an exact object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${name} must have an exact schema.`);
  return record;
}
