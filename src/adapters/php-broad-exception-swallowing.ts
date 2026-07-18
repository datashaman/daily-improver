import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  BroadExceptionSwallowingHazard,
  BroadExceptionSwallowingKind,
  BroadExceptionSwallowingPlan,
  BroadExceptionSwallowingResult,
} from "../domain/broad-exception-swallowing.js";
import { broadExceptionSwallowingHash } from "../domain/broad-exception-swallowing.js";

const targetPaths = ["app", "src"] as const;
const hazardIdentitySemantics = "php-broad-catch-handler-fingerprint/v1";
const policyIdentity = {
  schemaVersion: "php-broad-exception-swallowing-policy/v1",
  broadTypes: ["Exception", "Throwable"],
  hazardKinds: ["discarded", "default-return", "hidden"],
  reportingCalls: ["Log", "error_log", "logger", "report", "trigger_error"],
  targetPaths,
} as const;
const policySha256 = broadExceptionSwallowingHash(JSON.stringify(policyIdentity));
const maximumFiles = 20_000;
const maximumFileBytes = 2 * 1024 * 1024;
const maximumAggregateBytes = 64 * 1024 * 1024;
const maximumHazards = 10_000;

interface DetectedHazard {
  readonly kind: BroadExceptionSwallowingKind;
  readonly path: string;
  readonly declaration: string;
  readonly body: string;
}

export async function preparePhpBroadExceptionSwallowing(): Promise<BroadExceptionSwallowingPlan> {
  return {
    schemaVersion: "broad-exception-swallowing-plan/v1",
    adapter: "php",
    policySha256,
    targetScope: "adapter-production-sources",
    targetPaths,
  };
}

export async function inspectPhpBroadExceptionSwallowing(
  root: string,
  plan: BroadExceptionSwallowingPlan,
): Promise<BroadExceptionSwallowingResult> {
  if (plan.adapter !== "php" || plan.policySha256 !== policySha256
    || JSON.stringify(plan.targetPaths) !== JSON.stringify(targetPaths)) {
    throw new Error("Verifier broad exception-swallowing plan was redirected or uses an unsupported policy.");
  }
  const detected = await scanPhpSources(root);
  if (detected.length > maximumHazards) throw new Error("Verifier broad exception-swallowing inventory is excessive.");
  const occurrences = new Map<string, number>();
  const hazards: BroadExceptionSwallowingHazard[] = detected.map((hazard) => {
    const occurrenceKey = JSON.stringify([hazard.path, hazard.kind, hazard.declaration, hazard.body]);
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    return {
      kind: hazard.kind,
      identitySha256: broadExceptionSwallowingHash(JSON.stringify([
        hazardIdentitySemantics,
        hazard.path,
        hazard.kind,
        hazard.declaration,
        hazard.body,
        occurrence,
      ])),
    };
  }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  return {
    schemaVersion: "broad-exception-swallowing-result/v1",
    adapter: "php",
    policySha256,
    targetScope: "adapter-production-sources",
    targetPaths,
    hazardIdentitySemantics,
    hazards,
    inventorySha256: broadExceptionSwallowingHash(JSON.stringify([hazardIdentitySemantics, hazards])),
  };
}

async function scanPhpSources(root: string): Promise<readonly DetectedHazard[]> {
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
      throw new Error(`Verifier broad exception-swallowing target is unsupported: ${target}`);
    }
    await walk(canonicalRoot, absolute, paths);
  }
  if (paths.length > maximumFiles) throw new Error("Verifier broad exception-swallowing file inventory is excessive.");
  let aggregateBytes = 0;
  const hazards: DetectedHazard[] = [];
  for (const path of paths.sort()) {
    const absolute = join(canonicalRoot, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumFileBytes) {
      throw new Error("Verifier broad exception-swallowing input is unsupported or excessive.");
    }
    aggregateBytes += metadata.size;
    if (aggregateBytes > maximumAggregateBytes) throw new Error("Verifier broad exception-swallowing inputs are excessive.");
    hazards.push(...inspectPhpSource(path, await readFile(absolute, "utf8")));
    if (hazards.length > maximumHazards) throw new Error("Verifier broad exception-swallowing inventory is excessive.");
  }
  return hazards;
}

async function walk(root: string, directory: string, paths: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`Verifier broad exception-swallowing input is symbolic: ${path}`);
    if (entry.isDirectory()) await walk(root, absolute, paths);
    else if (entry.isFile() && path.endsWith(".php")) {
      paths.push(path);
      if (paths.length > maximumFiles) throw new Error("Verifier broad exception-swallowing file inventory is excessive.");
    }
  }
}

function inspectPhpSource(path: string, source: string): readonly DetectedHazard[] {
  const code = maskPhpNonCode(source);
  assertBalancedBraces(code);
  const hazards: DetectedHazard[] = [];
  const catchPattern = /\bcatch\s*\(([^)]{1,512})\)\s*\{/gu;
  for (const match of code.matchAll(catchPattern)) {
    const declaration = normalize(match[1]!);
    if (!/(?:^|[|&\s])\\?(?:Throwable|Exception)(?=$|[|&\s$])/u.test(declaration)) continue;
    const openingBrace = (match.index ?? 0) + match[0].lastIndexOf("{");
    const closingBrace = matchingBrace(code, openingBrace);
    const body = normalize(code.slice(openingBrace + 1, closingBrace));
    const kind = classifyHazard(body);
    if (kind) hazards.push({ kind, path, declaration, body });
  }
  return hazards;
}

function classifyHazard(body: string): BroadExceptionSwallowingKind | undefined {
  if (body === "") return "discarded";
  if (/\bthrow\b/u.test(body) || /(?:^|[^A-Za-z0-9_])(?:report|logger|error_log|trigger_error)\s*\(/u.test(body)
    || /(?:^|[^A-Za-z0-9_\\])(?:\\?[A-Za-z_][A-Za-z0-9_]*\\)*Log\s*::/u.test(body)
    || /->\s*(?:emergency|alert|critical|error|warning|notice|info|debug|log)\s*\(/u.test(body)) {
    return undefined;
  }
  if (/^return\s*(?:null|false|true|0(?:\.0+)?|\[\]|array\s*\(\s*\)|)\s*;?$/u.test(body)) {
    return "default-return";
  }
  return "hidden";
}

function assertBalancedBraces(code: string): void {
  let depth = 0;
  for (const character of code) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    if (depth < 0) throw new Error("Verifier broad exception-swallowing PHP input has an unexpected closing brace.");
  }
  if (depth !== 0) throw new Error("Verifier broad exception-swallowing PHP input has an unclosed brace.");
}

function matchingBrace(code: string, openingBrace: number): number {
  let depth = 0;
  for (let index = openingBrace; index < code.length; index += 1) {
    const character = code[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Verifier broad exception-swallowing PHP input has an unclosed catch block.");
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
      continue;
    }
    if (state === "line-comment") result += " ";
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
      if (!opener?.[1]) throw new Error("Verifier broad exception-swallowing PHP input has malformed heredoc syntax.");
      const bodyStart = index + opener[0].length;
      const terminator = new RegExp(`^\\s*${escapeRegExp(opener[1])};?\\s*$`, "mu").exec(source.slice(bodyStart));
      if (!terminator || terminator.index === undefined) {
        throw new Error("Verifier broad exception-swallowing PHP input has an unclosed heredoc.");
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
    throw new Error("Verifier broad exception-swallowing PHP input has an unclosed lexical region.");
  }
  return result;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
