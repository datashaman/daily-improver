import { createHash } from "node:crypto";
import { glob, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ImprovementCandidate } from "../domain/model.js";
import { reproducibleEvidence } from "../domain/candidate-reproducibility.js";

export const phpValidationErrorRuleSetVersion = "php-validation-error-rules/v1" as const;
export const phpValidationErrorSchemaVersion = "php-validation-error-evidence/v1" as const;

const sourcePatterns = ["app/**/*.php", "src/**/*.php"] as const;
const sourceFileLimitBytes = 2 * 1024 * 1024;
const configurationLimitBytes = 1024 * 1024;
const sourcePathLimitBytes = 512;
const sourceCountLimit = 5_000;
const findingLimit = 250;

export type ValidationErrorEvidenceStatus =
  | "clean"
  | "code-finding"
  | "unsupported-input"
  | "configuration-failure"
  | "truncated"
  | "malformed-input"
  | "infrastructure-failure";

export type ValidationErrorFindingKind = "missing-validation" | "error-handling";

export interface ValidationErrorFinding {
  readonly id: string;
  readonly kind: ValidationErrorFindingKind;
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
  readonly ruleProvenance: typeof phpValidationErrorRuleSetVersion;
}

export interface ValidationErrorEvidence {
  readonly schemaVersion: typeof phpValidationErrorSchemaVersion;
  readonly status: ValidationErrorEvidenceStatus;
  readonly provenance: {
    readonly mechanism: "versioned-adapter-rules";
    readonly ruleSetVersion: typeof phpValidationErrorRuleSetVersion;
    readonly sourcePatterns: typeof sourcePatterns;
    readonly configuration: {
      readonly path: "composer.json";
      readonly sha256: string;
      readonly bytes: number;
    };
  };
  readonly findings: readonly ValidationErrorFinding[];
  readonly candidates: readonly ImprovementCandidate[];
}

interface SourceAccess {
  readonly paths: (root: string) => AsyncIterable<string>;
  readonly metadata: (path: string) => Promise<{ readonly isFile: () => boolean; readonly size: number }>;
  readonly read: (path: string) => Promise<string>;
}

const defaultSourceAccess: SourceAccess = {
  paths: (root) => glob(sourcePatterns, { cwd: root }),
  metadata: stat,
  read: (path) => readFile(path, "utf8"),
};

interface ComposerManifest {
  readonly require?: Readonly<Record<string, string>>;
  readonly "require-dev"?: Readonly<Record<string, string>>;
}

export async function collectPhpValidationErrorEvidence(
  root: string,
  access: SourceAccess = defaultSourceAccess,
): Promise<ValidationErrorEvidence> {
  let manifest: ComposerManifest;
  let manifestContent: string;
  try {
    const manifestMetadata = await stat(join(root, "composer.json"));
    if (manifestMetadata.size > configurationLimitBytes) return emptyEvidence("truncated", emptyConfiguration());
    manifestContent = await readFile(join(root, "composer.json"), "utf8");
    const parsed: unknown = JSON.parse(manifestContent);
    if (!isRecord(parsed) || !optionalStringMap(parsed.require) || !optionalStringMap(parsed["require-dev"])) {
      return emptyEvidence("configuration-failure", emptyConfiguration());
    }
    manifest = parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return emptyEvidence(
      code === "ENOENT" || error instanceof SyntaxError ? "configuration-failure" : "infrastructure-failure",
      emptyConfiguration(),
    );
  }
  const configuration = {
    path: "composer.json" as const,
    sha256: `sha256:${createHash("sha256").update(manifestContent).digest("hex")}`,
    bytes: Buffer.byteLength(manifestContent),
  };
  const packages = { ...manifest.require, ...manifest["require-dev"] };
  if (!packages["laravel/framework"]) return emptyEvidence("unsupported-input", configuration);

  const findings: ValidationErrorFinding[] = [];
  let files = 0;
  try {
    for await (const relativePath of access.paths(root)) {
      files += 1;
      if (files > sourceCountLimit) return evidence("truncated", findings, configuration);
      const path = join(root, relativePath);
      const metadata = await access.metadata(path);
      if (!metadata.isFile()) continue;
      if (metadata.size > sourceFileLimitBytes) return evidence("truncated", findings, configuration);
      const source = await access.read(path);
      const normalizedPath = relativePath.replaceAll("\\", "/");
      if (Buffer.byteLength(normalizedPath) > sourcePathLimitBytes) return evidence("truncated", findings, configuration);
      let fileFindings: readonly ValidationErrorFinding[];
      try {
        fileFindings = analysePhpSource(normalizedPath, source);
      } catch {
        return evidence("malformed-input", findings, configuration);
      }
      findings.push(...fileFindings);
      if (findings.length >= findingLimit) return evidence("truncated", findings.slice(0, findingLimit), configuration);
    }
  } catch {
    return evidence("infrastructure-failure", findings, configuration);
  }
  if (files === 0) return emptyEvidence("unsupported-input", configuration);
  return evidence(findings.length > 0 ? "code-finding" : "clean", findings, configuration);
}

