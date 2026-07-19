import type { CommandRunner } from "../infra/command-runner.js";
import {
  assertSecretScanPlan,
  secretClassifications,
  secretScanHash,
  type SecretClassification,
  type SecretFinding,
  type SecretScanAllowlistEntry,
  type SecretScanPlan,
  type SecretScanResult,
} from "../domain/secret-scan.js";

const maximumPatchBytes = 16 * 1024 * 1024;
const maximumAddedLines = 250_000;
const maximumFindings = 1_000;

const policyBase = Object.freeze({
  policyId: "verified-patch-secret-policy/v1",
  detectorId: "daily-improver-bounded-secret-detector",
  detectorVersion: "1",
  classifications: secretClassifications,
  rules: [
    "aws-access-key/v1",
    "google-api-key/v1",
    "private-key-header/v1",
    "github-token/v1",
    "slack-token/v1",
    "stripe-live-secret/v1",
    "jwt/v1",
    "entropy-assignment/v1",
  ],
  entropy: {
    minimumLength: 20,
    maximumLength: 256,
    minimumBitsPerCharacter: 3.5,
    minimumCharacterClasses: 3,
    hexadecimalMinimumLength: 32,
  },
});

interface AddedLine {
  readonly path: string;
  readonly line: number;
  readonly source: string;
}

interface Detection {
  readonly ruleId: string;
  readonly classification: SecretClassification;
  readonly column: number;
  readonly matchLength: number;
  readonly secret: string;
}

export function prepareSecretScanPlan(allowlist: readonly SecretScanAllowlistEntry[] = []): SecretScanPlan {
  const sorted = [...allowlist].sort((left, right) => left.ruleId.localeCompare(right.ruleId)
    || left.pathIdentitySha256.localeCompare(right.pathIdentitySha256) || left.secretSha256.localeCompare(right.secretSha256));
  return assertSecretScanPlan({
    schemaVersion: "secret-scan-plan/v1",
    policyId: policyBase.policyId,
    policySha256: policyIdentity(sorted),
    detectorId: policyBase.detectorId,
    detectorVersion: policyBase.detectorVersion,
    classifications: policyBase.classifications,
    allowlist: sorted,
  });
}

export async function scanVerifiedPatchForSecrets(
  root: string,
  expectedBaseSha: string,
  productionPaths: readonly string[],
  plan: SecretScanPlan,
  runner: CommandRunner,
): Promise<SecretScanResult> {
  if (plan.policySha256 !== policyIdentity(plan.allowlist)
    || plan.policyId !== policyBase.policyId || plan.detectorId !== policyBase.detectorId
    || plan.detectorVersion !== policyBase.detectorVersion
    || JSON.stringify(plan.classifications) !== JSON.stringify(policyBase.classifications)) {
    throw new Error("Secret-scan policy is unavailable, redirected, or unsupported.");
  }
  assertCommit(expectedBaseSha);
  const paths = validatePaths(productionPaths);
  let totalBytes = 0;
  const mutablePatchParts: [string, string][] = [];
  const addedLines: AddedLine[] = [];
  for (const path of paths) {
    const result = await runner.run([
      "git", "diff", "--no-ext-diff", "--no-color", "--no-renames", "--text", "--unified=0", expectedBaseSha, "--", path,
    ], root);
    if (result.exitCode !== 0) throw new Error("Verified secret-scan patch is unavailable.");
    totalBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (totalBytes > maximumPatchBytes || result.stderr !== "" || result.stdout.includes("\0") || result.stdout.includes("\ufffd")) {
      throw new Error("Verified secret-scan patch is unavailable, malformed, or excessive.");
    }
    mutablePatchParts.push([path, result.stdout]);
    addedLines.push(...parseAddedLines(path, result.stdout));
    if (addedLines.length > maximumAddedLines) throw new Error("Verified secret-scan added-line inventory is excessive.");
  }
  const allowlist = new Map(plan.allowlist.map((entry) => [allowlistKey(entry.ruleId, entry.pathIdentitySha256, entry.secretSha256), entry]));
  const findings: SecretFinding[] = [];
  for (const added of addedLines) {
    const pathIdentitySha256 = secretScanHash(added.path);
    for (const detection of detectSecrets(added.source)) {
      const secretSha256 = secretScanHash(detection.secret);
      const findingIdentitySha256 = secretScanHash(JSON.stringify([
        detection.ruleId, pathIdentitySha256, added.line, detection.column, secretSha256,
      ]));
      const approved = allowlist.get(allowlistKey(detection.ruleId, pathIdentitySha256, secretSha256));
      if (!approved) {
        throw new Error(`Verified patch contains an unapproved ${detection.classification} secret finding (${findingIdentitySha256}).`);
      }
      findings.push(Object.freeze({
        findingIdentitySha256,
        ruleId: detection.ruleId,
        classification: detection.classification,
        pathIdentitySha256,
        line: added.line,
        column: detection.column,
        matchLength: detection.matchLength,
        secretSha256,
        allowlistScope: approved.scope,
        allowlistJustificationSha256: approved.justificationSha256,
      }));
      if (findings.length > maximumFindings) throw new Error("Verified secret-scan finding inventory is excessive.");
    }
  }
  findings.sort((left, right) => left.pathIdentitySha256.localeCompare(right.pathIdentitySha256)
    || left.line - right.line || left.column - right.column || left.ruleId.localeCompare(right.ruleId));
  return Object.freeze({
    schemaVersion: "secret-scan-result/v1",
    policyId: plan.policyId,
    policySha256: plan.policySha256,
    detectorId: plan.detectorId,
    detectorVersion: plan.detectorVersion,
    classifications: plan.classifications,
    findingIdentitySemantics: "rule-path-added-line-column-secret/v1",
    patchSha256: secretScanHash(JSON.stringify(mutablePatchParts)),
    scannedAddedLineCount: addedLines.length,
    findings: Object.freeze(findings),
    findingsSha256: secretScanHash(JSON.stringify(findings)),
    outcome: findings.length === 0 ? "clean" : "allowlisted",
  });
}

