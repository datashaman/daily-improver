import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import JSON5 from "json5";
import type {
  EvidenceCommandOutput,
  EvidenceResult,
  EvidenceResultStatus,
  EvidenceRunner,
} from "../contracts.js";
import type { CommandCapability, ImprovementCandidate } from "../domain/model.js";
import { phpEvidenceProvenance } from "./php-provenance.js";

export const phpMutationSchemaVersion = "php-mutation-evidence/v1" as const;

const reportLimitBytes = 2 * 1024 * 1024;
const findingLimit = 200;
const targetFilter = "app/Domain,src";
const configNames = ["infection.json5", "infection.json", "infection.json5.dist", "infection.json.dist"] as const;

export function phpMutationCommand(configPath: string): readonly string[] {
  return [
    "vendor/bin/infection",
    `--configuration=${configPath}`,
    `--filter=${targetFilter}`,
    "--threads=1",
    "--no-progress",
    "--show-mutations=0",
    "--no-interaction",
  ];
}

export interface PhpMutationFinding {
  readonly id: string;
  readonly tool: "infection";
  readonly status: "escaped" | "not-covered";
  readonly file: string;
  readonly line: number;
  readonly mutator: string;
}

export interface PhpMutationArtifact {
  readonly sha256: string;
  readonly bytes: number;
  readonly limitBytes: number;
  readonly truncated: boolean;
}

export interface PhpMutationEvidence {
  readonly schemaVersion: typeof phpMutationSchemaVersion;
  readonly result: EvidenceResult;
  readonly artifact: PhpMutationArtifact | null;
  readonly findings: readonly PhpMutationFinding[];
  readonly candidates: readonly ImprovementCandidate[];
}

