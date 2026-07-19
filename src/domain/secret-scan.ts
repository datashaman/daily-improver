import { createHash } from "node:crypto";

export const secretScanPlanSchemaVersion = "secret-scan-plan/v1" as const;
export const secretScanResultSchemaVersion = "secret-scan-result/v1" as const;

export const secretClassifications = [
  "credential",
  "entropy-secret",
  "private-key",
  "token",
] as const;

export type SecretClassification = typeof secretClassifications[number];
export type SecretAllowlistScope = "explicit-test-fixture" | "known-false-positive";

const allowlistScopes = ["explicit-test-fixture", "known-false-positive"] as const;
const maximumAllowlistEntries = 1_000;
const maximumFindings = 1_000;
const maximumLine = 10_000_000;

export interface SecretScanAllowlistEntry {
  readonly ruleId: string;
  readonly pathIdentitySha256: string;
  readonly secretSha256: string;
  readonly scope: SecretAllowlistScope;
  readonly justificationSha256: string;
}

export interface SecretScanPlan {
  readonly schemaVersion: typeof secretScanPlanSchemaVersion;
  readonly policyId: "verified-patch-secret-policy/v1";
  readonly policySha256: string;
  readonly detectorId: "daily-improver-bounded-secret-detector";
  readonly detectorVersion: "1";
  readonly classifications: readonly SecretClassification[];
  readonly allowlist: readonly SecretScanAllowlistEntry[];
}

export interface SecretFinding {
  readonly findingIdentitySha256: string;
  readonly ruleId: string;
  readonly classification: SecretClassification;
  readonly pathIdentitySha256: string;
  readonly line: number;
  readonly column: number;
  readonly matchLength: number;
  readonly secretSha256: string;
  readonly allowlistScope: SecretAllowlistScope;
  readonly allowlistJustificationSha256: string;
}

export interface SecretScanResult {
  readonly schemaVersion: typeof secretScanResultSchemaVersion;
  readonly policyId: SecretScanPlan["policyId"];
  readonly policySha256: string;
  readonly detectorId: SecretScanPlan["detectorId"];
  readonly detectorVersion: SecretScanPlan["detectorVersion"];
  readonly classifications: readonly SecretClassification[];
  readonly findingIdentitySemantics: "rule-path-added-line-column-secret/v1";
  readonly patchSha256: string;
  readonly scannedAddedLineCount: number;
  readonly findings: readonly SecretFinding[];
  readonly findingsSha256: string;
  readonly outcome: "clean" | "allowlisted";
}

export function assertSecretScanPlan(value: unknown): SecretScanPlan {
  const plan = exactRecord(value, [
    "allowlist", "classifications", "detectorId", "detectorVersion", "policyId", "policySha256", "schemaVersion",
  ], "Secret-scan plan");
  if (plan.schemaVersion !== secretScanPlanSchemaVersion
    || plan.policyId !== "verified-patch-secret-policy/v1"
    || plan.detectorId !== "daily-improver-bounded-secret-detector"
    || plan.detectorVersion !== "1") {
    throw new Error("Secret-scan plan uses an unsupported schema, policy, or detector.");
  }
  if (JSON.stringify(plan.classifications) !== JSON.stringify(secretClassifications)) {
    throw new Error("Secret-scan classifications are incomplete, reordered, or unsupported.");
  }
  if (!Array.isArray(plan.allowlist) || plan.allowlist.length > maximumAllowlistEntries) {
    throw new Error("Secret-scan allowlist is malformed or excessive.");
  }
  const allowlist = plan.allowlist.map(assertAllowlistEntry).sort(allowlistOrder);
  const keys = allowlist.map((entry) => `${entry.ruleId}:${entry.pathIdentitySha256}:${entry.secretSha256}`);
  if (new Set(keys).size !== keys.length) throw new Error("Secret-scan allowlist contains duplicate decisions.");
  const policySha256 = hash(plan.policySha256, "policy");
  return Object.freeze({
    schemaVersion: secretScanPlanSchemaVersion,
    policyId: "verified-patch-secret-policy/v1",
    policySha256,
    detectorId: "daily-improver-bounded-secret-detector",
    detectorVersion: "1",
    classifications: secretClassifications,
    allowlist: Object.freeze(allowlist),
  });
}

