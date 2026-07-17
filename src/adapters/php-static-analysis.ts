import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type {
  EvidenceCommandOutput,
  EvidenceResult,
  EvidenceResultStatus,
  EvidenceRunner,
} from "../contracts.js";
import type { CommandCapability, ImprovementCandidate } from "../domain/model.js";
import { phpEvidenceProvenance } from "./php-provenance.js";

export const phpStaticAnalysisSchemaVersion = "php-static-analysis-evidence/v1" as const;

export interface PhpStaticAnalysisFinding {
  readonly id: string;
  readonly tool: "phpstan" | "psalm";
  readonly file: string;
  readonly line: number | null;
  readonly rule: string | null;
  readonly message: string;
}

export interface PhpStaticAnalysisEvidence {
  readonly schemaVersion: typeof phpStaticAnalysisSchemaVersion;
  readonly result: EvidenceResult;
  readonly findings: readonly PhpStaticAnalysisFinding[];
  readonly candidates: readonly ImprovementCandidate[];
}

type StaticAnalysisTool = PhpStaticAnalysisFinding["tool"];

const trustedCommands: Readonly<Record<StaticAnalysisTool, readonly string[]>> = {
  phpstan: [
    "vendor/bin/phpstan",
    "analyse",
    "--error-format=json",
    "--no-progress",
    "--no-interaction",
  ],
  psalm: [
    "vendor/bin/psalm",
    "--output-format=json",
    "--no-progress",
  ],
};

export async function collectPhpStaticAnalysisEvidence(
  root: string,
  capability: CommandCapability,
  runner: EvidenceRunner,
): Promise<PhpStaticAnalysisEvidence> {
  const tool = selectTool(capability);
  const run = await runner.run({
    identity: `${tool}.analyse`,
    command: trustedCommands[tool],
    cwd: root,
    timeoutMs: 120_000,
    maxOutputBytes: 512 * 1024,
    provenance: phpEvidenceProvenance(
      [`vendor/bin/${tool}`, "--version"],
      tool === "phpstan"
        ? ["phpstan.neon", "phpstan.neon.dist"]
        : ["psalm.xml", "psalm.xml.dist"],
    ),
    classify: (output) => classifyStaticAnalysis(tool, root, output),
  });

  const findings = run.result.status === "code-finding"
    ? parseFindings(tool, root, run.output.stdout)
    : [];

  return {
    schemaVersion: phpStaticAnalysisSchemaVersion,
    result: run.result,
    findings,
    candidates: findings.map(staticAnalysisCandidate),
  };
}

function selectTool(capability: CommandCapability): StaticAnalysisTool {
  if (capability.kind !== "static-analysis" || capability.source !== "manifest") {
    throw new Error("PHP static analysis requires a manifest-detected capability.");
  }
  if (capability.framework === "phpstan" || capability.framework === "psalm") {
    return capability.framework;
  }
  throw new Error("Unsupported PHP static-analysis capability.");
}

function classifyStaticAnalysis(
  tool: StaticAnalysisTool,
  root: string,
  output: EvidenceCommandOutput,
): EvidenceResultStatus {
  if (output.outputTruncated) return "infrastructure-failure";

  const combined = `${output.stdout}\n${output.stderr}`;
  if (isConfigurationFailure(combined)) return "configuration-failure";

  try {
    const parsed = parseOutput(tool, root, output.stdout);
    if (parsed.globalErrors.length > 0) {
      return parsed.globalErrors.some((error) => /internal error|worker.*crash|child process/i.test(error))
        ? "infrastructure-failure"
        : "configuration-failure";
    }
    if (parsed.findings.length > 0) return "code-finding";
    return output.exitCode === 0 ? "success" : "infrastructure-failure";
  } catch {
    return "infrastructure-failure";
  }
}

function isConfigurationFailure(output: string): boolean {
  return /(?:configuration|config file|config\/schema).*(?:invalid|error|does not exist|not found|cannot|could not)|(?:invalid|cannot|could not).*(?:configuration|config file)|no files found to analyse|unable to determine project root|cannot resolve.*(?:path|include)/i.test(output);
}

