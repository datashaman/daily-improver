import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertSecretScanPlan,
  assertSecretScanResult,
  secretScanHash,
} from "../src/domain/secret-scan.js";
import { prepareSecretScanPlan, scanVerifiedPatchForSecrets } from "../src/core/secret-scan.js";
import { CommandRunner } from "../src/infra/command-runner.js";

const runner = new CommandRunner();

test("scans one authenticated patch with exact bounded contracts, supported rules, and runner allowlists", async () => {
  const path = "src/example.ts";
  const fixture = await repositoryFixture(path);
  try {
    const plan = prepareSecretScanPlan();
    await writeFile(join(fixture.root, path), "const value = 'ordinary';\n");
    const clean = assertSecretScanResult(
      await scanVerifiedPatchForSecrets(fixture.root, fixture.base, [path], plan, runner),
      plan,
    );
    assert.equal(clean.outcome, "clean");
    assert.equal(clean.findings.length, 0);
    assert.doesNotMatch(JSON.stringify(clean), /ordinary|example\.ts/);
    assert.throws(() => assertSecretScanPlan(undefined), /malformed/);
    assert.throws(() => assertSecretScanPlan({ ...plan, extra: true }), /extended/);
    assert.throws(() => assertSecretScanPlan({ ...plan, policySha256: "raw" }), /identity/);
    assert.throws(() => assertSecretScanResult({ ...clean, extra: true }, plan), /extended/);
    assert.throws(() => assertSecretScanResult({ ...clean, findingsSha256: "f".repeat(64) }, plan), /inconsistent/);
    await assert.rejects(
      scanVerifiedPatchForSecrets(fixture.root, fixture.base, [path], { ...plan, policySha256: "f".repeat(64) }, runner),
      /policy is unavailable|unsupported/,
    );

    const cases = [
      { ruleId: "aws-access-key/v1", classification: "credential", secret: "AKIA1234567890ABCDEF", source: "const aws = 'AKIA1234567890ABCDEF';" },
      { ruleId: "google-api-key/v1", classification: "credential", secret: `AIza${"A".repeat(35)}`, source: `const google = 'AIza${"A".repeat(35)}';` },
      { ruleId: "private-key-header/v1", classification: "private-key", secret: "-----BEGIN PRIVATE KEY-----", source: "-----BEGIN PRIVATE KEY-----" },
      { ruleId: "github-token/v1", classification: "token", secret: `ghp_${"A1".repeat(18)}`, source: `const github = 'ghp_${"A1".repeat(18)}';` },
      { ruleId: "slack-token/v1", classification: "token", secret: "xoxb-1234567890-ABCDEFGHIJ", source: "const slack = 'xoxb-1234567890-ABCDEFGHIJ';" },
      { ruleId: "stripe-live-secret/v1", classification: "credential", secret: "sk_live_1234567890ABCDEF", source: "const stripe = 'sk_live_1234567890ABCDEF';" },
      { ruleId: "jwt/v1", classification: "token", secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.QWxhZGRpbjpPcGVuU2VzYW1l", source: "const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.QWxhZGRpbjpPcGVuU2VzYW1l';" },
      { ruleId: "entropy-assignment/v1", classification: "entropy-secret", secret: "mN7!qP2@vR9#xT4$zK8%", source: "const api_key = 'mN7!qP2@vR9#xT4$zK8%';" },
    ];
    await writeFile(join(fixture.root, path), `${cases.map((entry) => entry.source).join("\n")}\n`);
    await assert.rejects(
      scanVerifiedPatchForSecrets(fixture.root, fixture.base, [path], plan, runner),
      /unapproved (?:credential|private-key|token|entropy-secret) secret finding/,
    );
    const fixturePlan = prepareSecretScanPlan(cases.map((entry) => ({
      ruleId: entry.ruleId,
      pathIdentitySha256: secretScanHash(path),
      secretSha256: secretScanHash(entry.secret),
      scope: "explicit-test-fixture" as const,
      justificationSha256: secretScanHash(`deterministic ${entry.ruleId} rejection fixture`),
    })));
    const allowlisted = assertSecretScanResult(
      await scanVerifiedPatchForSecrets(fixture.root, fixture.base, [path], fixturePlan, runner),
      fixturePlan,
    );
    assert.equal(allowlisted.outcome, "allowlisted");
    assert.equal(allowlisted.findings.length, cases.length);
    assert.deepEqual(new Set(allowlisted.findings.map((finding) => finding.ruleId)), new Set(cases.map((entry) => entry.ruleId)));
    assert.deepEqual(new Set(allowlisted.findings.map((finding) => finding.classification)), new Set(cases.map((entry) => entry.classification)));
    assert.ok(allowlisted.findings.every((finding) => finding.allowlistScope === "explicit-test-fixture"));
    assert.doesNotMatch(JSON.stringify(allowlisted), /BEGIN PRIVATE KEY|example\.ts|deterministic parser/);

    const privateKey = cases.find((entry) => entry.ruleId === "private-key-header/v1")!;
    await writeFile(join(fixture.root, path), `${privateKey.source}\n`);
    const falsePositivePlan = prepareSecretScanPlan([{
      ruleId: privateKey.ruleId,
      pathIdentitySha256: secretScanHash(path),
      secretSha256: secretScanHash(privateKey.secret),
      scope: "known-false-positive",
      justificationSha256: secretScanHash("verified non-secret detector collision"),
    }]);
    assert.equal((await scanVerifiedPatchForSecrets(
      fixture.root,
      fixture.base,
      [path],
      falsePositivePlan,
      runner,
    )).outcome, "allowlisted");
  } finally {
    await fixture.cleanup();
  }
});

async function repositoryFixture(path: string): Promise<{
  readonly root: string;
  readonly base: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-secret-scan-"));
  await git(root, ["init"]);
  await writeFile(join(root, ".gitignore"), ".daily-improver\n");
  await git(root, ["add", ".gitignore"]);
  await git(root, ["-c", "user.name=Daily Improver", "-c", "user.email=daily@example.invalid", "commit", "-m", "baseline"]);
  const base = (await runner.run(["git", "rev-parse", "HEAD"], root)).stdout.trim();
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), "initial\n");
  await git(root, ["add", "-N", "--", path]);
  return { root, base, cleanup: async () => await rm(root, { recursive: true, force: true }) };
}

async function git(root: string, args: readonly string[]): Promise<void> {
  const result = await runner.run(["git", ...args], root);
  assert.equal(result.exitCode, 0, result.stderr);
}
