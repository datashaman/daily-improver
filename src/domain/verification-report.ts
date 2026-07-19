import { createHash } from "node:crypto";

export const verificationReportSchemaVersion = "verification-report/v2" as const;
export const verificationEvidenceSemantics = "canonical-json-sha256/v1" as const;

const hashPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const maximumChecks = 64;
const maximumDurationMs = 10 * 60_000;

const requiredEvidenceSchemas = [
  "ordinary-diff-inspection/v1",
  "specification-change-scope-result/v1",
  "verified-patch-limit-result/v1",
  "source-safety-report/v1",
  "static-analysis-result/v1",
  "static-analysis-findings-comparison/v1",
  "static-analysis-ignored-findings-result/v1",
  "static-analysis-ignored-findings-comparison/v1",
  "broad-exception-swallowing-result/v1",
  "broad-exception-swallowing-comparison/v1",
  "validation-boundary-result/v1",
  "validation-boundary-comparison/v1",
  "test-strength-result/v1",
  "test-strength-comparison/v1",
  "protected-repository-change-result/v1",
  "protected-repository-change-comparison/v1",
  "secret-scan-result/v1",
  "public-api-surface-result/v1",
  "public-api-surface-comparison/v1",
  "objective-verification-result/v1",
] as const;

const targetedMutationEvidenceSchemas = [
  "targeted-mutation-result/v2",
  "targeted-mutation-score-comparison/v1",
] as const;

export interface VerificationEvidenceBinding {
  readonly schemaVersion: string;
  readonly sha256: string;
}

export interface VerificationCheckBinding {
  readonly commandSha256: string;
  readonly durationMs: number;
  readonly outcome: "passed";
}

export interface VerificationReport {
  readonly schemaVersion: typeof verificationReportSchemaVersion;
  readonly passed: true;
  readonly expectedBaseSha: string;
  readonly verifierInputsSha256: string;
  readonly mutationMode: "off" | "targeted";
  readonly evidenceSemantics: typeof verificationEvidenceSemantics;
  readonly evidence: readonly VerificationEvidenceBinding[];
  readonly checks: readonly VerificationCheckBinding[];
  readonly verifiedAt: string;
}

export interface VerificationReportInputs {
  readonly expectedBaseSha: string;
  readonly verifierInputsSha256: string;
  readonly mutationMode: "off" | "targeted";
  readonly commands: readonly string[];
}

export interface VerificationEvidenceValue {
  readonly schemaVersion: string;
  readonly value: unknown;
}

export function createVerificationReport(
  inputs: VerificationReportInputs,
  evidenceValues: readonly VerificationEvidenceValue[],
  checks: readonly { readonly command: string; readonly exitCode: number; readonly durationMs: number }[],
  verifiedAt: string,
): VerificationReport {
  const expectedSchemas = evidenceSchemas(inputs.mutationMode);
  if (evidenceValues.length !== expectedSchemas.length
    || evidenceValues.some((item, index) => item.schemaVersion !== expectedSchemas[index])) {
    throw new Error("Verification report evidence is missing, reordered, or inconsistent with the sealed mutation mode.");
  }
  const evidence = evidenceValues.map((item) => {
    const record = exactRecord(item.value, "Verification report evidence value");
    if (record.schemaVersion !== undefined && record.schemaVersion !== item.schemaVersion) {
      throw new Error("Verification report evidence schema is inconsistent with its binding.");
    }
    return Object.freeze({ schemaVersion: item.schemaVersion, sha256: canonicalHash(item.value) });
  });
  const report = {
    schemaVersion: verificationReportSchemaVersion,
    passed: true as const,
    expectedBaseSha: inputs.expectedBaseSha,
    verifierInputsSha256: inputs.verifierInputsSha256,
    mutationMode: inputs.mutationMode,
    evidenceSemantics: verificationEvidenceSemantics,
    evidence,
    checks: checks.map((check) => {
      if (check.exitCode !== 0) throw new Error("Verification report cannot bind a failing ordinary check.");
      return Object.freeze({ commandSha256: sha256(check.command), durationMs: check.durationMs, outcome: "passed" as const });
    }),
    verifiedAt,
  };
  return assertVerificationReport(report, inputs);
}

