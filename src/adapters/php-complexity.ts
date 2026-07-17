import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { glob, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EvidenceCommandOutput,
  EvidenceResult,
  EvidenceResultStatus,
  EvidenceRunner,
} from "../contracts.js";
import type { CommandCapability, ImprovementCandidate } from "../domain/model.js";
import { phpEvidenceProvenance } from "./php-provenance.js";
import { reproducibleEvidence } from "../domain/candidate-reproducibility.js";

export const phpComplexitySchemaVersion = "php-complexity-evidence/v1" as const;

const reportLimitBytes = 2 * 1024 * 1024;
const findingLimit = 200;
const highComplexityThreshold = 10;

export function phpComplexityCommand(reportPath: string): readonly string[] {
  return ["vendor/bin/phpmetrics", `--report-json=${reportPath}`, "--exclude=vendor", "app/Domain,src"];
}

export interface PhpComplexityFinding {
  readonly id: string;
  readonly tool: "phpmetrics";
  readonly symbol: string;
  readonly file: string | null;
  readonly cyclomaticComplexity: number;
  readonly maintainabilityIndex: number | null;
}

export interface PhpComplexityArtifact {
  readonly sha256: string;
  readonly bytes: number;
  readonly limitBytes: number;
  readonly truncated: boolean;
}

export interface PhpComplexityEvidence {
  readonly schemaVersion: typeof phpComplexitySchemaVersion;
  readonly result: EvidenceResult;
  readonly artifact: PhpComplexityArtifact | null;
  readonly findings: readonly PhpComplexityFinding[];
  readonly candidates: readonly ImprovementCandidate[];
}

