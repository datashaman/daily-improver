import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative } from "node:path";
import type { EvidenceResult, EvidenceResultStatus, EvidenceRunner } from "../contracts.js";
import type { CommandCapability, ImprovementCandidate } from "../domain/model.js";
import type { ImproverConfig } from "../config.js";
import { phpEvidenceProvenance } from "./php-provenance.js";
import { reproducibleEvidence } from "../domain/candidate-reproducibility.js";

export const phpPerformanceSchemaVersion = "php-performance-evidence/v1" as const;
export const phpSlowTestSchemaVersion = "php-slow-test-evidence/v1" as const;
export const laravelSlowQuerySchemaVersion = "laravel-slow-query-evidence/v1" as const;
export const laravelSlowQueryReportSchemaVersion = "laravel-slow-query-report/v1" as const;

const artifactLimitBytes = 2 * 1024 * 1024;
const findingLimit = 200;
const identityLimit = 300;
const rawSqlLimit = 8 * 1024;
const maximumDurationMs = 24 * 60 * 60 * 1000;

export type PerformanceTool = "phpunit" | "pest";
export type PerformanceEvidenceStatus =
  | "clean"
  | "code-finding"
  | "unsupported-input"
  | "unavailable-tool"
  | "configuration-failure"
  | "timeout"
  | "truncated"
  | "infrastructure-failure";

export interface SlowTestFinding {
  readonly id: string;
  readonly tool: PerformanceTool;
  readonly test: string;
  readonly file: string;
  readonly line: number | null;
  readonly durationMs: number;
  readonly thresholdMs: number;
  readonly message: string;
}

export interface SlowQueryFinding {
  readonly id: string;
  readonly mechanism: "laravel-listener";
  readonly queryIdentity: string;
  readonly file: string;
  readonly line: number | null;
  readonly durationMs: number;
  readonly thresholdMs: number;
  readonly message: string;
}

export interface PerformanceArtifact {
  readonly sha256: string;
  readonly bytes: number;
  readonly limitBytes: number;
  readonly truncated: boolean;
}

export interface PhpPerformanceEvidence {
  readonly schemaVersion: typeof phpPerformanceSchemaVersion;
  readonly result: EvidenceResult;
  readonly slowTests: {
    readonly schemaVersion: typeof phpSlowTestSchemaVersion;
    readonly status: PerformanceEvidenceStatus;
    readonly thresholdMs: number;
    readonly artifact: PerformanceArtifact | null;
    readonly findings: readonly SlowTestFinding[];
  };
  readonly slowQueries: {
    readonly schemaVersion: typeof laravelSlowQuerySchemaVersion;
    readonly status: PerformanceEvidenceStatus;
    readonly mechanism: "off" | "laravel-listener";
    readonly thresholdMs: number;
    readonly artifact: PerformanceArtifact | null;
    readonly findings: readonly SlowQueryFinding[];
  };
  readonly findings: readonly (SlowTestFinding | SlowQueryFinding)[];
  readonly candidates: readonly ImprovementCandidate[];
}

export function phpPerformanceCommand(tool: PerformanceTool, junitPath: string): readonly string[] {
  return [`vendor/bin/${tool}`, "--log-junit", junitPath, "--colors=never"];
}