export function assertSecretScanResult(value: unknown, plan: SecretScanPlan): SecretScanResult {
  const result = exactRecord(value, [
    "classifications", "detectorId", "detectorVersion", "findingIdentitySemantics", "findings", "findingsSha256",
    "outcome", "patchSha256", "policyId", "policySha256", "scannedAddedLineCount", "schemaVersion",
  ], "Secret-scan result");
  if (result.schemaVersion !== secretScanResultSchemaVersion || result.policyId !== plan.policyId
    || result.policySha256 !== plan.policySha256 || result.detectorId !== plan.detectorId
    || result.detectorVersion !== plan.detectorVersion
    || JSON.stringify(result.classifications) !== JSON.stringify(plan.classifications)) {
    throw new Error("Secret-scan result identifies the wrong schema, policy, detector, or classifications.");
  }
  if (result.findingIdentitySemantics !== "rule-path-added-line-column-secret/v1") {
    throw new Error("Secret-scan result uses unsupported finding identity semantics.");
  }
  if (!Number.isSafeInteger(result.scannedAddedLineCount) || (result.scannedAddedLineCount as number) < 0
    || (result.scannedAddedLineCount as number) > maximumLine) {
    throw new Error("Secret-scan added-line count is malformed or excessive.");
  }
  if (!Array.isArray(result.findings) || result.findings.length > maximumFindings) {
    throw new Error("Secret-scan findings are malformed or excessive.");
  }
  const findings = result.findings.map(assertFinding).sort(findingOrder);
  const identities = findings.map((finding) => finding.findingIdentitySha256);
  if (new Set(identities).size !== identities.length) throw new Error("Secret-scan findings contain duplicate identities.");
  const allowed = new Map(plan.allowlist.map((entry) => [
    `${entry.ruleId}:${entry.pathIdentitySha256}:${entry.secretSha256}`,
    entry,
  ]));
  for (const finding of findings) {
    const expectedIdentity = secretScanHash(JSON.stringify([
      finding.ruleId, finding.pathIdentitySha256, finding.line, finding.column, finding.secretSha256,
    ]));
    if (finding.findingIdentitySha256 !== expectedIdentity) throw new Error("Secret finding identity is inconsistent.");
    const decision = allowed.get(`${finding.ruleId}:${finding.pathIdentitySha256}:${finding.secretSha256}`);
    if (!decision || decision.scope !== finding.allowlistScope
      || decision.justificationSha256 !== finding.allowlistJustificationSha256) {
      throw new Error("Secret finding does not have an exact runner-owned allowlist decision.");
    }
  }
  const outcome = findings.length === 0 ? "clean" : "allowlisted";
  if (result.outcome !== outcome) throw new Error("Secret-scan outcome is inconsistent with its findings.");
  const findingsSha256 = hash(result.findingsSha256, "findings");
  if (findingsSha256 !== secretScanHash(JSON.stringify(findings))) {
    throw new Error("Secret-scan findings identity is inconsistent.");
  }
  return Object.freeze({
    schemaVersion: secretScanResultSchemaVersion,
    policyId: plan.policyId,
    policySha256: plan.policySha256,
    detectorId: plan.detectorId,
    detectorVersion: plan.detectorVersion,
    classifications: plan.classifications,
    findingIdentitySemantics: "rule-path-added-line-column-secret/v1",
    patchSha256: hash(result.patchSha256, "patch"),
    scannedAddedLineCount: result.scannedAddedLineCount as number,
    findings: Object.freeze(findings),
    findingsSha256,
    outcome,
  });
}