function detectSecrets(source: string): readonly Detection[] {
  const detections: Detection[] = [];
  collect(source, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "aws-access-key/v1", "credential", detections);
  collect(source, /\bAIza[0-9A-Za-z_-]{35}\b/gu, "google-api-key/v1", "credential", detections);
  collect(source, /-----BEGIN (?:OPENSSH |RSA |EC |DSA |PGP )?PRIVATE KEY-----/gu, "private-key-header/v1", "private-key", detections);
  collect(source, /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82,255})\b/gu, "github-token/v1", "token", detections);
  collect(source, /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/gu, "slack-token/v1", "token", detections);
  collect(source, /\bsk_live_[A-Za-z0-9]{16,255}\b/gu, "stripe-live-secret/v1", "credential", detections);
  collect(source, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "jwt/v1", "token", detections);

  const assignment = /\b(?:api[_-]?key|client[_-]?secret|access[_-]?key|password|passwd|secret|token)\b\s*[:=]\s*["']([^"'\r\n]{20,256})["']/giu;
  for (const match of source.matchAll(assignment)) {
    const secret = match[1];
    if (!secret || isKnownPlaceholder(secret) || !isHighEntropy(secret)) continue;
    const start = (match.index ?? 0) + (match[0].indexOf(secret));
    detections.push({
      ruleId: "entropy-assignment/v1",
      classification: "entropy-secret",
      column: start + 1,
      matchLength: secret.length,
      secret,
    });
  }
  const unique = new Map(detections.map((finding) => [
    `${finding.ruleId}:${finding.column}:${finding.secret}`,
    finding,
  ]));
  return [...unique.values()].sort((left, right) => left.column - right.column || left.ruleId.localeCompare(right.ruleId));
}

function collect(
  source: string,
  expression: RegExp,
  ruleId: string,
  classification: SecretClassification,
  detections: Detection[],
): void {
  for (const match of source.matchAll(expression)) {
    const secret = match[0];
    if (!secret) continue;
    detections.push({ ruleId, classification, column: (match.index ?? 0) + 1, matchLength: secret.length, secret });
  }
}

function parseAddedLines(path: string, patch: string): readonly AddedLine[] {
  const result: AddedLine[] = [];
  let nextLine: number | undefined;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) { nextLine = Number(hunk[1]); continue; }
    if (nextLine === undefined) continue;
    if (line.startsWith("+")) {
      result.push({ path, line: nextLine, source: line.slice(1) });
      nextLine++;
    } else if (line.startsWith(" ")) nextLine++;
    else if (line.startsWith("-") || line.startsWith("\\ No newline")) { /* No current line consumed. */ }
    else if (line.startsWith("diff --git ")) nextLine = undefined;
  }
  return result;
}

function isKnownPlaceholder(value: string): boolean {
  return /^(?:x+|\*+|<[^>]+>|\$\{[^}]+\}|(?:example|dummy|fake|placeholder|test|changeme|replace[-_ ]?me)[A-Za-z0-9._-]*)$/iu.test(value);
}

function isHighEntropy(value: string): boolean {
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter((pattern) => pattern.test(value)).length;
  const hexadecimal = value.length >= policyBase.entropy.hexadecimalMinimumLength
    && /^[a-f0-9]+$/iu.test(value) && /[a-f]/iu.test(value) && /\d/u.test(value);
  if (classes < policyBase.entropy.minimumCharacterClasses && !hexadecimal) return false;
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= policyBase.entropy.minimumBitsPerCharacter;
}

function validatePaths(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error("Secret-scan production path list is missing or excessive.");
  const paths: string[] = [...value].sort();
  for (const path of paths) {
    if (!path || path.length > 1_024 || path.startsWith("/") || path.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("Secret-scan production path escaped the authenticated patch.");
    }
  }
  if (new Set(paths).size !== paths.length) throw new Error("Secret-scan production path list contains duplicates.");
  return paths;
}

function policyIdentity(allowlist: readonly SecretScanAllowlistEntry[]): string {
  return secretScanHash(JSON.stringify([policyBase, allowlist]));
}

function allowlistKey(ruleId: string, pathIdentitySha256: string, secretSha256: string): string {
  return `${ruleId}:${pathIdentitySha256}:${secretSha256}`;
}

function assertCommit(value: string): void {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) throw new Error("Secret-scan baseline commit identity is malformed.");
}