export async function collectPhpPerformanceEvidence(
  root: string,
  capability: CommandCapability,
  config: ImproverConfig["analysis"]["php"],
  laravel: boolean,
  runner: EvidenceRunner,
): Promise<PhpPerformanceEvidence> {
  const tool = selectTool(capability);
  const directory = await mkdtemp(join(tmpdir(), "daily-improver-performance-"));
  const junitPath = join(directory, "junit.xml");
  const queryPath = join(directory, "laravel-queries.json");
  const querySupported = config.slow_query.mechanism === "laravel-listener" && laravel;

  try {
    const run = await runner.run({
      identity: `${tool}.performance`,
      command: phpPerformanceCommand(tool, junitPath),
      cwd: root,
      timeoutMs: 180_000,
      maxOutputBytes: 512 * 1024,
      ...(querySupported ? {
        environment: {
          DAILY_IMPROVER_LARAVEL_QUERY_LOG: queryPath,
          DAILY_IMPROVER_LARAVEL_QUERY_THRESHOLD_MS: String(config.slow_query.threshold_ms),
        },
      } : {}),
      provenance: phpEvidenceProvenance(
        [`vendor/bin/${tool}`, "--version"],
        tool === "pest"
          ? [".ai/improver.yml", "phpunit.xml", "phpunit.xml.dist", "tests/Pest.php"]
          : [".ai/improver.yml", "phpunit.xml", "phpunit.xml.dist"],
      ),
      classify: classifyPerformanceCommand,
    });

    if (run.result.outputTruncated) {
      return emptyEvidence(run.result, config, querySupported, "truncated");
    }
    if (!isParseableStatus(run.result.status)) {
      return emptyEvidence(run.result, config, querySupported, mapResultStatus(run.result.status));
    }

    const junit = await readBoundedArtifact(junitPath);
    if (!junit || junit.truncated) {
      return emptyEvidence(run.result, config, querySupported, junit?.truncated ? "truncated" : "infrastructure-failure", junit ?? null);
    }

    let tests: readonly SlowTestFinding[];
    try {
      tests = parseJUnit(root, tool, junit.content, config.slow_test_threshold_ms);
    } catch {
      return emptyEvidence(run.result, config, querySupported, "infrastructure-failure", junit);
    }

    let queryArtifact: CapturedArtifact | undefined;
    let queries: readonly SlowQueryFinding[] = [];
    let queryStatus: PerformanceEvidenceStatus = querySupported ? "configuration-failure" : "unsupported-input";
    if (querySupported) {
      queryArtifact = await readBoundedArtifact(queryPath);
      if (queryArtifact?.truncated) {
        queryStatus = "truncated";
      } else if (queryArtifact) {
        try {
          queries = parseLaravelQueries(root, queryArtifact.content, config.slow_query.threshold_ms);
          queryStatus = queries.length > 0 ? "code-finding" : "clean";
        } catch {
          queryStatus = "infrastructure-failure";
        }
      }
    }

    const findings = [...tests, ...queries];
    const resultStatus = querySupported && queryStatus !== "clean" && queryStatus !== "code-finding"
      ? resultStatusForEvidenceStatus(queryStatus)
      : findings.length > 0 ? "code-finding" : run.result.status;
    return {
      schemaVersion: phpPerformanceSchemaVersion,
      result: { ...run.result, status: resultStatus },
      slowTests: {
        schemaVersion: phpSlowTestSchemaVersion,
        status: tests.length > 0 ? "code-finding" : "clean",
        thresholdMs: config.slow_test_threshold_ms,
        artifact: artifactMetadata(junit),
        findings: tests,
      },
      slowQueries: {
        schemaVersion: laravelSlowQuerySchemaVersion,
        status: queryStatus,
        mechanism: config.slow_query.mechanism,
        thresholdMs: config.slow_query.threshold_ms,
        artifact: queryArtifact ? artifactMetadata(queryArtifact) : null,
        findings: queries,
      },
      findings,
      candidates: findings.map(performanceCandidate),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function selectTool(capability: CommandCapability): PerformanceTool {
  if (capability.kind !== "test" || capability.source !== "manifest") {
    throw new Error("PHP performance evidence requires a manifest-detected test capability.");
  }
  if (capability.framework === "phpunit" || capability.framework === "pest") return capability.framework;
  throw new Error("Unsupported PHP performance test capability.");
}

function classifyPerformanceCommand(output: { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly outputTruncated: boolean }): EvidenceResultStatus {
  if (output.outputTruncated) return "infrastructure-failure";
  const combined = `${output.stdout}\n${output.stderr}`;
  if (/(?:configuration|phpunit\.xml|bootstrap).*(?:invalid|error|does not exist|not found|cannot|could not)|(?:invalid|cannot|could not).*(?:configuration|phpunit\.xml|bootstrap)|test directory .* not found|no tests found/i.test(combined)) {
    return "configuration-failure";
  }
  if (output.exitCode === 0) return "success";
  if (/failures?:|errors?:|tests?:\s+\d+/i.test(combined)) return "code-finding";
  return "infrastructure-failure";
}

interface CapturedArtifact extends PerformanceArtifact {
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
      if (capturedBytes < artifactLimitBytes) {
        const captured = buffer.subarray(0, artifactLimitBytes - capturedBytes);
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
    limitBytes: artifactLimitBytes,
    truncated: bytes > artifactLimitBytes,
  };
}

function parseJUnit(root: string, tool: PerformanceTool, xml: string, thresholdMs: number): readonly SlowTestFinding[] {
  if (!/<testsuites?(?:\s|>)/.test(xml) || !/<\/testsuites?>\s*$/.test(xml)) throw new Error("JUnit output is malformed.");
  const findings: SlowTestFinding[] = [];
  for (const match of xml.matchAll(/<testcase\s+([^>]*?)(?:\/>|>[\s\S]*?<\/testcase>)/g)) {
    const attributes = match[1] ?? "";
    const name = decodeXml(attribute(attributes, "name") ?? "");
    const className = decodeXml(attribute(attributes, "class") ?? attribute(attributes, "classname") ?? "");
    const file = normalizeFile(root, decodeXml(attribute(attributes, "file") ?? ""));
    const seconds = Number(attribute(attributes, "time"));
    if (!name || !Number.isFinite(seconds) || seconds < 0) throw new Error("JUnit test identity or duration is invalid.");
    const durationMs = Math.round(seconds * 1000);
    if (!Number.isFinite(durationMs) || durationMs > maximumDurationMs) throw new Error("JUnit test duration is invalid.");
    if (durationMs < thresholdMs) continue;
    if (findings.length >= findingLimit) throw new Error("JUnit finding limit exceeded.");
    const test = bounded(className ? `${className}::${name}` : name, identityLimit);
    const line = optionalPositiveInteger(attribute(attributes, "line"));
    const identity = `${tool}:${file}:${line ?? ""}:${test}:${durationMs}:${thresholdMs}`;
    findings.push({
      id: `slow-test:${shortHash(identity)}`,
      tool,
      test,
      file,
      line,
      durationMs,
      thresholdMs,
      message: bounded(`${test} took ${durationMs}ms (threshold ${thresholdMs}ms).`, identityLimit),
    });
  }
  return findings;
}

function parseLaravelQueries(root: string, json: string, thresholdMs: number): readonly SlowQueryFinding[] {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || value.schemaVersion !== laravelSlowQueryReportSchemaVersion || !Array.isArray(value.queries)) {
    throw new Error("Laravel query report is malformed.");
  }
  if (value.queries.length > findingLimit) throw new Error("Laravel query finding limit exceeded.");
  const findings: SlowQueryFinding[] = [];
  for (const entry of value.queries) {
    if (!isRecord(entry) || typeof entry.sql !== "string" || Buffer.byteLength(entry.sql) > rawSqlLimit) throw new Error("Laravel query identity is invalid.");
    const durationMs = finiteNonNegative(entry.durationMs);
    const file = normalizeFile(root, typeof entry.file === "string" ? entry.file : "");
    if (!/^(?:app|src)\//.test(file)) throw new Error("Laravel query source is outside supported source roots.");
    const line = optionalPositiveInteger(entry.line);
    if (durationMs < thresholdMs) continue;
    const queryIdentity = `sha256:${createHash("sha256").update(normalizeSql(entry.sql)).digest("hex")}`;
    const identity = `${queryIdentity}:${file}:${line ?? ""}:${durationMs}:${thresholdMs}`;
    findings.push({
      id: `slow-query:${shortHash(identity)}`,
      mechanism: "laravel-listener",
      queryIdentity,
      file,
      line,
      durationMs,
      thresholdMs,
      message: bounded(`Laravel query took ${durationMs}ms (threshold ${thresholdMs}ms).`, identityLimit),
    });
  }
  return findings;
}

function performanceCandidate(finding: SlowTestFinding | SlowQueryFinding): ImprovementCandidate {
  if ("test" in finding) {
    return {
      id: finding.id,
      kind: "performance",
      title: `Reduce runtime of ${finding.test}`,
      rationale: finding.message,
      confidence: 0.9,
      impact: 0.65,
      effort: 0.5,
      risk: 0.2,
      evidence: [`${finding.tool} JUnit duration ${finding.durationMs}ms; configured threshold ${finding.thresholdMs}ms`],
      suggestedFiles: [finding.file],
      target: finding.file,
      estimatedDiffLines: 80,
      reproducibility: reproducibleEvidence(0.97, [`${finding.tool} JUnit executed collector`]),
    };
  }
  return {
    id: finding.id,
    kind: "performance",
    title: `Reduce slow Laravel query at ${finding.file}`,
    rationale: finding.message,
    confidence: 0.88,
    impact: 0.75,
    effort: 0.55,
    risk: 0.24,
    evidence: [`Laravel listener query ${finding.queryIdentity} duration ${finding.durationMs}ms; configured threshold ${finding.thresholdMs}ms`],
    suggestedFiles: [finding.file],
    target: finding.file,
    estimatedDiffLines: 90,
    reproducibility: reproducibleEvidence(0.95, ["Laravel listener executed collector"]),
  };
}

function emptyEvidence(
  result: EvidenceResult,
  config: ImproverConfig["analysis"]["php"],
  querySupported: boolean,
  status: PerformanceEvidenceStatus,
  testArtifact: CapturedArtifact | null = null,
): PhpPerformanceEvidence {
  return {
    schemaVersion: phpPerformanceSchemaVersion,
    result: { ...result, status: resultStatusForEvidenceStatus(status) },
    slowTests: { schemaVersion: phpSlowTestSchemaVersion, status, thresholdMs: config.slow_test_threshold_ms, artifact: testArtifact ? artifactMetadata(testArtifact) : null, findings: [] },
    slowQueries: {
      schemaVersion: laravelSlowQuerySchemaVersion,
      status: querySupported ? status : "unsupported-input",
      mechanism: config.slow_query.mechanism,
      thresholdMs: config.slow_query.threshold_ms,
      artifact: null,
      findings: [],
    },
    findings: [],
    candidates: [],
  };
}

function isParseableStatus(status: EvidenceResultStatus): boolean {
  return status === "success" || status === "code-finding";
}

function mapResultStatus(status: EvidenceResultStatus): PerformanceEvidenceStatus {
  if (status === "unavailable-tool" || status === "configuration-failure" || status === "timeout" || status === "infrastructure-failure") return status;
  return "infrastructure-failure";
}

function resultStatusForEvidenceStatus(status: PerformanceEvidenceStatus): EvidenceResultStatus {
  if (status === "unavailable-tool" || status === "configuration-failure" || status === "timeout") return status;
  if (status === "code-finding") return "code-finding";
  if (status === "clean" || status === "unsupported-input") return "success";
  return "infrastructure-failure";
}

function artifactMetadata(artifact: CapturedArtifact): PerformanceArtifact {
  return { sha256: artifact.sha256, bytes: artifact.bytes, limitBytes: artifact.limitBytes, truncated: artifact.truncated };
}

function normalizeFile(root: string, file: string): string {
  if (!file) throw new Error("Performance finding file identity is missing.");
  const normalized = file.replaceAll("\\", "/");
  if (!isAbsolute(file)) {
    const relativeFile = posix.normalize(normalized.replace(/^\.\//, ""));
    if (relativeFile === ".." || relativeFile.startsWith("../") || relativeFile.startsWith("/")) throw new Error("Performance finding is outside the repository.");
    return bounded(relativeFile, identityLimit);
  }
  const relativePath = relative(root, file).replaceAll("\\", "/");
  if (relativePath === ".." || relativePath.startsWith("../")) throw new Error("Performance finding is outside the repository.");
  return bounded(relativePath, identityLimit);
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/"(?:""|[^"])*"/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`${name}=(?:"([^"]*)"|'([^']*)')`).exec(attributes)?.slice(1).find((value) => value !== undefined);
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Performance finding line is invalid.");
  return parsed;
}

function finiteNonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximumDurationMs) throw new Error("Performance duration is invalid.");
  return Math.round(value);
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function decodeXml(value: string): string {
  return value.replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