function parseFindings(
  tool: StaticAnalysisTool,
  root: string,
  output: string,
): readonly PhpStaticAnalysisFinding[] {
  return parseOutput(tool, root, output).findings;
}

interface ParsedStaticAnalysis {
  readonly findings: readonly PhpStaticAnalysisFinding[];
  readonly globalErrors: readonly string[];
}

function parseOutput(tool: StaticAnalysisTool, root: string, output: string): ParsedStaticAnalysis {
  const value: unknown = JSON.parse(output);
  return tool === "phpstan" ? parsePhpStan(root, value) : parsePsalm(root, value);
}

function parsePhpStan(root: string, value: unknown): ParsedStaticAnalysis {
  if (!isRecord(value) || !isRecord(value.files) || !Array.isArray(value.errors)) {
    throw new Error("PHPStan output does not match its JSON schema.");
  }

  const findings: PhpStaticAnalysisFinding[] = [];
  for (const [fileKey, fileResult] of Object.entries(value.files)) {
    if (!isRecord(fileResult) || !Array.isArray(fileResult.messages)) {
      throw new Error("PHPStan file output is invalid.");
    }
    for (const message of fileResult.messages) {
      if (!isRecord(message)) throw new Error("PHPStan message output is invalid.");
      const text = boundedString(message.message, 512);
      if (!text) throw new Error("PHPStan message is missing.");
      findings.push(finding(
        "phpstan",
        normalizeFile(root, boundedString(message.file, 1024) ?? fileKey),
        positiveInteger(message.line),
        boundedString(message.identifier, 128) ?? null,
        text,
      ));
    }
  }

  return { findings, globalErrors: boundedStrings(value.errors) };
}

function parsePsalm(root: string, value: unknown): ParsedStaticAnalysis {
  if (!Array.isArray(value)) throw new Error("Psalm output must be a JSON array.");
  const findings: PhpStaticAnalysisFinding[] = [];
  for (const issue of value) {
    if (!isRecord(issue)) throw new Error("Psalm issue output is invalid.");
    const file = boundedString(issue.file_path, 1024) ?? boundedString(issue.file_name, 1024);
    const message = boundedString(issue.message, 512);
    if (!file || !message) throw new Error("Psalm issue identity is missing.");
    findings.push(finding(
      "psalm",
      normalizeFile(root, file),
      positiveInteger(issue.line_from),
      boundedString(issue.type, 128) ?? boundedString(issue.shortcode, 128) ?? null,
      message,
    ));
  }
  return { findings, globalErrors: [] };
}

function finding(
  tool: StaticAnalysisTool,
  file: string,
  line: number | null,
  rule: string | null,
  message: string,
): PhpStaticAnalysisFinding {
  const identity = `${tool}:${file}:${line ?? 0}:${rule ?? "unknown"}:${message}`;
  return {
    id: `${tool}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    tool,
    file,
    line,
    rule,
    message,
  };
}

function staticAnalysisCandidate(finding: PhpStaticAnalysisFinding): ImprovementCandidate {
  return {
    id: finding.id,
    kind: "static-analysis",
    title: `Resolve ${finding.tool} finding in ${finding.file}`,
    rationale: finding.message,
    confidence: 0.94,
    impact: 0.72,
    effort: 0.3,
    risk: 0.15,
    evidence: [
      `${finding.tool} finding at ${finding.file}:${finding.line ?? "unknown"}`,
      `rule ${finding.rule ?? "not reported"}`,
    ],
    suggestedFiles: [finding.file, "tests"],
    target: finding.file,
    estimatedDiffLines: 40,
  };
}

function normalizeFile(root: string, file: string): string {
  if (file.trim().length === 0) throw new Error("Static-analysis file identity is missing.");
  const normalized = file.replaceAll("\\", "/");
  if (!isAbsolute(file)) return normalized.replace(/^\.\//, "");
  const relativePath = relative(root, normalized).replaceAll("\\", "/");
  if (relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error("Static-analysis finding is outside the repository.");
  }
  return relativePath;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function boundedStrings(value: readonly unknown[]): string[] {
  return value.map((entry) => {
    const bounded = boundedString(entry, 512);
    if (!bounded) throw new Error("Static-analysis global error is invalid.");
    return bounded;
  });
}

function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, limit) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
