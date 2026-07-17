import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type {
  EvidenceCommandOutput,
  EvidenceResult,
  EvidenceResultStatus,
  EvidenceRunner,
} from "../contracts.js";
import type { CommandCapability, ImprovementCandidate } from "../domain/model.js";
import { phpEvidenceProvenance } from "./php-provenance.js";
import { reproducibleEvidence } from "../domain/candidate-reproducibility.js";

export const phpCoverageSchemaVersion = "php-coverage-evidence/v1" as const;

const cloverLimitBytes = 2 * 1024 * 1024;
const findingLimit = 200;
const minimumStatements = 5;
const lowCoverageThreshold = 0.5;

export type CoverageTool = "phpunit" | "pest";

export function phpCoverageCommand(tool: CoverageTool, cloverPath: string): readonly string[] {
  return [`vendor/bin/${tool}`, "--coverage-clover", cloverPath, "--colors=never"];
}

export interface PhpCoverageFinding {
  readonly id: string;
  readonly tool: CoverageTool;
  readonly file: string;
  readonly statements: number;
  readonly coveredStatements: number;
  readonly coveragePercent: number;
}

export interface PhpCoverageArtifact {
  readonly sha256: string;
  readonly bytes: number;
  readonly limitBytes: number;
  readonly truncated: boolean;
}

export interface PhpCoverageEvidence {
  readonly schemaVersion: typeof phpCoverageSchemaVersion;
  readonly result: EvidenceResult;
  readonly artifact: PhpCoverageArtifact | null;
  readonly findings: readonly PhpCoverageFinding[];
  readonly candidates: readonly ImprovementCandidate[];
}