export function assertVerificationReport(value: unknown, inputs?: VerificationReportInputs): VerificationReport {
  const report = exactRecord(value, "Verification report", [
    "checks", "evidence", "evidenceSemantics", "expectedBaseSha", "mutationMode", "passed", "schemaVersion",
    "verifiedAt", "verifierInputsSha256",
  ]);
  if (report.schemaVersion !== verificationReportSchemaVersion || report.passed !== true
    || report.evidenceSemantics !== verificationEvidenceSemantics) {
    throw new Error("Verification report uses an unsupported schema, outcome, or evidence semantics.");
  }
  const expectedBaseSha = commit(report.expectedBaseSha);
  const verifierInputsSha256 = hash(report.verifierInputsSha256, "verifier-input");
  if (report.mutationMode !== "off" && report.mutationMode !== "targeted") {
    throw new Error("Verification report mutation mode is unsupported.");
  }
  const mutationMode = report.mutationMode;
  if (!Array.isArray(report.evidence)) throw new Error("Verification report evidence is malformed.");
  const expectedSchemas = evidenceSchemas(mutationMode);
  if (report.evidence.length !== expectedSchemas.length) throw new Error("Verification report evidence is incomplete or excessive.");
  const evidence = report.evidence.map((value, index) => {
    const binding = exactRecord(value, "Verification evidence binding", ["schemaVersion", "sha256"]);
    if (binding.schemaVersion !== expectedSchemas[index]) throw new Error("Verification report evidence is missing, duplicated, reordered, or unsupported.");
    return Object.freeze({ schemaVersion: binding.schemaVersion as string, sha256: hash(binding.sha256, "evidence") });
  });
  if (!Array.isArray(report.checks) || report.checks.length > maximumChecks) {
    throw new Error("Verification report ordinary checks are missing or excessive.");
  }
  const checks = report.checks.map((value) => {
    const check = exactRecord(value, "Verification check binding", ["commandSha256", "durationMs", "outcome"]);
    if (check.outcome !== "passed" || !Number.isInteger(check.durationMs)
      || (check.durationMs as number) < 0 || (check.durationMs as number) > maximumDurationMs) {
      throw new Error("Verification report ordinary check outcome or duration is malformed.");
    }
    return Object.freeze({
      commandSha256: hash(check.commandSha256, "command"),
      durationMs: check.durationMs as number,
      outcome: "passed" as const,
    });
  });
  const verifiedAt = timestamp(report.verifiedAt);
  if (inputs) {
    if (expectedBaseSha !== inputs.expectedBaseSha || verifierInputsSha256 !== inputs.verifierInputsSha256
      || mutationMode !== inputs.mutationMode) {
      throw new Error("Verification report is inconsistent with the sealed verifier inputs.");
    }
    if (checks.length !== inputs.commands.length
      || checks.some((check, index) => check.commandSha256 !== sha256(inputs.commands[index]!))) {
      throw new Error("Verification report ordinary checks do not match the sealed commands.");
    }
  }
  return Object.freeze({
    schemaVersion: verificationReportSchemaVersion,
    passed: true,
    expectedBaseSha,
    verifierInputsSha256,
    mutationMode,
    evidenceSemantics: verificationEvidenceSemantics,
    evidence: Object.freeze(evidence),
    checks: Object.freeze(checks),
    verifiedAt,
  });
}

export function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function verificationEvidenceSchemaVersions(mutationMode: "off" | "targeted"): readonly string[] {
  return Object.freeze([...evidenceSchemas(mutationMode)]);
}

function evidenceSchemas(mutationMode: "off" | "targeted"): readonly string[] {
  return mutationMode === "targeted"
    ? [...requiredEvidenceSchemas.slice(0, -1), ...targetedMutationEvidenceSchemas, requiredEvidenceSchemas.at(-1)!]
    : requiredEvidenceSchemas;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Verification evidence contains a non-finite number.");
    if (value === undefined) throw new Error("Verification evidence contains an undefined value.");
    return value;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
}

function exactRecord(value: unknown, name: string, keys?: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  const record = value as Readonly<Record<string, unknown>>;
  if (keys) {
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      throw new Error(`${name} is extended or incomplete.`);
    }
  }
  return record;
}

function commit(value: unknown): string {
  if (typeof value !== "string" || !commitPattern.test(value)) throw new Error("Verification report baseline identity is malformed.");
  return value;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) throw new Error(`Verification report ${name} identity is malformed.`);
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) throw new Error("Verification report timestamp is malformed.");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("Verification report timestamp is malformed.");
  return value;
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
