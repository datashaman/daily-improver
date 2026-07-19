import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  ValidationBoundary,
  ValidationBoundaryPlan,
  ValidationBoundaryResult,
  ValidationGuarantee,
} from "../domain/validation-boundaries.js";
import { validationBoundaryHash } from "../domain/validation-boundaries.js";

const targetPaths = ["app", "src"] as const;
const boundaryIdentitySemantics = "php-validation-boundary-context/v1";
const guaranteeIdentitySemantics = "php-validation-guarantee-strength/v1";
const unvalidatedFlowIdentitySemantics = "php-request-mass-assignment-flow/v1";
const maximumFiles = 20_000;
const maximumFileBytes = 2 * 1024 * 1024;
const maximumAggregateBytes = 64 * 1024 * 1024;
const maximumBoundaries = 10_000;
const maximumGuarantees = 100_000;
const maximumStrength = 1_000_000;
const policyIdentity = {
  schemaVersion: "php-validation-boundary-policy/v1",
  boundaries: ["form-request-rules", "request-validate", "validator-make"],
  requestSources: ["all", "except", "get", "input", "only"],
  sensitiveSinks: ["create", "fill", "forceFill", "insert", "update", "upsert"],
  targetPaths,
} as const;
const policySha256 = validationBoundaryHash(JSON.stringify(policyIdentity));

interface DetectedBoundary {
  readonly context: string;
  readonly kind: string;
  readonly rules: string;
}

interface DetectedFlow {
  readonly context: string;
  readonly sink: string;
  readonly source: string;
}

export async function preparePhpValidationBoundaries(): Promise<ValidationBoundaryPlan> {
  return {
    schemaVersion: "validation-boundary-plan/v1",
    adapter: "php",
    policySha256,
    targetScope: "adapter-production-sources",
    targetPaths,
  };
}

