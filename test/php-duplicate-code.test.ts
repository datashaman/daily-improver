import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectPhpDuplicateCodeEvidence,
  phpDuplicateCodeCommand,
  phpDuplicateCodeSchemaVersion,
} from "../src/adapters/php-duplicate-code.js";
import type { EvidenceCommand, EvidenceResultStatus, EvidenceRun, EvidenceRunner } from "../src/contracts.js";
import type { CommandCapability } from "../src/domain/model.js";
import { evidenceStubMetadata } from "./evidence-stub.js";

const capability: CommandCapability = {
  kind: "duplicate-code",
  command: ["composer", "repository-owned-duplicate-script"],
  source: "manifest",
  framework: "phpcpd",
};

const fixture = await readFile(join(process.cwd(), "test", "fixtures", "php-duplicate-code", "phpcpd.xml"), "utf8");

interface RunnerOptions {
  readonly forcedStatus?: EvidenceResultStatus;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputTruncated?: boolean;
  readonly report?: string | null;
}

class PhpCpdRunner implements EvidenceRunner {
  command?: EvidenceCommand;
  reportPath: string | undefined;

  constructor(private readonly options: RunnerOptions = {}) {}

  async run(command: EvidenceCommand): Promise<EvidenceRun> {
    this.command = command;
    this.reportPath = command.command[command.command.indexOf("--log-pmd") + 1];
    if (this.options.report !== null && this.reportPath) await writeFile(this.reportPath, this.options.report ?? "<pmd-cpd/>");
    const exitCode = this.options.exitCode === undefined ? 0 : this.options.exitCode;
    const stdout = this.options.stdout ?? "";
    const stderr = this.options.stderr ?? "";
    const outputTruncated = this.options.outputTruncated ?? false;
    const status = this.options.forcedStatus ?? command.classify({ exitCode: exitCode ?? 1, stdout, stderr, outputTruncated });
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

test("runs PHPCPD directly and normalizes clean machine-readable output", async () => {
  const runner = new PhpCpdRunner();
  const evidence = await collectPhpDuplicateCodeEvidence("/repository", capability, runner);

  assert.deepEqual(runner.command?.command.slice(0, 2), ["vendor/bin/phpcpd", "--log-pmd"]);
  assert.deepEqual(phpDuplicateCodeCommand("report.xml"), ["vendor/bin/phpcpd", "--log-pmd", "report.xml", "app", "src"]);
  assert.equal(runner.command?.command.includes("repository-owned-duplicate-script"), false);
  assert.deepEqual(runner.command?.provenance.versionCommand, ["vendor/bin/phpcpd", "--version"]);
  assert.deepEqual(runner.command?.provenance.configurationPaths, [".ai/improver.yml"]);
  assert.equal(runner.reportPath?.startsWith("/repository"), false);
  await assert.rejects(access(runner.reportPath ?? ""));
  assert.equal(evidence.schemaVersion, phpDuplicateCodeSchemaVersion);
  assert.equal(evidence.status, "clean");
  assert.equal(evidence.result.status, "success");
  assert.deepEqual(evidence.findings, []);
});

test("normalizes bounded duplicate regions and drops duplicated source bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-duplicate-test-"));
  const report = fixture.replaceAll("{ROOT}", root);
  const evidence = await collectPhpDuplicateCodeEvidence(root, capability, new PhpCpdRunner({ exitCode: 1, report }));

  assert.equal(evidence.status, "code-finding");
  assert.equal(evidence.result.status, "code-finding");
  assert.deepEqual(evidence.findings.map(({ tool, lines, tokens, similarityPercent, occurrenceCount, regions, message }) => ({ tool, lines, tokens, similarityPercent, occurrenceCount, regions, message })), [{
    tool: "phpcpd",
    lines: 8,
    tokens: 46,
    similarityPercent: 100,
    occurrenceCount: 2,
    regions: [
      { file: "app/Services/FirstAllocator.php", startLine: 12, endLine: 19 },
      { file: "src/Allocation/SecondAllocator.php", startLine: 28, endLine: 35 },
    ],
    message: "PHPCPD found 8 duplicated lines (46 tokens) across 2 regions.",
  }]);
  assert.deepEqual(evidence.candidates[0]?.suggestedFiles, [
    "app/Services/FirstAllocator.php",
    "src/Allocation/SecondAllocator.php",
    "tests",
  ]);
  assert.equal(JSON.stringify(evidence).includes("private customer source body"), false);
  assert.equal("content" in (evidence.artifact ?? {}), false);
  assert.match(evidence.result.provenance.configurationHash ?? "", /^sha256:/);
});

test("distinguishes unsupported inputs and configuration failures", async () => {
  const unsupported = await collectPhpDuplicateCodeEvidence("/repository", capability, new PhpCpdRunner({
    exitCode: 2,
    stderr: "PHP 9.0 is not supported",
    report: null,
  }));
  const configuration = await collectPhpDuplicateCodeEvidence("/repository", capability, new PhpCpdRunner({
    exitCode: 2,
    stderr: "Invalid option in configuration",
    report: null,
  }));

  assert.equal(unsupported.status, "unsupported-input");
  assert.equal(configuration.status, "configuration-failure");
  assert.deepEqual(unsupported.findings, []);
});

test("distinguishes unavailable tooling and timeouts", async () => {
  const unavailable = await collectPhpDuplicateCodeEvidence("/repository", capability, new PhpCpdRunner({ forcedStatus: "unavailable-tool", exitCode: null, report: null }));
  const timeout = await collectPhpDuplicateCodeEvidence("/repository", capability, new PhpCpdRunner({ forcedStatus: "timeout", exitCode: null, report: null }));

  assert.equal(unavailable.status, "unavailable-tool");
  assert.equal(unavailable.result.status, "unavailable-tool");
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.result.status, "timeout");
});

test("distinguishes command truncation, malformed output, and infrastructure failures", async () => {
  const truncated = await collectPhpDuplicateCodeEvidence("/repository", capability, new PhpCpdRunner({ outputTruncated: true, report: null }));
  const malformed = await collectPhpDuplicateCodeEvidence("/repository", capability, new PhpCpdRunner({ report: "<pmd-cpd><duplication>" }));
  const missing = await collectPhpDuplicateCodeEvidence("/repository", capability, new PhpCpdRunner({ report: null }));
  const infrastructure = await collectPhpDuplicateCodeEvidence("/repository", capability, new PhpCpdRunner({ exitCode: 2, stderr: "segmentation fault", report: null }));

  assert.equal(truncated.status, "truncated");
  assert.equal(truncated.result.outputTruncated, true);
  assert.equal(malformed.status, "malformed-output");
  assert.equal(missing.status, "malformed-output");
  assert.equal(infrastructure.status, "infrastructure-failure");
});

test("rejects oversized artifacts and escaped source paths", async () => {
  const oversized = await collectPhpDuplicateCodeEvidence("/repository", capability, new PhpCpdRunner({ report: `<pmd-cpd>${"x".repeat(2 * 1024 * 1024)}</pmd-cpd>` }));
  const escaped = `<pmd-cpd><duplication lines="4" tokens="20"><file path="../secret.php" line="1"/><file path="src/Okay.php" line="2"/></duplication></pmd-cpd>`;
  const escapedEvidence = await collectPhpDuplicateCodeEvidence("/repository", capability, new PhpCpdRunner({ exitCode: 1, report: escaped }));

  assert.equal(oversized.status, "truncated");
  assert.equal(oversized.artifact?.truncated, true);
  assert.equal(escapedEvidence.status, "malformed-output");
  assert.deepEqual(escapedEvidence.findings, []);
});