export async function collectPhpCoverageEvidence(
  root: string,
  capability: CommandCapability,
  runner: EvidenceRunner,
): Promise<PhpCoverageEvidence> {
  const tool = selectTool(capability);
  const outputDirectory = await mkdtemp(join(tmpdir(), "daily-improver-coverage-"));
  const cloverPath = join(outputDirectory, "clover.xml");

  try {
    const run = await runner.run({
      identity: `${tool}.coverage`,
      command: phpCoverageCommand(tool, cloverPath),
      cwd: root,
      timeoutMs: 180_000,
      maxOutputBytes: 512 * 1024,
      provenance: phpEvidenceProvenance(
        [`vendor/bin/${tool}`, "--version"],
        tool === "pest"
          ? ["phpunit.xml", "phpunit.xml.dist", "tests/Pest.php"]
          : ["phpunit.xml", "phpunit.xml.dist"],
      ),
      classify: classifyCoverageCommand,
    });

    if (run.result.status !== "success" && run.result.status !== "code-finding") {
      return emptyEvidence(run.result);
    }

    const artifact = await readBoundedArtifact(cloverPath);
    if (!artifact || artifact.truncated) {
      return emptyEvidence(
        { ...run.result, status: "infrastructure-failure" },
        artifact ? artifactMetadata(artifact) : null,
      );
    }

    try {
      const findings = parseClover(tool, root, artifact.content);
      const status = findings.length > 0 ? "code-finding" : run.result.status;
      return {
        schemaVersion: phpCoverageSchemaVersion,
        result: { ...run.result, status },
        artifact: artifactMetadata(artifact),
        findings,
        candidates: findings.map(coverageCandidate),
      };
    } catch {
      return emptyEvidence({ ...run.result, status: "infrastructure-failure" }, artifactMetadata(artifact));
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

function selectTool(capability: CommandCapability): CoverageTool {
  if (capability.kind !== "coverage" || capability.source !== "manifest") {
    throw new Error("PHP coverage requires a manifest-detected capability.");
  }
  if (capability.framework === "phpunit" || capability.framework === "pest") {
    return capability.framework;
  }
  throw new Error("Unsupported PHP coverage capability.");
}

function classifyCoverageCommand(output: EvidenceCommandOutput): EvidenceResultStatus {
  if (output.outputTruncated) return "infrastructure-failure";
  const combined = `${output.stdout}\n${output.stderr}`;
  if (/no code coverage driver.*available|code coverage.*(?:not available|requires)|xdebug_mode.*coverage|enable.*(?:xdebug|pcov)/i.test(combined)) {
    return "missing-coverage-support";
  }
  if (/(?:configuration|phpunit\.xml|bootstrap).*(?:invalid|error|does not exist|not found|cannot|could not)|(?:invalid|cannot|could not).*(?:configuration|phpunit\.xml|bootstrap)|test directory .* not found|no tests found/i.test(combined)) {
    return "configuration-failure";
  }
  if (output.exitCode === 0) return "success";
  if (/failures?:|errors?:|tests?:\s+\d+/i.test(combined)) return "code-finding";
  return "infrastructure-failure";
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
      if (capturedBytes < cloverLimitBytes) {
        const captured = buffer.subarray(0, cloverLimitBytes - capturedBytes);
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
    truncated: bytes > cloverLimitBytes,
  };
}

function parseClover(tool: CoverageTool, root: string, xml: string): readonly PhpCoverageFinding[] {
  if (!/<coverage(?:\s|>)/.test(xml) || !/<project(?:\s|>)/.test(xml) || !/<\/coverage>\s*$/.test(xml)) {
    throw new Error("Clover output is malformed.");
  }

  const findings: PhpCoverageFinding[] = [];
  const fileElements = [...xml.matchAll(/<file\s+([^>]*)>([\s\S]*?)<\/file>/g)];
  for (const match of fileElements) {
    const rawFile = decodeXml(attribute(match[1] ?? "", "name") ?? "");
    const file = normalizeFile(root, rawFile);
    const metricsElements = [...(match[2] ?? "").matchAll(/<metrics\s+([^>]*)\/?\s*>/g)];
    const metrics = metricsElements.at(-1)?.[1];
    if (!metrics) throw new Error("Clover file metrics are missing.");
    const statements = nonNegativeInteger(attribute(metrics, "statements"));
    const coveredStatements = nonNegativeInteger(attribute(metrics, "coveredstatements"));
    if (coveredStatements > statements) throw new Error("Clover statement metrics are invalid.");
    if (statements < minimumStatements || coveredStatements / statements >= lowCoverageThreshold) continue;
    if (!/^(?:app\/Domain|src)\//.test(file)) continue;
    if (findings.length >= findingLimit) throw new Error("Clover finding limit exceeded.");
    const coveragePercent = Math.round((coveredStatements / statements) * 100);
    const identity = `${tool}:${file}:${statements}:${coveredStatements}`;
    findings.push({
      id: `coverage:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
      tool,
      file,
      statements,
      coveredStatements,
      coveragePercent,
    });
  }
  if (/<file(?:\s|>)/.test(xml) && fileElements.length === 0) throw new Error("Clover file output is malformed.");
  return findings;
}

function coverageCandidate(finding: PhpCoverageFinding): ImprovementCandidate {
  return {
    id: finding.id,
    kind: "test-protection",
    title: `Protect low-coverage domain behavior in ${finding.file}`,
    rationale: `${finding.file} has ${finding.coveragePercent}% statement coverage (${finding.coveredStatements}/${finding.statements}).`,
    confidence: 0.9,
    impact: 0.7,
    effort: 0.45,
    risk: 0.16,
    evidence: [`${finding.tool} Clover statement coverage: ${finding.coveragePercent}%`],
    suggestedFiles: [finding.file, "tests/Property"],
    target: finding.file,
    estimatedDiffLines: 70,
    reproducibility: reproducibleEvidence(0.98, [`${finding.tool} Clover collector`]),
    deduplication: {
      schemaVersion: "candidate-deduplication/v1",
      subsystem: finding.file,
      defect: "statement-coverage-gap",
    },
  };
}

function emptyEvidence(result: EvidenceResult, artifact: PhpCoverageArtifact | null = null): PhpCoverageEvidence {
  return {
    schemaVersion: phpCoverageSchemaVersion,
    result,
    artifact,
    findings: [],
    candidates: [],
  };
}

function artifactMetadata(artifact: CapturedArtifact): PhpCoverageArtifact {
  return {
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    limitBytes: cloverLimitBytes,
    truncated: artifact.truncated,
  };
}

function normalizeFile(root: string, file: string): string {
  if (!file) throw new Error("Clover file identity is missing.");
  const normalized = file.replaceAll("\\", "/");
  if (!isAbsolute(file)) return normalized.replace(/^\.\//, "");
  const relativePath = relative(root, file).replaceAll("\\", "/");
  if (relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error("Clover finding is outside the repository.");
  }
  return relativePath;
}

function nonNegativeInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 0) throw new Error("Clover metric is invalid.");
  return parsed;
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`${name}=(?:"([^"]*)"|'([^']*)')`).exec(attributes)?.slice(1).find(Boolean);
}

function decodeXml(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}