export async function collectPhpMutationEvidence(
  root: string,
  capability: CommandCapability,
  runner: EvidenceRunner,
): Promise<PhpMutationEvidence> {
  selectInfection(capability);
  const workspace = await mkdtemp(join(tmpdir(), "daily-improver-infection-"));
  const reportPath = join(workspace, "mutation-report.json");
  const configPath = join(workspace, "infection.json5");

  try {
    const prepared = await prepareWorkspace(root, workspace, configPath, reportPath);
    const run = await runner.run({
      identity: "infection.mutation",
      command: phpMutationCommand(configPath),
      cwd: workspace,
      timeoutMs: 300_000,
      maxOutputBytes: 512 * 1024,
      provenance: phpEvidenceProvenance(
        ["vendor/bin/infection", "--version"],
        prepared.repositoryConfig ? [relative(root, prepared.repositoryConfig)] : [],
        root,
      ),
      classify: prepared.configIsValid ? classifyMutationCommand : classifyInvalidConfiguration,
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
      const parsed = parseReport(root, workspace, artifact.content);
      const status = parsed.hasInfrastructureFailures
        ? "infrastructure-failure"
        : parsed.findings.length > 0
          ? "code-finding"
          : "success";
      return {
        schemaVersion: phpMutationSchemaVersion,
        result: { ...run.result, status },
        artifact: artifactMetadata(artifact),
        findings: parsed.findings,
        candidates: status === "code-finding" ? parsed.findings.map(mutationCandidate) : [],
      };
    } catch {
      return emptyEvidence({ ...run.result, status: "infrastructure-failure" }, artifactMetadata(artifact));
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function selectInfection(capability: CommandCapability): void {
  if (
    capability.kind !== "mutation-testing"
    || capability.source !== "manifest"
    || capability.framework !== "infection"
  ) {
    throw new Error("PHP mutation analysis requires a manifest-detected Infection capability.");
  }
}

async function prepareWorkspace(
  root: string,
  workspace: string,
  configPath: string,
  reportPath: string,
): Promise<{ readonly configIsValid: boolean; readonly repositoryConfig?: string }> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (configNames.includes(entry.name as (typeof configNames)[number])) continue;
    await symlink(join(root, entry.name), join(workspace, entry.name), entry.isDirectory() ? "dir" : "file");
  }

  const repositoryConfig = await firstConfig(root);
  if (!repositoryConfig) {
    const sourceDirectories = await existingTargetDirectories(root);
    await writeFile(configPath, JSON.stringify({
      source: { directories: sourceDirectories },
      logs: { json: reportPath },
    }));
    return { configIsValid: true };
  }

  const rawConfig = await readFile(repositoryConfig, "utf8");
  try {
    const parsed = JSON5.parse(rawConfig) as unknown;
    if (!isRecord(parsed)) throw new Error("Infection configuration must be an object.");
    await writeFile(configPath, JSON.stringify({ ...parsed, logs: { json: reportPath } }));
    return { configIsValid: true, repositoryConfig };
  } catch {
    await copyFile(repositoryConfig, configPath);
    return { configIsValid: false, repositoryConfig };
  }
}

async function existingTargetDirectories(root: string): Promise<readonly string[]> {
  const directories: string[] = [];
  for (const directory of targetFilter.split(",")) {
    try {
      await access(join(root, directory));
      directories.push(directory);
    } catch {
      // Infection will report an invalid empty source configuration when neither target exists.
    }
  }
  return directories;
}

async function firstConfig(root: string): Promise<string | undefined> {
  const entries = new Set(await readdir(root));
  const name = configNames.find((candidate) => entries.has(candidate));
  return name ? join(root, name) : undefined;
}

function classifyInvalidConfiguration(output: EvidenceCommandOutput): EvidenceResultStatus {
  if (output.outputTruncated) return "infrastructure-failure";
  return "configuration-failure";
}

function classifyMutationCommand(output: EvidenceCommandOutput): EvidenceResultStatus {
  if (output.outputTruncated) return "infrastructure-failure";
  const combined = `${output.stdout}\n${output.stderr}`;
  if (/code coverage.*(?:not available|requires)|no code coverage driver|xdebug.*coverage|pcov.*(?:missing|not enabled)|coverage report.*(?:missing|not found)/i.test(combined)) {
    return "missing-coverage-support";
  }
  if (/configuration.*(?:invalid|error|does not exist|not found|cannot|could not)|(?:invalid|cannot|could not).*(?:configuration|infection\.json)|initial tests? (?:failed|did not pass)|no source (?:code|files?) found|source directory.*(?:missing|not found)/i.test(combined)) {
    return "configuration-failure";
  }
  if (output.exitCode === 0) return "success";
  if (/escaped mutants?|mutants? (?:were )?not covered|mutation score|covered code msi/i.test(combined)) {
    return "code-finding";
  }
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

interface ParsedReport {
  readonly findings: readonly PhpMutationFinding[];
  readonly hasInfrastructureFailures: boolean;
}

function parseReport(root: string, workspace: string, json: string): ParsedReport {
  const report = JSON.parse(json) as unknown;
  if (!isRecord(report) || !isRecord(report.stats)) throw new Error("Infection report is malformed.");
  const escaped = mutationRows(report.escaped, "escaped");
  const uncovered = mutationRows(report.uncovered, "not-covered");
  const rows = [...escaped, ...uncovered];
  if (rows.length > findingLimit) throw new Error("Infection finding limit exceeded.");
  const findings = rows.map(({ status, value }) => normalizeMutation(root, workspace, status, value));
  const errorCount = nonNegativeNumber(report.stats.errorCount);
  const syntaxErrorCount = nonNegativeNumber(report.stats.syntaxErrorCount);
  const timeOutCount = nonNegativeNumber(report.stats.timeOutCount);
  return {
    findings,
    hasInfrastructureFailures: errorCount > 0 || syntaxErrorCount > 0 || timeOutCount > 0,
  };
}

function mutationRows(
  value: unknown,
  status: PhpMutationFinding["status"],
): readonly { readonly status: PhpMutationFinding["status"]; readonly value: unknown }[] {
  if (!Array.isArray(value)) throw new Error("Infection mutation list is malformed.");
  return value.map((row) => ({ status, value: row }));
}

function normalizeMutation(
  root: string,
  workspace: string,
  status: PhpMutationFinding["status"],
  value: unknown,
): PhpMutationFinding {
  if (!isRecord(value) || !isRecord(value.mutator)) throw new Error("Infection mutation is malformed.");
  const mutator = requiredBoundedString(value.mutator.mutatorName, 128);
  const file = normalizeFile(root, workspace, requiredBoundedString(value.mutator.originalFilePath, 4096));
  const line = positiveInteger(value.mutator.originalStartLine);
  const identity = `${status}:${file}:${line}:${mutator}`;
  return {
    id: `mutation:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    tool: "infection",
    status,
    file,
    line,
    mutator,
  };
}

function mutationCandidate(finding: PhpMutationFinding): ImprovementCandidate {
  const escaped = finding.status === "escaped";
  return {
    id: finding.id,
    kind: "test-protection",
    title: `Kill ${finding.status} mutation in ${finding.file}`,
    rationale: escaped
      ? `An Infection ${finding.mutator} mutation escaped the existing tests at ${finding.file}:${finding.line}.`
      : `An Infection ${finding.mutator} mutation is not covered by tests at ${finding.file}:${finding.line}.`,
    confidence: escaped ? 0.98 : 0.88,
    impact: 0.96,
    effort: 0.35,
    risk: 0.18,
    evidence: [
      `Infection ${finding.status} mutation at ${finding.file}:${finding.line}`,
      finding.mutator,
    ],
    suggestedFiles: [finding.file, "tests/Property"],
    target: finding.file,
    estimatedDiffLines: 80,
    deduplication: {
      schemaVersion: "candidate-deduplication/v1",
      subsystem: finding.file,
      defect: `mutation:${finding.line}:${finding.mutator}`,
      reproducibility: 0.99,
      provenance: ["Infection executed collector"],
    },
  };
}

function emptyEvidence(result: EvidenceResult, artifact: PhpMutationArtifact | null = null): PhpMutationEvidence {
  return {
    schemaVersion: phpMutationSchemaVersion,
    result,
    artifact,
    findings: [],
    candidates: [],
  };
}

function artifactMetadata(artifact: CapturedArtifact): PhpMutationArtifact {
  return {
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    limitBytes: reportLimitBytes,
    truncated: artifact.truncated,
  };
}

function normalizeFile(root: string, workspace: string, file: string): string {
  const normalized = file.replaceAll("\\", "/");
  if (!isAbsolute(file)) return safeRelative(normalized);
  for (const base of [workspace, root]) {
    const relativePath = relative(base, file).replaceAll("\\", "/");
    if (relativePath !== ".." && !relativePath.startsWith("../")) return safeRelative(relativePath);
  }
  throw new Error("Infection finding is outside the repository.");
}

function safeRelative(file: string): string {
  const relativePath = file.replace(/^\.\//, "");
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new Error("Infection file identity is invalid.");
  }
  return relativePath;
}

function requiredBoundedString(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    throw new Error("Infection string field is invalid.");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error("Infection line is invalid.");
  return value as number;
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Infection metric is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