export async function collectPhpComplexityEvidence(
  root: string,
  capability: CommandCapability,
  runner: EvidenceRunner,
): Promise<PhpComplexityEvidence> {
  selectPhpMetrics(capability);
  const outputDirectory = await mkdtemp(join(tmpdir(), "daily-improver-complexity-"));
  const reportPath = join(outputDirectory, "phpmetrics.json");

  try {
    const run = await runner.run({
      identity: "phpmetrics.complexity",
      command: phpComplexityCommand(reportPath),
      cwd: root,
      timeoutMs: 120_000,
      maxOutputBytes: 512 * 1024,
      provenance: phpEvidenceProvenance(
        ["vendor/bin/phpmetrics", "--version"],
        [".ai/improver.yml"],
      ),
      classify: classifyComplexityCommand,
    });

    if (run.result.status !== "success" && run.result.status !== "code-finding") {
      return emptyEvidence(run.result);
    }

    const artifact = await readBoundedArtifact(reportPath);
    if (!artifact || artifact.truncated) {
      return emptyEvidence(
        { ...run.result, status: "infrastructure-failure" },
        artifact ? artifactMetadata(artifact) : null,
      );
    }

    try {
      const sourceIndex = await indexPhpSymbols(root);
      const findings = parseReport(artifact.content, sourceIndex);
      const status = findings.length > 0 ? "code-finding" : "success";
      return {
        schemaVersion: phpComplexitySchemaVersion,
        result: { ...run.result, status },
        artifact: artifactMetadata(artifact),
        findings,
        candidates: findings.map(complexityCandidate),
      };
    } catch {
      return emptyEvidence({ ...run.result, status: "infrastructure-failure" }, artifactMetadata(artifact));
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

function selectPhpMetrics(capability: CommandCapability): void {
  if (
    capability.kind !== "complexity"
    || (capability.source !== "manifest" && capability.source !== "configuration")
    || capability.framework !== "phpmetrics"
  ) {
    throw new Error("PHP complexity analysis requires a detected or configured PhpMetrics capability.");
  }
}

function classifyComplexityCommand(output: EvidenceCommandOutput): EvidenceResultStatus {
  if (output.outputTruncated) return "infrastructure-failure";
  const combined = `${output.stdout}\n${output.stderr}`;
  if (/configuration.*(?:invalid|error|does not exist|not found|cannot|could not)|(?:invalid|cannot|could not).*(?:configuration|config file)|no files? (?:found|to analyze|to analyse)|(?:source )?director(?:y|ies).*(?:missing|not found|does not exist)|unknown option|cannot read/i.test(combined)) {
    return "configuration-failure";
  }
  return output.exitCode === 0 ? "success" : "infrastructure-failure";
}

interface CapturedArtifact {
  readonly content: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

async function readBoundedArtifact(path: string): Promise<CapturedArtifact | undefined> {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let bytes = 0;
  let capturedBytes = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      bytes += buffer.length;
      if (capturedBytes < reportLimitBytes) {
        const captured = buffer.subarray(0, reportLimitBytes - capturedBytes);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return {
    content: Buffer.concat(chunks).toString("utf8"),
    sha256: `sha256:${hash.digest("hex")}`,
    bytes,
    truncated: bytes > reportLimitBytes,
  };
}

function parseReport(
  json: string,
  sourceIndex: ReadonlyMap<string, string>,
): readonly PhpComplexityFinding[] {
  const report: unknown = JSON.parse(json);
  if (!isRecord(report)) throw new Error("PhpMetrics report must be an object.");
  const findings: PhpComplexityFinding[] = [];

  for (const [key, value] of Object.entries(report)) {
    if (!isRecord(value)) throw new Error("PhpMetrics metric row is malformed.");
    if (value.ccnMethodMax === undefined && value.ccn === undefined) continue;
    const symbol = boundedString(value.name, 512) ?? boundedString(key, 512);
    if (!symbol) throw new Error("PhpMetrics symbol identity is missing.");
    const complexity = metric(value.ccnMethodMax ?? value.ccn, "complexity");
    const maintainabilityIndex = value.mi === undefined ? null : metric(value.mi, "maintainability index");
    if (complexity <= highComplexityThreshold) continue;
    const file = sourceIndex.get(symbol) ?? null;
    const identity = `${symbol}:${file ?? "unknown"}:${complexity}:${maintainabilityIndex ?? "unknown"}`;
    findings.push({
      id: `complexity:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
      tool: "phpmetrics",
      symbol,
      file,
      cyclomaticComplexity: complexity,
      maintainabilityIndex,
    });
    if (findings.length > findingLimit) throw new Error("PhpMetrics finding limit exceeded.");
  }

  return findings;
}

async function indexPhpSymbols(root: string): Promise<ReadonlyMap<string, string>> {
  const index = new Map<string, string>();
  for await (const file of glob(["app/Domain/**/*.php", "src/**/*.php"], { cwd: root })) {
    const source = await readFile(join(root, file), "utf8");
    const namespace = /\bnamespace\s+([^;{]+)\s*[;{]/.exec(source)?.[1]?.trim();
    for (const match of source.matchAll(/\b(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1];
      if (!name) continue;
      index.set(namespace ? `${namespace}\\${name}` : name, file.replaceAll("\\", "/"));
    }
  }
  return index;
}

function complexityCandidate(finding: PhpComplexityFinding): ImprovementCandidate {
  const location = finding.file ?? finding.symbol;
  const suggestedFiles = finding.file ? [finding.file, "tests"] : ["app/Domain", "src", "tests"];
  return {
    id: finding.id,
    kind: "maintainability",
    title: `Reduce verified complexity in ${location}`,
    rationale: `${finding.symbol} has cyclomatic complexity ${finding.cyclomaticComplexity}.`,
    confidence: finding.file ? 0.88 : 0.82,
    impact: 0.58,
    effort: 0.62,
    risk: 0.32,
    evidence: [
      `PhpMetrics cyclomatic complexity: ${finding.cyclomaticComplexity}`,
      `Maintainability index: ${finding.maintainabilityIndex ?? "not reported"}`,
    ],
    suggestedFiles,
    target: finding.file ?? finding.symbol,
    estimatedDiffLines: 120,
    reproducibility: reproducibleEvidence(0.96, ["PhpMetrics executed collector"]),
  };
}

function emptyEvidence(
  result: EvidenceResult,
  artifact: PhpComplexityArtifact | null = null,
): PhpComplexityEvidence {
  return {
    schemaVersion: phpComplexitySchemaVersion,
    result,
    artifact,
    findings: [],
    candidates: [],
  };
}

function artifactMetadata(artifact: CapturedArtifact): PhpComplexityArtifact {
  return {
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    limitBytes: reportLimitBytes,
    truncated: artifact.truncated,
  };
}

function metric(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`PhpMetrics ${name} is invalid.`);
  }
  return value;
}

function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > limit) return undefined;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
