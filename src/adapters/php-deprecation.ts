import { createHash } from "node:crypto";
import { glob, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { EvidenceCommandOutput, EvidenceResult, EvidenceRunner } from "../contracts.js";
import type { CommandCapability, ImprovementCandidate } from "../domain/model.js";
import { phpEvidenceProvenance } from "./php-provenance.js";
import { reproducibleEvidence } from "../domain/candidate-reproducibility.js";

export const phpDeprecationSchemaVersion = "php-deprecated-api-evidence/v1" as const;
export const laravelDeprecationRuleSetVersion = "laravel-deprecation-rules/v1" as const;

export type DeprecatedApiEvidenceStatus =
  | "success"
  | "code-finding"
  | "unsupported-version"
  | "unsupported-rules"
  | "unavailable-tool"
  | "configuration-failure"
  | "timeout"
  | "truncated"
  | "infrastructure-failure";

export interface DeprecatedApiFinding {
  readonly id: string;
  readonly ecosystem: "php" | "laravel";
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  readonly rule: string;
  readonly replacement: string | null;
  readonly message: string;
  readonly ruleProvenance: string;
}

export interface DeprecatedApiEvidence {
  readonly schemaVersion: typeof phpDeprecationSchemaVersion;
  readonly status: DeprecatedApiEvidenceStatus;
  readonly targetVersion: string | null;
  readonly targetVersionSource: string | null;
  readonly ruleSetVersion: string;
  readonly result: EvidenceResult | null;
  readonly findings: readonly DeprecatedApiFinding[];
  readonly candidates: readonly ImprovementCandidate[];
}

interface ComposerManifest {
  readonly require?: Readonly<Record<string, string>>;
  readonly config?: { readonly platform?: { readonly php?: string } };
}

interface ComposerLock {
  readonly packages?: readonly ComposerPackage[];
  readonly "packages-dev"?: readonly ComposerPackage[];
}

interface ComposerPackage {
  readonly name?: string;
  readonly version?: string;
}

interface VersionTarget {
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly source: string;
}

const findingLimit = 250;
const sourceFileLimit = 2 * 1024 * 1024;
const sourceCountLimit = 5_000;

export function phpDeprecationCommand(targetVersion: string): readonly string[] {
  return [
    "vendor/bin/phpcs",
    "--report=json",
    "--standard=PHPCompatibility",
    "--runtime-set",
    "testVersion",
    targetVersion,
    "--extensions=php",
    "--ignore=vendor/*,tests/*,.daily-improver/*",
    ".",
  ];
}

export async function collectPhpDeprecatedApiEvidence(
  root: string,
  capability: CommandCapability,
  runner: EvidenceRunner,
): Promise<DeprecatedApiEvidence> {
  selectPhpCompatibility(capability);
  let target: VersionTarget | null;
  try {
    target = await resolvePhpTarget(root);
  } catch {
    return emptyEvidence("configuration-failure", null, "PHPCompatibility", null);
  }
  if (!target || target.major < 7 || target.major > 8) {
    return emptyEvidence("unsupported-version", target, "PHPCompatibility", null);
  }

  const run = await runner.run({
    identity: "phpcompatibility.deprecations",
    command: phpDeprecationCommand(target.version),
    cwd: root,
    timeoutMs: 120_000,
    maxOutputBytes: 512 * 1024,
    provenance: phpEvidenceProvenance(
      ["vendor/bin/phpcs", "--version"],
      ["composer.json", "composer.lock"],
    ),
    classify: (output) => classifyPhpCompatibility(root, output),
  });

  const combined = `${run.output.stdout}\n${run.output.stderr}`;
  if (/PHPCompatibility.*(?:does not support|unsupported).*(?:PHP|testVersion)|invalid testVersion/i.test(combined)) {
    return emptyEvidence("unsupported-rules", target, "PHPCompatibility", run.result);
  }
  const baseStatus = run.result.outputTruncated ? "truncated" : mapResultStatus(run.result.status);
  if (baseStatus !== "success" && baseStatus !== "code-finding") {
    return emptyEvidence(baseStatus, target, "PHPCompatibility", run.result);
  }

  try {
    const parsed = parsePhpCompatibility(root, run.output.stdout);
    const status: DeprecatedApiEvidenceStatus = parsed.truncated
      ? "truncated"
      : parsed.findings.length > 0 ? "code-finding" : "success";
    return evidence(status, target, "PHPCompatibility", run.result, parsed.findings);
  } catch {
    return emptyEvidence("infrastructure-failure", target, "PHPCompatibility", run.result);
  }
}

export async function collectLaravelDeprecatedApiEvidence(
  root: string,
  ruleSetVersion: string = laravelDeprecationRuleSetVersion,
): Promise<DeprecatedApiEvidence> {
  let target: VersionTarget | null;
  try {
    target = await resolveLaravelTarget(root);
  } catch {
    return emptyEvidence("configuration-failure", null, ruleSetVersion, null);
  }
  if (!target || target.major < 8 || target.major > 13) {
    return emptyEvidence("unsupported-version", target, ruleSetVersion, null);
  }
  if (ruleSetVersion !== laravelDeprecationRuleSetVersion) {
    return emptyEvidence("unsupported-rules", target, ruleSetVersion, null);
  }

  try {
    const findings: DeprecatedApiFinding[] = [];
    let files = 0;
    for await (const path of glob(["app/**/*.php", "src/**/*.php", "routes/**/*.php", "config/**/*.php"], { cwd: root })) {
      files += 1;
      if (files > sourceCountLimit) return evidence("truncated", target, ruleSetVersion, null, findings);
      const metadata = await stat(join(root, path));
      if (!metadata.isFile() || metadata.size > sourceFileLimit) {
        return evidence("truncated", target, ruleSetVersion, null, findings);
      }
      const lines = maskPhpNonCode(await readFile(join(root, path), "utf8")).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        for (const rule of laravelRules) {
          if (target.major < rule.effectiveMajor || !rule.pattern.test(line)) continue;
          findings.push(deprecatedFinding(
            "laravel",
            path.replaceAll("\\", "/"),
            index + 1,
            rule.symbol,
            rule.id,
            rule.replacement,
            `${rule.symbol} is deprecated or removed for Laravel ${target.major}; use ${rule.replacement}.`,
            rule.provenance,
          ));
          if (findings.length >= findingLimit) {
            return evidence("truncated", target, ruleSetVersion, null, findings);
          }
        }
      }
    }
    return evidence(findings.length > 0 ? "code-finding" : "success", target, ruleSetVersion, null, findings);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return emptyEvidence(code === "ENOENT" || error instanceof SyntaxError ? "configuration-failure" : "infrastructure-failure", target, ruleSetVersion, null);
  }
}

