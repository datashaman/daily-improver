import assert from "node:assert/strict";
import test from "node:test";
import type {
  EvidenceCommand,
  EvidenceResultStatus,
  EvidenceRun,
  EvidenceRunner,
} from "../src/contracts.js";
import { evidenceStubMetadata } from "./evidence-stub.js";
import {
  collectComposerAuditEvidence,
  composerAuditSchemaVersion,
} from "../src/adapters/composer-audit.js";

test("invokes the trusted Composer audit command directly and normalizes clean output", async () => {
  const runner = new StubEvidenceRunner({ stdout: JSON.stringify({ advisories: [], abandoned: [] }) });
  const evidence = await collectComposerAuditEvidence("/repository", runner);

  assert.deepEqual(runner.command?.command, [
    "composer",
    "audit",
    "--format=json",
    "--no-interaction",
    "--no-plugins",
  ]);
  assert.equal(runner.command?.identity, "composer.audit");
  assert.equal(runner.command?.cwd, "/repository");
  assert.deepEqual(runner.command?.provenance.versionCommand, ["composer", "--version"]);
  assert.deepEqual(runner.command?.provenance.configurationPaths, ["composer.json", "composer.lock"]);
  assert.equal(evidence.schemaVersion, composerAuditSchemaVersion);
  assert.equal(evidence.result.status, "success");
  assert.deepEqual(evidence.findings, []);
});

test("normalizes legacy Composer vulnerability output independently of package-count exit codes", async () => {
  const runner = new StubEvidenceRunner({
    exitCode: 4,
    stdout: JSON.stringify({
      advisories: {
        "symfony/http-foundation": [{
          advisoryId: "PKSA-aaaa-bbbb-cccc",
          packageName: "symfony/http-foundation",
          affectedVersions: ">=6.0,<6.4.14",
          cve: "CVE-2024-0001",
          severity: "high",
          title: "raw advisory title must not persist",
          link: "https://example.test/raw",
        }],
      },
    }),
  });
  const evidence = await collectComposerAuditEvidence("/repository", runner);

  assert.equal(evidence.result.status, "code-finding");
  assert.deepEqual(evidence.findings, [{
    kind: "vulnerability",
    id: "composer:vulnerability:symfony/http-foundation:PKSA-aaaa-bbbb-cccc",
    packageName: "symfony/http-foundation",
    advisoryId: "PKSA-aaaa-bbbb-cccc",
    cve: "CVE-2024-0001",
    affectedVersions: ">=6.0,<6.4.14",
    severity: "high",
  }]);
  assert.equal(evidence.candidates[0]?.kind, "dependency-vulnerability");
  assert.equal(evidence.candidates[0]?.target, "symfony/http-foundation");
  assert.equal(JSON.stringify(evidence).includes("raw advisory title"), false);
  assert.equal(JSON.stringify(evidence).includes("https://example.test/raw"), false);
});

test("normalizes Composer 2.10 abandoned-package and dependency-policy findings", async () => {
  const runner = new StubEvidenceRunner({
    exitCode: 1,
    stdout: JSON.stringify({
      advisories: [],
      abandoned: { "old/package": "new/package" },
      filter: {
        "blocked/package": [{ listName: "malware", id: "MAL-123", reason: "raw reason" }],
      },
    }),
  });
  const evidence = await collectComposerAuditEvidence("/repository", runner);

  assert.equal(evidence.result.status, "code-finding");
  assert.deepEqual(evidence.findings, [
    {
      kind: "abandoned-package",
      id: "composer:abandoned:old/package",
      packageName: "old/package",
      replacement: "new/package",
    },
    {
      kind: "policy",
      id: "composer:policy:blocked/package:malware:MAL-123",
      packageName: "blocked/package",
      policyName: "malware",
      policyEntryId: "MAL-123",
    },
  ]);
  assert.equal(JSON.stringify(evidence).includes("raw reason"), false);
});

