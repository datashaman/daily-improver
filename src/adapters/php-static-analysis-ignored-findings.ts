import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  StaticAnalysisIgnoreMechanism,
  StaticAnalysisIgnoredFindingIdentity,
  StaticAnalysisIgnoredFindingsPlan,
  StaticAnalysisIgnoredFindingsResult,
} from "../domain/static-analysis-ignored-findings.js";
import { staticAnalysisIgnoredFindingHash } from "../domain/static-analysis-ignored-findings.js";
import { preparePhpVerifierStaticAnalysis } from "./php-verifier-static-analysis.js";

const ignoredFindingIdentitySemantics = "php-static-analysis-ignore-inventory/v1";
const maximumFiles = 20_000;
const maximumFileBytes = 1024 * 1024;
const maximumAggregateBytes = 64 * 1024 * 1024;
const maximumIgnoredFindings = 10_000;
const excludedDirectories = new Set([".git", ".daily-improver", "node_modules", "vendor"]);

interface DetectedIgnore {
  readonly mechanism: StaticAnalysisIgnoreMechanism;
  readonly path: string;
  readonly normalizedValue: string;
}

export async function preparePhpStaticAnalysisIgnoredFindings(root: string): Promise<StaticAnalysisIgnoredFindingsPlan> {
  const staticAnalysis = await preparePhpVerifierStaticAnalysis(root);
  return {
    schemaVersion: "static-analysis-ignored-findings-plan/v1",
    adapter: "php",
    tool: staticAnalysis.tool,
    configurationSha256: staticAnalysis.configurationSha256,
    targetScope: "repository-configured",
  };
}