interface LaravelRule {
  readonly id: string;
  readonly effectiveMajor: number;
  readonly symbol: string;
  readonly replacement: string;
  readonly pattern: RegExp;
  readonly provenance: string;
}

const laravelRules: readonly LaravelRule[] = [
  {
    id: "laravel-8-mail-send-now",
    effectiveMajor: 8,
    symbol: "Mail::sendNow",
    replacement: "Mail::send",
    pattern: /\bMail\s*::\s*sendNow\s*\(/,
    provenance: "https://laravel.com/docs/8.x/upgrade#the-sendnow-method",
  },
  {
    id: "laravel-8-elixir-helper",
    effectiveMajor: 8,
    symbol: "elixir()",
    replacement: "Laravel Mix asset helpers",
    pattern: /(?<![A-Za-z0-9_])elixir\s*\(/,
    provenance: "https://laravel.com/docs/8.x/upgrade#the-elixir-helper",
  },
  {
    id: "laravel-10-bus-dispatch-now",
    effectiveMajor: 10,
    symbol: "Bus::dispatchNow",
    replacement: "Bus::dispatchSync",
    pattern: /\bBus\s*::\s*dispatchNow\s*\(/,
    provenance: "https://laravel.com/docs/10.x/upgrade#the-bus-dispatchnow-method",
  },
  {
    id: "laravel-10-dispatch-now-helper",
    effectiveMajor: 10,
    symbol: "dispatch_now()",
    replacement: "dispatch_sync()",
    pattern: /(?<![A-Za-z0-9_])dispatch_now\s*\(/,
    provenance: "https://laravel.com/docs/10.x/upgrade#the-bus-dispatchnow-method",
  },
  {
    id: "laravel-10-redirect-home",
    effectiveMajor: 10,
    symbol: "Redirect::home",
    replacement: "Redirect::route('home')",
    pattern: /\bRedirect\s*::\s*home\s*\(/,
    provenance: "https://laravel.com/docs/10.x/upgrade#the-redirect-home-method",
  },
  {
    id: "laravel-13-verify-csrf-token-alias",
    effectiveMajor: 13,
    symbol: "VerifyCsrfToken::class",
    replacement: "PreventRequestForgery::class",
    pattern: /\b(?:VerifyCsrfToken|ValidateCsrfToken)\s*::\s*class\b/,
    provenance: "https://laravel.com/docs/13.x/upgrade#request-forgery-protection",
  },
];

function selectPhpCompatibility(capability: CommandCapability): void {
  if (capability.kind !== "deprecation-analysis" || capability.source !== "manifest" || capability.framework !== "phpcompatibility") {
    throw new Error("PHP deprecation analysis requires manifest-detected PHPCompatibility.");
  }
}

function classifyPhpCompatibility(root: string, output: EvidenceCommandOutput): "success" | "code-finding" | "configuration-failure" | "infrastructure-failure" {
  if (output.outputTruncated) return "infrastructure-failure";
  const combined = `${output.stdout}\n${output.stderr}`;
  if (/ERROR:.*(?:standard|ruleset|option|file)|coding standard .*not installed|invalid testVersion|no files were specified/i.test(combined)) {
    return "configuration-failure";
  }
  try {
    const parsed = parsePhpCompatibility(root, output.stdout);
    return parsed.findings.length > 0 ? "code-finding" : "success";
  } catch {
    return "infrastructure-failure";
  }
}

function parsePhpCompatibility(root: string, output: string): { readonly findings: DeprecatedApiFinding[]; readonly truncated: boolean } {
  const value: unknown = JSON.parse(output);
  if (!isRecord(value) || !isRecord(value.files)) throw new Error("PHPCS JSON output is invalid.");
  const findings: DeprecatedApiFinding[] = [];
  for (const [file, fileResult] of Object.entries(value.files)) {
    if (!isRecord(fileResult) || !Array.isArray(fileResult.messages)) throw new Error("PHPCS file output is invalid.");
    for (const message of fileResult.messages) {
      if (!isRecord(message)) throw new Error("PHPCS message output is invalid.");
      const text = boundedString(message.message, 512);
      const rule = boundedString(message.source, 160);
      const line = positiveInteger(message.line);
      if (!text || !rule || !line) throw new Error("PHPCS finding identity is missing.");
      if (!/(?:deprecated|removed)/i.test(`${rule} ${text}`)) continue;
      findings.push(deprecatedFinding(
        "php",
        normalizeFile(root, file),
        line,
        extractPhpSymbol(text) ?? rule,
        rule,
        extractReplacement(text),
        text,
        "PHPCompatibility/PHPCompatibility",
      ));
      if (findings.length >= findingLimit) return { findings, truncated: true };
    }
  }
  return { findings, truncated: false };
}

async function resolvePhpTarget(root: string): Promise<VersionTarget | null> {
  const manifest = await readManifest(root);
  const platform = manifest.config?.platform?.php;
  if (platform) return parseVersion(platform, "composer.json config.platform.php");
  return parseVersion(manifest.require?.php, "composer.json require.php");
}

async function resolveLaravelTarget(root: string): Promise<VersionTarget | null> {
  try {
    const lock = JSON.parse(await readFile(join(root, "composer.lock"), "utf8")) as ComposerLock;
    const installed = [...(lock.packages ?? []), ...(lock["packages-dev"] ?? [])]
      .find((dependency) => dependency.name === "laravel/framework")?.version;
    const parsed = parseVersion(installed, "composer.lock laravel/framework");
    if (parsed) return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifest = await readManifest(root);
  return parseVersion(manifest.require?.["laravel/framework"], "composer.json require.laravel/framework");
}

async function readManifest(root: string): Promise<ComposerManifest> {
  return JSON.parse(await readFile(join(root, "composer.json"), "utf8")) as ComposerManifest;
}

function parseVersion(value: string | undefined, source: string): VersionTarget | null {
  if (!value || /\|/.test(value)) return null;
  const match = value.trim().match(/^(?:v|\^|~|>=?\s*)?(\d+)\.(\d+)(?:\.\d+)?(?:\.\*)?(?:\s.*)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return { version: `${major}.${minor}`, major, minor, source };
}

function evidence(
  status: DeprecatedApiEvidenceStatus,
  target: VersionTarget | null,
  ruleSetVersion: string,
  result: EvidenceResult | null,
  findings: readonly DeprecatedApiFinding[],
): DeprecatedApiEvidence {
  return {
    schemaVersion: phpDeprecationSchemaVersion,
    status,
    targetVersion: target?.version ?? null,
    targetVersionSource: target?.source ?? null,
    ruleSetVersion,
    result,
    findings,
    candidates: findings.map(deprecationCandidate),
  };
}

function emptyEvidence(status: DeprecatedApiEvidenceStatus, target: VersionTarget | null, ruleSetVersion: string, result: EvidenceResult | null): DeprecatedApiEvidence {
  return evidence(status, target, ruleSetVersion, result, []);
}

function deprecatedFinding(
  ecosystem: DeprecatedApiFinding["ecosystem"],
  file: string,
  line: number,
  symbol: string,
  rule: string,
  replacement: string | null,
  message: string,
  ruleProvenance: string,
): DeprecatedApiFinding {
  const identity = `${ecosystem}:${file}:${line}:${rule}:${symbol}`;
  return {
    id: `${ecosystem}-deprecated:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    ecosystem,
    file,
    line,
    symbol: symbol.slice(0, 160),
    rule: rule.slice(0, 160),
    replacement: replacement?.slice(0, 256) ?? null,
    message: message.slice(0, 512),
    ruleProvenance: ruleProvenance.slice(0, 256),
  };
}

function deprecationCandidate(finding: DeprecatedApiFinding): ImprovementCandidate {
  return {
    id: finding.id,
    kind: "maintainability",
    title: `Replace deprecated ${finding.symbol} in ${finding.file}`,
    rationale: finding.replacement ? `${finding.message} Replacement: ${finding.replacement}.` : finding.message,
    confidence: 0.96,
    impact: 0.78,
    effort: 0.25,
    risk: 0.18,
    subsystemRisk: 0.22,
    testability: 0.85,
    evidence: [
      `${finding.ecosystem} deprecated API at ${finding.file}:${finding.line}`,
      `rule ${finding.rule} (${finding.ruleProvenance})`,
    ],
    suggestedFiles: [finding.file, "tests"],
    target: finding.file,
    estimatedDiffLines: 30,
    reproducibility: reproducibleEvidence(0.97, [`${finding.rule} (${finding.ruleProvenance})`]),
    deduplication: {
      schemaVersion: "candidate-deduplication/v1",
      subsystem: finding.file,
      defect: `deprecated-api:${finding.line}:${finding.symbol}`,
    },
  };
}

function mapResultStatus(status: EvidenceResult["status"]): DeprecatedApiEvidenceStatus {
  if (status === "success" || status === "code-finding" || status === "unavailable-tool" || status === "configuration-failure" || status === "timeout" || status === "infrastructure-failure") return status;
  return "infrastructure-failure";
}

function normalizeFile(root: string, file: string): string {
  const normalized = file.replaceAll("\\", "/");
  if (!isAbsolute(file)) return normalized.replace(/^\.\//, "");
  const path = relative(root, normalized).replaceAll("\\", "/");
  if (path === ".." || path.startsWith("../")) throw new Error("PHPCS finding is outside the repository.");
  return path;
}

function extractPhpSymbol(message: string): string | null {
  return message.match(/["'`](.{1,158}?)["'`]/)?.[1] ?? null;
}

function extractReplacement(message: string): string | null {
  return message.match(/(?:use|replace(?: it)? with)\s+(.{1,240}?)(?:\.|$)/i)?.[1]?.trim() ?? null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function boundedString(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result.slice(0, limit) : null;
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
    if (state === "line-comment") {
      result += " ";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else result += " ";
      continue;
    }
    if (state === "single" || state === "double") {
      result += " ";
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if ((state === "single" && character === "'") || (state === "double" && character === "\"")) state = "code";
      continue;
    }
    if (character === "/" && next === "*") {
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
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