export async function inspectPhpValidationBoundaries(
  root: string,
  plan: ValidationBoundaryPlan,
): Promise<ValidationBoundaryResult> {
  if (plan.adapter !== "php" || plan.policySha256 !== policySha256
    || JSON.stringify(plan.targetPaths) !== JSON.stringify(targetPaths)) {
    throw new Error("Verifier validation-boundary plan was redirected or uses an unsupported policy.");
  }
  const inventory = await scanPhpSources(root);
  const boundaryOccurrences = new Map<string, number>();
  let guaranteeCount = 0;
  const boundaries: ValidationBoundary[] = inventory.boundaries.map((detected) => {
    const key = JSON.stringify([detected.context, detected.kind]);
    const occurrence = (boundaryOccurrences.get(key) ?? 0) + 1;
    boundaryOccurrences.set(key, occurrence);
    const identitySha256 = validationBoundaryHash(JSON.stringify([
      boundaryIdentitySemantics, detected.context, detected.kind, occurrence,
    ]));
    const guarantees = validationGuarantees(identitySha256, detected.rules);
    guaranteeCount += guarantees.length;
    if (guaranteeCount > maximumGuarantees) throw new Error("Verifier validation guarantees are excessive.");
    return { identitySha256, guarantees };
  }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  const flowOccurrences = new Map<string, number>();
  const unvalidatedFlowIdentities = inventory.flows.map((flow) => {
    const key = JSON.stringify([flow.context, flow.sink, flow.source]);
    const occurrence = (flowOccurrences.get(key) ?? 0) + 1;
    flowOccurrences.set(key, occurrence);
    return validationBoundaryHash(JSON.stringify([
      unvalidatedFlowIdentitySemantics, flow.context, flow.sink, flow.source, occurrence,
    ]));
  }).sort();
  return {
    schemaVersion: "validation-boundary-result/v1",
    adapter: "php",
    policySha256,
    targetScope: "adapter-production-sources",
    targetPaths,
    boundaryIdentitySemantics,
    guaranteeIdentitySemantics,
    unvalidatedFlowIdentitySemantics,
    boundaries,
    unvalidatedFlowIdentities,
    inventorySha256: validationBoundaryHash(JSON.stringify([
      boundaryIdentitySemantics,
      guaranteeIdentitySemantics,
      unvalidatedFlowIdentitySemantics,
      boundaries,
      unvalidatedFlowIdentities,
    ])),
  };
}

async function scanPhpSources(root: string): Promise<{ readonly boundaries: readonly DetectedBoundary[]; readonly flows: readonly DetectedFlow[] }> {
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
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Verifier validation-boundary target is unsupported: ${target}`);
    }
    await walk(canonicalRoot, absolute, paths);
  }
  if (paths.length > maximumFiles) throw new Error("Verifier validation-boundary file inventory is excessive.");
  let aggregateBytes = 0;
  const boundaries: DetectedBoundary[] = [];
  const flows: DetectedFlow[] = [];
  for (const path of paths.sort()) {
    const absolute = join(canonicalRoot, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumFileBytes) {
      throw new Error("Verifier validation-boundary input is unsupported or excessive.");
    }
    aggregateBytes += metadata.size;
    if (aggregateBytes > maximumAggregateBytes) throw new Error("Verifier validation-boundary inputs are excessive.");
    const source = await readFile(absolute, "utf8");
    const inspected = inspectPhpSource(path, source);
    boundaries.push(...inspected.boundaries);
    flows.push(...inspected.flows);
    if (boundaries.length > maximumBoundaries || flows.length > maximumBoundaries) {
      throw new Error("Verifier validation-boundary inventory is excessive.");
    }
  }
  return { boundaries, flows };
}

async function walk(root: string, directory: string, paths: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`Verifier validation-boundary input is symbolic: ${path}`);
    if (entry.isDirectory()) await walk(root, absolute, paths);
    else if (entry.isFile() && path.endsWith(".php")) {
      paths.push(path);
      if (paths.length > maximumFiles) throw new Error("Verifier validation-boundary file inventory is excessive.");
    }
  }
}

function inspectPhpSource(path: string, source: string): { readonly boundaries: readonly DetectedBoundary[]; readonly flows: readonly DetectedFlow[] } {
  const code = maskPhpNonCode(source);
  assertBalanced(code);
  const boundaries: DetectedBoundary[] = [];
  for (const match of code.matchAll(/\$(?:request|[A-Za-z_][A-Za-z0-9_]*request[A-Za-z0-9_]*)\s*->\s*validate\s*\(/giu)) {
    const opening = (match.index ?? 0) + match[0].lastIndexOf("(");
    const closing = matchingDelimiter(code, opening, "(", ")");
    const rules = splitTopLevel(source.slice(opening + 1, closing), ",")[0]?.trim();
    if (!rules) throw new Error("Verifier validation-boundary request validation has no rules contract.");
    boundaries.push({ context: contextAt(path, code, opening), kind: "request-validate", rules });
  }
  for (const match of code.matchAll(/(?:\\?[A-Za-z_][A-Za-z0-9_]*\\)*Validator\s*::\s*make\s*\(/gu)) {
    const opening = (match.index ?? 0) + match[0].lastIndexOf("(");
    const closing = matchingDelimiter(code, opening, "(", ")");
    const rules = splitTopLevel(source.slice(opening + 1, closing), ",")[1]?.trim();
    if (!rules) throw new Error("Verifier validation-boundary validator construction has no rules contract.");
    boundaries.push({ context: contextAt(path, code, opening), kind: "validator-make", rules });
  }
  if (/\bextends\s+(?:\\?[A-Za-z_][A-Za-z0-9_]*\\)*FormRequest\b/u.test(code)) {
    for (const match of code.matchAll(/\bfunction\s+rules\s*\([^)]*\)\s*(?::\s*[^\{]{1,256})?\{/gu)) {
      const opening = (match.index ?? 0) + match[0].lastIndexOf("{");
      const closing = matchingDelimiter(code, opening, "{", "}");
      const bodyCode = code.slice(opening + 1, closing);
      const returned = /\breturn\s+([\[(])/u.exec(bodyCode);
      if (!returned?.[1] || returned.index === undefined) {
        throw new Error("Verifier validation-boundary FormRequest rules contract is unsupported.");
      }
      const rulesOpening = opening + 1 + returned.index + returned[0].lastIndexOf(returned[1]);
      const rulesClosing = matchingDelimiter(code, rulesOpening, returned[1], returned[1] === "[" ? "]" : ")");
      boundaries.push({
        context: contextAt(path, code, opening),
        kind: "form-request-rules",
        rules: source.slice(rulesOpening, rulesClosing + 1),
      });
    }
  }
  const flows: DetectedFlow[] = [];
  for (const match of code.matchAll(/(?:->|::)\s*(create|fill|forceFill|insert|update|upsert)\s*\(/gu)) {
    const sink = match[1]!;
    const opening = (match.index ?? 0) + match[0].lastIndexOf("(");
    const closing = matchingDelimiter(code, opening, "(", ")");
    const argumentCode = code.slice(opening + 1, closing);
    const requestSource = /\$(?:request|[A-Za-z_][A-Za-z0-9_]*request[A-Za-z0-9_]*)\s*->\s*(all|except|get|input|only)\s*\(/iu.exec(argumentCode);
    if (requestSource?.[1]) {
      flows.push({ context: contextAt(path, code, opening), sink, source: requestSource[1] });
    }
  }
  return { boundaries, flows };
}

function validationGuarantees(boundaryIdentity: string, rulesExpression: string): readonly ValidationGuarantee[] {
  const entries = parseRuleEntries(rulesExpression);
  const guarantees: ValidationGuarantee[] = [];
  for (const entry of entries) {
    const normalizedRules = entry.rules.map((rule) => rule.trim().toLowerCase()).filter(Boolean);
    if (!normalizedRules.some((rule) => rule.startsWith("opaque:"))) {
      guarantees.push(
        guarantee(boundaryIdentity, entry.field, "nullability", normalizedRules.includes("nullable") ? 1 : 2),
        guarantee(boundaryIdentity, entry.field, "participation", normalizedRules.some((rule) => rule.startsWith("exclude")) ? 1 : 2),
      );
    }
    for (const normalized of normalizedRules) {
      if (!normalized || normalized === "nullable" || normalized === "sometimes") continue;
      const [family, strength] = ruleStrength(normalized);
      guarantees.push(guarantee(boundaryIdentity, entry.field, family, strength));
    }
  }
  guarantees.sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  const merged = new Map<string, number>();
  for (const guarantee of guarantees) {
    merged.set(guarantee.identitySha256, Math.max(merged.get(guarantee.identitySha256) ?? 0, guarantee.strength));
  }
  return [...merged].map(([identitySha256, strength]) => ({ identitySha256, strength }));
}

function guarantee(boundaryIdentity: string, field: string, family: string, strength: number): ValidationGuarantee {
  return {
    identitySha256: validationBoundaryHash(JSON.stringify([
      guaranteeIdentitySemantics, boundaryIdentity, field, family,
    ])),
    strength,
  };
}

function parseRuleEntries(expression: string): readonly { readonly field: string; readonly rules: readonly string[] }[] {
  const trimmed = expression.trim();
  let body: string;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) body = trimmed.slice(1, -1);
  else if (/^array\s*\(/iu.test(trimmed) && trimmed.endsWith(")")) body = trimmed.slice(trimmed.indexOf("(") + 1, -1);
  else {
    return [{ field: "dynamic-contract", rules: [`opaque:${validationBoundaryHash(normalize(trimmed))}`] }];
  }
  const entries: { field: string; rules: readonly string[] }[] = [];
  for (const item of splitTopLevel(body, ",")) {
    if (!item.trim()) continue;
    const pair = splitTopLevelArrow(item);
    if (!pair) return [{ field: "dynamic-contract", rules: [`opaque:${validationBoundaryHash(normalize(trimmed))}`] }];
    const field = quotedLiteral(pair[0].trim());
    if (field === undefined) return [{ field: "dynamic-contract", rules: [`opaque:${validationBoundaryHash(normalize(trimmed))}`] }];
    entries.push({ field, rules: parseRuleValue(pair[1].trim()) });
  }
  return entries;
}

function parseRuleValue(value: string): readonly string[] {
  const literal = quotedLiteral(value);
  if (literal !== undefined) return literal.split("|").filter(Boolean);
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const rules = splitTopLevel(trimmed.slice(1, -1), ",").map((part) => quotedLiteral(part.trim()));
    if (rules.every((rule) => rule !== undefined)) return rules as readonly string[];
  }
  return [`opaque:${validationBoundaryHash(normalize(value))}`];
}

function ruleStrength(rule: string): readonly [string, number] {
  if (rule === "required") return ["presence", 3];
  if (rule === "filled" || rule === "present") return ["presence", 2];
  const minimum = /^min:(\d{1,6})$/u.exec(rule);
  if (minimum?.[1]) return ["minimum", Math.max(1, Number(minimum[1]))];
  const maximum = /^max:(\d{1,6})$/u.exec(rule);
  if (maximum?.[1]) return ["maximum", maximumStrength - Number(maximum[1])];
  const [name, parameter] = rule.split(":", 2);
  return [parameter === undefined ? `rule:${name}` : `exact:${rule}`, 1];
}

function contextAt(path: string, code: string, index: number): string {
  const prefix = code.slice(0, index);
  const classes = [...prefix.matchAll(/\b(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gu)];
  const functions = [...prefix.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu)];
  return JSON.stringify([path, classes.at(-1)?.[1] ?? "", functions.at(-1)?.[1] ?? ""]);
}

function splitTopLevel(value: string, delimiter: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === "\"") quote = character;
    else if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === delimiter && round === 0 && square === 0 && curly === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function splitTopLevelArrow(value: string): readonly [string, string] | undefined {
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
    } else if (character === "'" || character === "\"") quote = character;
    else if ("([{".includes(character)) depth += 1;
    else if (")] }".replace(" ", "").includes(character)) depth -= 1;
    else if (character === "=" && value[index + 1] === ">" && depth === 0) {
      return [value.slice(0, index), value.slice(index + 2)];
    }
  }
  return undefined;
}

function quotedLiteral(value: string): string | undefined {
  const match = /^(['"])([\s\S]*)\1$/u.exec(value);
  if (!match?.[2] || /\\/u.test(match[2])) return match?.[2] === "" ? "" : undefined;
  return match[2];
}

function matchingDelimiter(code: string, opening: number, open: string, close: string): number {
  let depth = 0;
  for (let index = opening; index < code.length; index += 1) {
    if (code[index] === open) depth += 1;
    else if (code[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Verifier validation-boundary PHP input has an unclosed delimiter.");
}

function assertBalanced(code: string): void {
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  for (const character of code) {
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    if (braces < 0 || parentheses < 0 || brackets < 0) {
      throw new Error("Verifier validation-boundary PHP input has an unexpected closing delimiter.");
    }
  }
  if (braces !== 0 || parentheses !== 0 || brackets !== 0) {
    throw new Error("Verifier validation-boundary PHP input has an unclosed delimiter.");
  }
}

function maskPhpNonCode(source: string): string {
  let state: "code" | "single" | "double" | "line-comment" | "block-comment" = "code";
  let escaped = false;
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (character === "\n") {
      result += character;
      if (state === "line-comment") state = "code";
      escaped = false;
    } else if (state === "line-comment") result += " ";
    else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else result += " ";
    } else if (state === "single" || state === "double") {
      result += " ";
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if ((state === "single" && character === "'") || (state === "double" && character === "\"")) state = "code";
    } else if (source.startsWith("<<<", index)) {
      const opener = /^<<<\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*\r?\n/u.exec(source.slice(index));
      if (!opener?.[1]) throw new Error("Verifier validation-boundary PHP input has malformed heredoc syntax.");
      const bodyStart = index + opener[0].length;
      const terminator = new RegExp(`^\\s*${escapeRegExp(opener[1])};?\\s*$`, "mu").exec(source.slice(bodyStart));
      if (!terminator || terminator.index === undefined) {
        throw new Error("Verifier validation-boundary PHP input has an unclosed heredoc.");
      }
      const terminatorStart = bodyStart + terminator.index;
      const terminatorEnd = source.indexOf("\n", terminatorStart);
      const end = terminatorEnd < 0 ? source.length : terminatorEnd + 1;
      result += source.slice(index, end).replace(/[^\r\n]/gu, " ");
      index = end - 1;
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else if ((character === "/" && next === "/") || (character === "#" && next !== "[")) {
      result += character === "#" ? " " : "  ";
      if (character !== "#") index += 1;
      state = "line-comment";
    } else if (character === "'" || character === "\"") {
      result += " ";
      state = character === "'" ? "single" : "double";
    } else result += character;
  }
  if (state === "single" || state === "double" || state === "block-comment") {
    throw new Error("Verifier validation-boundary PHP input has an unclosed lexical region.");
  }
  return result;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
