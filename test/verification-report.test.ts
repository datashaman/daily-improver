import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signArtifact, verifyArtifact } from "../src/core/artifact-authentication.js";
import {
  assertVerificationReport,
  createVerificationReport,
  verificationEvidenceSchemaVersions,
  verificationReportSchemaVersion,
} from "../src/domain/verification-report.js";

const now = new Date("2026-07-19T10:30:00.000Z");
const inputs = {
  expectedBaseSha: "a".repeat(40),
  verifierInputsSha256: "b".repeat(64),
  mutationMode: "off" as const,
  commands: ["npm test", "npm run check"],
};

test("creates, validates, writes, and authenticates one exact bounded verification report", async () => {
  const report = createVerificationReport(
    inputs,
    evidence("off"),
    [
      { command: "npm test", exitCode: 0, durationMs: 120 },
      { command: "npm run check", exitCode: 0, durationMs: 80 },
    ],
    now.toISOString(),
  );
  assert.deepEqual(assertVerificationReport(report, inputs), report);

  const root = await mkdtemp(join(tmpdir(), "daily-improver-verification-report-"));
  const path = ".ai/runs/2026-07-19/verification.json";
  await mkdir(join(root, ".ai/runs/2026-07-19"), { recursive: true });
  await writeFile(join(root, path), `${JSON.stringify(report, null, 2)}\n`);
  await signArtifact(root, path, verificationReportSchemaVersion, "verification-report-test-key", now);
  const authenticated = JSON.parse((await verifyArtifact(root, path, verificationReportSchemaVersion, "verification-report-test-key", now)).toString("utf8"));
  assert.deepEqual(assertVerificationReport(authenticated, inputs), report);
});

test("rejects incomplete, extended, inconsistent, unsupported, unbounded, and adversarial signed reports", async () => {
  const report = createVerificationReport(
    inputs,
    evidence("off"),
    inputs.commands.map((command) => ({ command, exitCode: 0, durationMs: 1 })),
    now.toISOString(),
  );
  const { evidence: _missing, ...incomplete } = report;
  await assert.rejects(async () => assertVerificationReport(incomplete, inputs), /extended or incomplete/);
  await assert.rejects(async () => assertVerificationReport({ ...report, builderResult: { passed: true } }, inputs), /extended or incomplete/);
  await assert.rejects(async () => assertVerificationReport({ ...report, verifierInputsSha256: "c".repeat(64) }, inputs), /sealed verifier inputs/);
  await assert.rejects(async () => assertVerificationReport({ ...report, mutationMode: "targeted" }, inputs), /incomplete|mutation mode|sealed verifier inputs/);
  await assert.rejects(async () => assertVerificationReport({ ...report, checks: [{ ...report.checks[0], durationMs: 600_001 }] }, inputs), /duration/);
  await assert.rejects(async () => createVerificationReport(
    inputs,
    evidence("off"),
    [{ command: "builder-selected-check", exitCode: 0, durationMs: 1 }],
    now.toISOString(),
  ), /sealed commands/);

  const root = await mkdtemp(join(tmpdir(), "daily-improver-adversarial-verification-report-"));
  const path = ".ai/runs/2026-07-19/verification.json";
  await mkdir(join(root, ".ai/runs/2026-07-19"), { recursive: true });
  const adversarial = { ...report, evidence: report.evidence.slice(0, -1) };
  await writeFile(join(root, path), `${JSON.stringify(adversarial)}\n`);
  await signArtifact(root, path, verificationReportSchemaVersion, "verification-report-test-key", now);
  const authenticated = JSON.parse((await verifyArtifact(root, path, verificationReportSchemaVersion, "verification-report-test-key", now)).toString("utf8"));
  assert.throws(() => assertVerificationReport(authenticated, inputs), /incomplete/);
});

function evidence(mutationMode: "off" | "targeted") {
  return verificationEvidenceSchemaVersions(mutationMode).map((schemaVersion, index) => ({
    schemaVersion,
    value: { schemaVersion, identitySha256: index.toString(16).padStart(64, "0") },
  }));
}
