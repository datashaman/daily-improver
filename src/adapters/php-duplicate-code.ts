import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { EvidenceCommandOutput, EvidenceResult, EvidenceResultStatus, EvidenceRunner } from "../contracts.js";
import type { CommandCapability, ImprovementCandidate } from "../domain/model.js";
import { phpEvidenceProvenance } from "./php-provenance.js";
import { reproducibleEvidence } from "../domain/candidate-reproducibility.js";

export const phpDuplicateCodeSchemaVersion = "php-duplicate-code-evidence/v1" as const;

const reportLimitBytes = 2 * 1024 * 1024;
const findingLimit = 200;
const regionLimit = 20;
const messageLimit = 500;
const maximumMetric = 10_000_000;

export type DuplicateCodeEvidenceStatus =
  | "clean"
  | "code-finding"
  | "unsupported-input"
  | "unavailable-tool"
  | "configuration-failure"
  | "timeout"
  | "truncated"
  | "malformed-output"
  | "infrastructure-failure";

export interface DuplicateCodeRegion {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface PhpDuplicateCodeFinding {
  readonly id: string;
  readonly tool: "phpcpd";
  readonly lines: number;
  readonly tokens: number;
  readonly similarityPercent: 100;
  readonly occurrenceCount: number;
  readonly regions: readonly DuplicateCodeRegion[];
  readonly message: string;
}

export interface PhpDuplicateCodeArtifact {
  readonly sha256: string;
  readonly bytes: number;
  readonly limitBytes: number;
  readonly truncated: boolean;
}

export interface PhpDuplicateCodeEvidence {
  readonly schemaVersion: typeof phpDuplicateCodeSchemaVersion;
  readonly status: DuplicateCodeEvidenceStatus;
  readonly result: EvidenceResult;
  readonly artifact: PhpDuplicateCodeArtifact | null;
  readonly findings: readonly PhpDuplicateCodeFinding[];
  readonly candidates: readonly ImprovementCandidate[];
}

export function phpDuplicateCodeCommand(
  reportPath: string,
  sourceRoots: readonly string[] = ["app", "src"],
): readonly string[] {
  return ["vendor/bin/phpcpd", "--log-pmd", reportPath, ...sourceRoots];
}

export async function collectPhpDuplicateCodeEvidence(
  root: string,
  capability: CommandCapability,
  runner: EvidenceRunner,
): Promise<PhpDuplicateCodeEvidence> {
  selectPhpCpd(capability);
  const directory = await mkdtemp(join(tmpdir(), "daily-improver-duplicates-"));
  const reportPath = join(directory, "phpcpd.xml");
  const sourceRoots = await existingSourceRoots(root);

  try {
    const run = await runner.run({
      identity: "phpcpd.duplicate-code",
      command: phpDuplicateCodeCommand(reportPath, sourceRoots.length > 0 ? sourceRoots : ["app", "src"]),
      cwd: root,
      timeoutMs: 120_000,
      maxOutputBytes: 512 * 1024,
      provenance: phpEvidenceProvenance(
        ["vendor/bin/phpcpd", "--version"],
        [".ai/improver.yml"],
      ),
      classify: classifyPhpCpdCommand,
    });

    if (run.result.outputTruncated) return emptyEvidence(run.result, "truncated");
    if (!isParseableStatus(run.result.status)) {
      const status = run.result.status === "configuration-failure" && unsupportedOutput(run.output.stdout, run.output.stderr)
        ? "unsupported-input"
        : mapResultStatus(run.result.status);
      return emptyEvidence(run.result, status);
    }

    const artifact = await readBoundedArtifact(reportPath);
    if (!artifact) return emptyEvidence(run.result, "malformed-output");
    if (artifact.truncated) return emptyEvidence(run.result, "truncated", artifact);

    try {
      const findings = parsePhpCpdReport(root, artifact.content);
      const status = findings.length > 0 ? "code-finding" : "clean";
      return {
        schemaVersion: phpDuplicateCodeSchemaVersion,
        status,
        result: { ...run.result, status: status === "code-finding" ? "code-finding" : "success" },
        artifact: artifactMetadata(artifact),
        findings,
        candidates: findings.map(duplicateCandidate),
      };
    } catch {
      return emptyEvidence(run.result, "malformed-output", artifact);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function phpDuplicateCodeSourceRoots(root: string): Promise<readonly string[]> {
  return existingSourceRoots(root);
}

function selectPhpCpd(capability: CommandCapability): void {
  if (
    capability.kind !== "duplicate-code"
    || (capability.source !== "manifest" && capability.source !== "configuration")
    || capability.framework !== "phpcpd"
  ) {
    throw new Error("PHP duplicate-code analysis requires a detected or configured PHPCPD capability.");
  }
}

function classifyPhpCpdCommand(output: EvidenceCommandOutput): EvidenceResultStatus {
  if (output.outputTruncated) return "infrastructure-failure";
  const combined = `${output.stdout}\n${output.stderr}`;
  if (unsupportedOutput(output.stdout, output.stderr)) return "configuration-failure";
  if (/unknown option|invalid (?:option|argument)|cannot (?:open|read)|could not (?:open|read)|does not exist|not found|configuration/i.test(combined)) {
    return "configuration-failure";
  }
  if (output.exitCode === 0) return "success";
  if (output.exitCode === 1) return "code-finding";
  return "infrastructure-failure";
}

function unsupportedOutput(stdout: string, stderr: string): boolean {
  return /unsupported (?:input|php)|php .* (?:is not supported|not supported)|requires php|no (?:supported )?(?:source )?(?:files|directories) (?:found|provided)/i.test(`${stdout}\n${stderr}`);
}

interface CapturedArtifact extends PhpDuplicateCodeArtifact {
  readonly content: string;
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
    limitBytes: reportLimitBytes,
    truncated: bytes > reportLimitBytes,
  };
}

function parsePhpCpdReport(root: string, xml: string): readonly PhpDuplicateCodeFinding[] {
  if (!/<pmd-cpd(?:\s[^>]*)?(?:\/>|>)/.test(xml) || !/(?:<\/pmd-cpd>|<pmd-cpd(?:\s[^>]*)?\/>)\s*$/.test(xml)) {
    throw new Error("PHPCPD PMD report is malformed.");
  }
  const findings: PhpDuplicateCodeFinding[] = [];
  for (const match of xml.matchAll(/<duplication\s+([^>]+)>([\s\S]*?)<\/duplication>/g)) {
    if (findings.length >= findingLimit) throw new Error("PHPCPD finding limit exceeded.");
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const regionXml = body.replace(/<codefragment(?:\s[^>]*)?>[\s\S]*?<\/codefragment>/g, "");
    const lines = boundedPositiveInteger(attribute(attributes, "lines"), "lines");
    const tokens = boundedPositiveInteger(attribute(attributes, "tokens"), "tokens");
    const regions: DuplicateCodeRegion[] = [];
    for (const fileMatch of regionXml.matchAll(/<file\s+([^>]+?)(?:\/?>)/g)) {
      if (regions.length >= regionLimit) throw new Error("PHPCPD region limit exceeded.");
      const fileAttributes = fileMatch[1] ?? "";
      const file = normalizeSourceFile(root, decodeXml(attribute(fileAttributes, "path") ?? ""));
      const startLine = boundedPositiveInteger(attribute(fileAttributes, "line"), "line");
      const endLine = startLine + lines - 1;
      if (endLine > maximumMetric) throw new Error("PHPCPD line range is invalid.");
      regions.push({ file, startLine, endLine });
    }
    if (regions.length < 2) throw new Error("PHPCPD duplication must contain at least two regions.");
    const identity = `${lines}:${tokens}:${regions.map((region) => `${region.file}:${region.startLine}:${region.endLine}`).join("|")}`;
    findings.push({
      id: `duplicate-code:${shortHash(identity)}`,
      tool: "phpcpd",
      lines,
      tokens,
      similarityPercent: 100,
      occurrenceCount: regions.length,
      regions,
      message: bounded(`PHPCPD found ${lines} duplicated lines (${tokens} tokens) across ${regions.length} regions.`, messageLimit),
    });
  }
  return findings;
}

function duplicateCandidate(finding: PhpDuplicateCodeFinding): ImprovementCandidate {
  const files = [...new Set(finding.regions.map((region) => region.file))];
  const primaryFile = files[0];
  if (!primaryFile) throw new Error("PHPCPD candidate has no source file.");
  return {
    id: finding.id,
    kind: "maintainability",
    title: `Consolidate verified duplicate PHP code in ${primaryFile}`,
    rationale: finding.message,
    confidence: 0.94,
    impact: 0.55,
    effort: 0.58,
    risk: 0.3,
    subsystemRisk: 0.35,
    testability: 0.7,
    evidence: [
      `PHPCPD exact-match similarity: ${finding.similarityPercent}%`,
      `${finding.lines} lines and ${finding.tokens} tokens across ${finding.occurrenceCount} regions`,
    ],
    suggestedFiles: [...files, "tests"],
    target: primaryFile,
    estimatedDiffLines: Math.min(150, finding.lines * finding.occurrenceCount + 40),
    reproducibility: reproducibleEvidence(0.98, ["PHPCPD executed collector"]),
  };
}

function emptyEvidence(
  result: EvidenceResult,
  status: DuplicateCodeEvidenceStatus,
  artifact: CapturedArtifact | null = null,
): PhpDuplicateCodeEvidence {
  return {
    schemaVersion: phpDuplicateCodeSchemaVersion,
    status,
    result: { ...result, status: resultStatus(status) },
    artifact: artifact ? artifactMetadata(artifact) : null,
    findings: [],
    candidates: [],
  };
}

function isParseableStatus(status: EvidenceResultStatus): boolean {
  return status === "success" || status === "code-finding";
}

function mapResultStatus(status: EvidenceResultStatus): DuplicateCodeEvidenceStatus {
  if (status === "unavailable-tool" || status === "configuration-failure" || status === "timeout" || status === "infrastructure-failure") return status;
  return "infrastructure-failure";
}

function resultStatus(status: DuplicateCodeEvidenceStatus): EvidenceResultStatus {
  if (status === "code-finding") return "code-finding";
  if (status === "clean") return "success";
  if (status === "unavailable-tool" || status === "configuration-failure" || status === "timeout") return status;
  return "infrastructure-failure";
}

function artifactMetadata(artifact: CapturedArtifact): PhpDuplicateCodeArtifact {
  return { sha256: artifact.sha256, bytes: artifact.bytes, limitBytes: artifact.limitBytes, truncated: artifact.truncated };
}

function normalizeSourceFile(root: string, rawFile: string): string {
  if (!rawFile) throw new Error("PHPCPD source file is missing.");
  const absolute = isAbsolute(rawFile) ? resolve(rawFile) : resolve(root, rawFile);
  const normalized = relative(resolve(root), absolute).replaceAll("\\", "/");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || !/^(?:app|src)\/.+\.php$/i.test(normalized)) {
    throw new Error("PHPCPD source file is outside supported source roots.");
  }
  return normalized;
}

function boundedPositiveInteger(value: string | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximumMetric) throw new Error(`PHPCPD ${name} is invalid.`);
  return number;
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`).exec(attributes)?.slice(1).find((value) => value !== undefined);
}

function decodeXml(value: string): string {
  return value.replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function existingSourceRoots(root: string): Promise<readonly string[]> {
  const roots: string[] = [];
  for (const sourceRoot of ["app", "src"] as const) {
    try {
      if ((await stat(join(root, sourceRoot))).isDirectory()) roots.push(sourceRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return roots;
}