export function analysePhpSource(file: string, source: string): readonly ValidationErrorFinding[] {
  const code = maskPhpNonCode(source);
  assertBalancedBraces(code);
  const findings: ValidationErrorFinding[] = [];

  const massAssignment = /(?:->|::)\s*(?:create|update|fill|forceFill)\s*\(\s*\$request\s*->\s*all\s*\(\s*\)\s*\)/g;
  for (const match of code.matchAll(massAssignment)) {
    findings.push(finding(
      "missing-validation",
      file,
      lineAt(code, match.index),
      "laravel-request-all-mass-assignment",
      "Laravel request data is passed wholesale to a mass-assignment API without an explicit validated-data boundary.",
    ));
  }

  const catchPattern = /catch\s*\(\s*(?:\\?(?:Throwable|Exception)|[^)]{1,240}?)(?:\s+\$[A-Za-z_][A-Za-z0-9_]*)?\s*\)\s*\{/g;
  for (const match of code.matchAll(catchPattern)) {
    const openingBrace = (match.index ?? 0) + match[0].lastIndexOf("{");
    const closingBrace = matchingBrace(code, openingBrace);
    const body = code.slice(openingBrace + 1, closingBrace).trim();
    const declaration = match[0];
    if (body === "") {
      findings.push(finding(
        "error-handling",
        file,
        lineAt(code, match.index),
        "php-empty-catch",
        "An exception is caught by an empty catch block and is neither handled nor propagated.",
      ));
    } else if (
      /\\?(?:Throwable|Exception)\b/.test(declaration)
      && /^return\s+(?:null|false|\[\])\s*;?$/.test(body)
    ) {
      findings.push(finding(
        "error-handling",
        file,
        lineAt(code, match.index),
        "php-broad-catch-default-return",
        "A broad exception catch returns only a default value without reporting or rethrowing the failure.",
      ));
    }
  }
  return findings;
}

type ConfigurationProvenance = ValidationErrorEvidence["provenance"]["configuration"];

function evidence(
  status: ValidationErrorEvidenceStatus,
  findings: readonly ValidationErrorFinding[],
  configuration: ConfigurationProvenance,
): ValidationErrorEvidence {
  return {
    schemaVersion: phpValidationErrorSchemaVersion,
    status,
    provenance: {
      mechanism: "versioned-adapter-rules",
      ruleSetVersion: phpValidationErrorRuleSetVersion,
      sourcePatterns,
      configuration,
    },
    findings,
    candidates: findings.map(validationErrorCandidate),
  };
}

function emptyEvidence(status: ValidationErrorEvidenceStatus, configuration: ConfigurationProvenance): ValidationErrorEvidence {
  return evidence(status, [], configuration);
}

function emptyConfiguration(): ConfigurationProvenance {
  return { path: "composer.json", sha256: "sha256:unavailable", bytes: 0 };
}

function finding(
  kind: ValidationErrorFindingKind,
  file: string,
  line: number,
  rule: string,
  message: string,
): ValidationErrorFinding {
  const identity = `${kind}:${file}:${line}:${rule}`;
  return {
    id: `${kind}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    kind,
    file: file.slice(0, 512),
    line,
    rule: rule.slice(0, 160),
    message: message.slice(0, 512),
    ruleProvenance: phpValidationErrorRuleSetVersion,
  };
}

function validationErrorCandidate(item: ValidationErrorFinding): ImprovementCandidate {
  const validation = item.kind === "missing-validation";
  return {
    id: item.id,
    kind: "maintainability",
    title: validation ? `Validate mass-assigned request data in ${item.file}` : `Handle the swallowed exception in ${item.file}`,
    rationale: item.message,
    confidence: validation ? 0.96 : 0.98,
    impact: validation ? 0.9 : 0.82,
    effort: 0.35,
    risk: 0.24,
    subsystemRisk: 0.3,
    testability: 0.9,
    evidence: [`${item.rule} at ${item.file}:${item.line}`, `rule set ${item.ruleProvenance}`],
    suggestedFiles: [item.file, "tests"],
    target: item.file,
    estimatedDiffLines: 40,
    reproducibility: reproducibleEvidence(0.97, [item.ruleProvenance]),
  };
}

function assertBalancedBraces(code: string): void {
  let depth = 0;
  for (const character of code) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    if (depth < 0) throw new Error("Unexpected closing brace.");
  }
  if (depth !== 0) throw new Error("Unclosed brace.");
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
  throw new Error("Unclosed catch block.");
}

function lineAt(source: string, index: number | undefined): number {
  return source.slice(0, index ?? 0).split("\n").length;
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
  if (state === "single" || state === "double" || state === "block-comment") throw new Error("Unclosed PHP lexical region.");
  return maskPhpHeredocs(result);
}

function maskPhpHeredocs(source: string): string {
  const lines = source.split(/(?<=\n)/);
  let terminator: string | null = null;
  const masked = lines.map((line) => {
    if (terminator) {
      const terminatorPattern = new RegExp(`^\\s*${escapeRegExp(terminator)};?\\s*(?:\\r?\\n)?$`);
      if (terminatorPattern.test(line)) terminator = null;
      return line.replace(/[^\r\n]/g, " ");
    }
    const opener = line.match(/<<<\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/);
    if (!opener?.[1]) return line;
    terminator = opener[1];
    return line.replace(/[^\r\n]/g, " ");
  }).join("");
  if (terminator) throw new Error("Unclosed PHP heredoc.");
  return masked;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringMap(value: unknown): value is Readonly<Record<string, string>> | undefined {
  return value === undefined || (isRecord(value) && Object.values(value).every((item) => typeof item === "string"));
}