export async function inspectPhpStaticAnalysisIgnoredFindings(
  root: string,
  plan: StaticAnalysisIgnoredFindingsPlan,
): Promise<StaticAnalysisIgnoredFindingsResult> {
  if (plan.adapter !== "php" || (plan.tool !== "phpstan" && plan.tool !== "psalm")) {
    throw new Error("Verifier ignored-findings plan was redirected to an unsupported adapter or tool.");
  }
  const prepared = await preparePhpVerifierStaticAnalysis(root);
  if (prepared.tool !== plan.tool || prepared.configurationSha256 !== plan.configurationSha256) {
    throw new Error("Verifier ignored-findings configuration changed before inspection.");
  }
  const detected = await scanIgnoredFindings(root, plan.tool);
  if (detected.length > maximumIgnoredFindings) throw new Error("Verifier ignored-finding inventory is excessive.");
  const occurrences = new Map<string, number>();
  const ignoredFindings: StaticAnalysisIgnoredFindingIdentity[] = detected.map((item) => {
    const occurrenceKey = JSON.stringify([item.mechanism, item.path, item.normalizedValue]);
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    return {
      mechanism: item.mechanism,
      identitySha256: staticAnalysisIgnoredFindingHash(JSON.stringify([
        ignoredFindingIdentitySemantics,
        plan.tool,
        item.mechanism,
        item.path,
        item.normalizedValue,
        occurrence,
      ])),
    };
  }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  return {
    schemaVersion: "static-analysis-ignored-findings-result/v1",
    adapter: "php",
    tool: plan.tool,
    configurationSha256: plan.configurationSha256,
    targetScope: "repository-configured",
    ignoredFindingIdentitySemantics,
    ignoredFindings,
    inventorySha256: staticAnalysisIgnoredFindingHash(JSON.stringify([
      ignoredFindingIdentitySemantics,
      ignoredFindings,
    ])),
  };
}

async function scanIgnoredFindings(root: string, tool: string): Promise<readonly DetectedIgnore[]> {
  const canonicalRoot = await realpath(root);
  const paths: string[] = [];
  await walk(canonicalRoot, canonicalRoot, paths);
  if (paths.length > maximumFiles) throw new Error("Verifier ignored-finding file inventory is excessive.");
  let aggregateBytes = 0;
  const detected: DetectedIgnore[] = [];
  for (const path of paths.sort()) {
    const absolute = join(canonicalRoot, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumFileBytes) {
      throw new Error("Verifier ignored-finding input is unsupported or excessive.");
    }
    aggregateBytes += metadata.size;
    if (aggregateBytes > maximumAggregateBytes) throw new Error("Verifier ignored-finding inputs are excessive.");
    const content = await readFile(absolute, "utf8");
    detected.push(...inlineIgnores(tool, path, content));
    if (tool === "phpstan" && (path.endsWith(".neon") || path.endsWith(".neon.dist"))) {
      detected.push(...phpStanConfigurationIgnores(path, content));
    }
    if (tool === "psalm" && path.endsWith(".xml")) {
      detected.push(...psalmConfigurationIgnores(path, content));
      if (/baseline/iu.test(path)) detected.push(...psalmBaselineEntries(path, content));
    }
  }
  return detected;
}

async function walk(root: string, directory: string, paths: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name) || path === ".ai/runs" || path.startsWith(".ai/runs/")) continue;
      await walk(root, absolute, paths);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Verifier ignored-finding input is symbolic: ${path}`);
    } else if (entry.isFile() && relevantFile(path)) {
      paths.push(path);
      if (paths.length > maximumFiles) throw new Error("Verifier ignored-finding file inventory is excessive.");
    }
  }
}

function relevantFile(path: string): boolean {
  return path.endsWith(".php") || path.endsWith(".neon") || path.endsWith(".neon.dist") || path.endsWith(".xml");
}

function inlineIgnores(tool: string, path: string, content: string): readonly DetectedIgnore[] {
  if (!path.endsWith(".php")) return [];
  const pattern = tool === "phpstan"
    ? /@phpstan-ignore(?:-next-line|-line)?(?:\s+[^\r\n*]+)?/gu
    : /@psalm-suppress\s+[A-Za-z0-9_\\, -]+/gu;
  return phpComments(content).flatMap((comment) => [...comment.matchAll(pattern)].map((match) => ({
      mechanism: "inline-directive" as const,
      path,
      normalizedValue: normalize(match[0]),
  })));
}

function phpComments(source: string): readonly string[] {
  const comments: string[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (source.startsWith("<<<", index)) {
      const opener = /^<<<\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*\r?\n/u.exec(source.slice(index));
      if (!opener?.[1]) throw new Error("Verifier ignored-finding PHP input has malformed heredoc syntax.");
      const bodyStart = index + opener[0].length;
      const terminator = new RegExp(`^\\s*${escapeRegExp(opener[1])};?\\s*$`, "mu").exec(source.slice(bodyStart));
      if (!terminator || terminator.index === undefined) throw new Error("Verifier ignored-finding PHP input has an unclosed heredoc.");
      const terminatorEnd = source.indexOf("\n", bodyStart + terminator.index);
      index = terminatorEnd < 0 ? source.length : terminatorEnd + 1;
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === quote) { index += 1; closed = true; break; }
        else index += 1;
      }
      if (!closed) throw new Error("Verifier ignored-finding PHP input has malformed lexical structure.");
      continue;
    }
    if (source.startsWith("//", index) || (character === "#" && source[index + 1] !== "[")) {
      const end = source.indexOf("\n", index);
      comments.push(source.slice(index, end < 0 ? source.length : end));
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Verifier ignored-finding PHP input has malformed lexical structure.");
      comments.push(source.slice(index, end + 2));
      index = end + 2;
      continue;
    }
    index += 1;
  }
  return comments;
}

function phpStanConfigurationIgnores(path: string, content: string): readonly DetectedIgnore[] {
  const lines = content.split(/\r?\n/u);
  const detected: DetectedIgnore[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const key = /^(\s*)ignoreErrors\s*:\s*(.*)$/u.exec(line);
    if (!key) continue;
    if (key[2]!.trim()) {
      detected.push({ mechanism: /baseline/iu.test(path) ? "baseline-entry" : "configuration-suppression", path, normalizedValue: normalize(key[2]!) });
      continue;
    }
    const indentation = key[1]!.length;
    const block: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const candidate = lines[index]!;
      if (candidate.trim() && leadingWhitespace(candidate) <= indentation) {
        index -= 1;
        break;
      }
      block.push(candidate);
    }
    const entries = splitNeonEntries(block);
    for (const entry of entries) {
      detected.push({
        mechanism: /baseline/iu.test(path) ? "baseline-entry" : "configuration-suppression",
        path,
        normalizedValue: normalize(entry),
      });
    }
  }
  return detected;
}

function splitNeonEntries(lines: readonly string[]): readonly string[] {
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^\s*-\s*/u.test(line) && current.length > 0) {
      entries.push(current.join("\n"));
      current = [];
    }
    if (line.trim()) current.push(line);
  }
  if (current.length > 0) entries.push(current.join("\n"));
  return entries;
}

function psalmConfigurationIgnores(path: string, content: string): readonly DetectedIgnore[] {
  const detected: DetectedIgnore[] = [];
  const patterns = [
    /<([A-Z][A-Za-z0-9_]*)\b[^>]*\berrorLevel\s*=\s*["']suppress["'][^>]*(?:\/>|>[\s\S]*?<\/\1\s*>)/gu,
    /<([A-Z][A-Za-z0-9_]*)\b[^>]*>[\s\S]*?<errorLevel\b[^>]*\btype\s*=\s*["']suppress["'][^>]*(?:\/>|>[\s\S]*?<\/errorLevel\s*>)[\s\S]*?<\/\1\s*>/gu,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      detected.push({ mechanism: "configuration-suppression", path, normalizedValue: normalize(match[0]) });
    }
  }
  return detected;
}

function psalmBaselineEntries(path: string, content: string): readonly DetectedIgnore[] {
  const detected: DetectedIgnore[] = [];
  const pattern = /<([A-Z][A-Za-z0-9_]*)\b[^>]*(?:\/>|>[\s\S]*?<\/\1\s*>)/gu;
  for (const match of content.matchAll(pattern)) {
    if (match[1] === "File" || match[1] === "Files") continue;
    detected.push({ mechanism: "baseline-entry", path, normalizedValue: normalize(match[0]) });
  }
  return detected;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function leadingWhitespace(value: string): number {
  return /^\s*/u.exec(value)?.[0].length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