test("accepts the pre-2.6.4 abandoned-package array shape", async () => {
  const runner = new StubEvidenceRunner({
    stdout: JSON.stringify({
      advisories: [],
      abandoned: [{ name: "old/package", abandoned: "new/package" }],
    }),
  });
  const evidence = await collectComposerAuditEvidence("/repository", runner);

  assert.equal(evidence.result.status, "code-finding");
  assert.equal(evidence.findings[0]?.id, "composer:abandoned:old/package");
});

test("classifies malformed JSON and unreachable repositories as infrastructure failures", async () => {
  const malformed = await collectComposerAuditEvidence(
    "/repository",
    new StubEvidenceRunner({ exitCode: 1, stdout: "{malformed" }),
  );
  const unreachable = await collectComposerAuditEvidence(
    "/repository",
    new StubEvidenceRunner({
      exitCode: 1,
      stdout: JSON.stringify({ advisories: [], abandoned: {}, "unreachable-repositories": ["private repository"] }),
    }),
  );

  assert.equal(malformed.result.status, "infrastructure-failure");
  assert.equal(unreachable.result.status, "infrastructure-failure");
  assert.deepEqual(malformed.findings, []);
  assert.deepEqual(unreachable.findings, []);
});

test("distinguishes Composer configuration and missing-package failures", async () => {
  const configuration = await collectComposerAuditEvidence(
    "/repository",
    new StubEvidenceRunner({ exitCode: 1, stderr: "composer.json does not match the expected JSON schema" }),
  );
  const missing = await collectComposerAuditEvidence(
    "/repository",
    new StubEvidenceRunner({ exitCode: 0, stderr: "No packages - skipping audit." }),
  );

  assert.equal(configuration.result.status, "configuration-failure");
  assert.equal(missing.result.status, "missing-packages");
});

test("preserves unavailable-tool and timeout outcomes without parsing output", async () => {
  const unavailable = await collectComposerAuditEvidence(
    "/repository",
    new StubEvidenceRunner({ forcedStatus: "unavailable-tool", exitCode: null }),
  );
  const timeout = await collectComposerAuditEvidence(
    "/repository",
    new StubEvidenceRunner({ forcedStatus: "timeout", exitCode: null }),
  );

  assert.equal(unavailable.result.status, "unavailable-tool");
  assert.equal(timeout.result.status, "timeout");
  assert.deepEqual(unavailable.findings, []);
  assert.deepEqual(timeout.findings, []);
});

test("fails closed when Composer audit JSON is truncated", async () => {
  const runner = new StubEvidenceRunner({
    exitCode: 1,
    stdout: JSON.stringify({ advisories: { "vendor/package": [] } }),
    outputTruncated: true,
  });
  const evidence = await collectComposerAuditEvidence("/repository", runner);

  assert.equal(evidence.result.status, "infrastructure-failure");
  assert.equal(evidence.result.outputTruncated, true);
  assert.deepEqual(evidence.findings, []);
});

interface StubOptions {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputTruncated?: boolean;
  readonly forcedStatus?: EvidenceResultStatus;
}

class StubEvidenceRunner implements EvidenceRunner {
  command?: EvidenceCommand;

  constructor(private readonly options: StubOptions) {}

  async run(command: EvidenceCommand): Promise<EvidenceRun> {
    this.command = command;
    const exitCode = this.options.exitCode === undefined ? 0 : this.options.exitCode;
    const stdout = this.options.stdout ?? "";
    const stderr = this.options.stderr ?? "";
    const outputTruncated = this.options.outputTruncated ?? false;
    const status = this.options.forcedStatus ?? command.classify({
      exitCode: exitCode ?? 1,
      stdout,
      stderr,
      outputTruncated,
    });
    return {
      result: {
        ...evidenceStubMetadata(command),
        commandIdentity: command.identity,
        command: command.command,
        status,
        durationMs: 12,
        exitCode,
        stdoutHash: "sha256:stdout",
        stderrHash: "sha256:stderr",
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        outputLimitBytes: command.maxOutputBytes,
        outputTruncated,
      },
      output: { stdout, stderr },
    };
  }
}