export function secretScanHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertAllowlistEntry(value: unknown): SecretScanAllowlistEntry {
  const entry = exactRecord(value, [
    "justificationSha256", "pathIdentitySha256", "ruleId", "scope", "secretSha256",
  ], "Secret-scan allowlist entry");
  return Object.freeze({
    ruleId: identifier(entry.ruleId, "allowlist rule"),
    pathIdentitySha256: hash(entry.pathIdentitySha256, "allowlist path"),
    secretSha256: hash(entry.secretSha256, "allowlist secret"),
    scope: scope(entry.scope),
    justificationSha256: hash(entry.justificationSha256, "allowlist justification"),
  });
}

function assertFinding(value: unknown): SecretFinding {
  const finding = exactRecord(value, [
    "allowlistJustificationSha256", "allowlistScope", "classification", "column", "findingIdentitySha256",
    "line", "matchLength", "pathIdentitySha256", "ruleId", "secretSha256",
  ], "Secret finding");
  if (!secretClassifications.includes(finding.classification as SecretClassification)) {
    throw new Error("Secret finding classification is unsupported.");
  }
  const expectedClassification = classificationForRule(identifier(finding.ruleId, "finding rule"));
  if (finding.classification !== expectedClassification) throw new Error("Secret finding classification is inconsistent with its detector rule.");
  for (const [name, number] of [["line", finding.line], ["column", finding.column], ["match length", finding.matchLength]] as const) {
    if (!Number.isSafeInteger(number) || (number as number) < 1 || (number as number) > maximumLine) {
      throw new Error(`Secret finding ${name} is malformed or excessive.`);
    }
  }
  return Object.freeze({
    findingIdentitySha256: hash(finding.findingIdentitySha256, "finding"),
    ruleId: identifier(finding.ruleId, "finding rule"),
    classification: finding.classification as SecretClassification,
    pathIdentitySha256: hash(finding.pathIdentitySha256, "finding path"),
    line: finding.line as number,
    column: finding.column as number,
    matchLength: finding.matchLength as number,
    secretSha256: hash(finding.secretSha256, "finding secret"),
    allowlistScope: scope(finding.allowlistScope),
    allowlistJustificationSha256: hash(finding.allowlistJustificationSha256, "finding allowlist justification"),
  });
}

function classificationForRule(ruleId: string): SecretClassification {
  if (ruleId === "private-key-header/v1") return "private-key";
  if (ruleId === "github-token/v1" || ruleId === "slack-token/v1" || ruleId === "jwt/v1") return "token";
  if (ruleId === "aws-access-key/v1" || ruleId === "google-api-key/v1" || ruleId === "stripe-live-secret/v1") return "credential";
  if (ruleId === "entropy-assignment/v1") return "entropy-secret";
  throw new Error("Secret finding detector rule is unsupported.");
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-z0-9][a-z0-9._/-]*$/u.test(value)) {
    throw new Error(`Secret-scan ${name} identity is malformed.`);
  }
  return value;
}

function scope(value: unknown): SecretAllowlistScope {
  if (!allowlistScopes.includes(value as SecretAllowlistScope)) throw new Error("Secret-scan allowlist scope is unsupported.");
  return value as SecretAllowlistScope;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Secret-scan ${name} identity is malformed.`);
  return value;
}

function allowlistOrder(left: SecretScanAllowlistEntry, right: SecretScanAllowlistEntry): number {
  return left.ruleId.localeCompare(right.ruleId) || left.pathIdentitySha256.localeCompare(right.pathIdentitySha256)
    || left.secretSha256.localeCompare(right.secretSha256);
}

function findingOrder(left: SecretFinding, right: SecretFinding): number {
  return left.pathIdentitySha256.localeCompare(right.pathIdentitySha256) || left.line - right.line || left.column - right.column
    || left.ruleId.localeCompare(right.ruleId) || left.secretSha256.localeCompare(right.secretSha256);
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} is malformed.`);
  const record = value as Readonly<Record<string, unknown>>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${name} is extended or incomplete.`);
  }
  return record;
}
