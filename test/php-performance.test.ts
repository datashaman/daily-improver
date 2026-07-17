import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectPhpPerformanceEvidence,
  laravelSlowQueryReportSchemaVersion,
  laravelSlowQuerySchemaVersion,
  phpPerformanceCommand,
  phpPerformanceSchemaVersion,
  phpSlowTestSchemaVersion,
} from "../src/adapters/php-performance.js";
import { defaultConfig, type ImproverConfig } from "../src/config.js";
import type { EvidenceCommand, EvidenceResultStatus, EvidenceRun, EvidenceRunner } from "../src/contracts.js";
import type { CommandCapability } from "../src/domain/model.js";
import { evidenceStubMetadata } from "./evidence-stub.js";

const phpUnitCapability: CommandCapability = {
  kind: "test",
  command: ["vendor/bin/phpunit"],
  framework: "phpunit",
  source: "manifest",
};

const fixtureRoot = join(process.cwd(), "test", "fixtures", "php-performance");
const junit = await readFile(join(fixtureRoot, "junit.xml"), "utf8");
const queries = await readFile(join(fixtureRoot, "laravel-queries.json"), "utf8");

function config(mechanism: "off" | "laravel-listener" = "off"): ImproverConfig["analysis"]["php"] {
  return {
    ...defaultConfig.analysis.php,
    slow_test_threshold_ms: 500,
    slow_query: { mechanism, threshold_ms: 100 },
  };
}

interface RunnerOptions {
  readonly forcedStatus?: EvidenceResultStatus;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputTruncated?: boolean;
}

class PerformanceRunner implements EvidenceRunner {
  command?: EvidenceCommand;

  constructor(
    private readonly options: RunnerOptions = {},
    private readonly junitOutput: string | null = junit,
    private readonly queryOutput: string | null = null,
  ) {}

  async run(command: EvidenceCommand): Promise<EvidenceRun> {
    this.command = command;
    const junitPath = command.command[command.command.indexOf("--log-junit") + 1];
    if (this.junitOutput !== null && junitPath) await writeFile(junitPath, this.junitOutput);
    const queryPath = command.environment?.DAILY_IMPROVER_LARAVEL_QUERY_LOG;
    if (this.queryOutput !== null && queryPath) await writeFile(queryPath, this.queryOutput);
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
        durationMs: 1,
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

test("runs PHPUnit directly and normalizes bounded slow-test timing evidence", async () => {
  const runner = new PerformanceRunner();
  const evidence = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config(), false, runner);

  assert.deepEqual(runner.command?.command.slice(0, 2), ["vendor/bin/phpunit", "--log-junit"]);
  assert.deepEqual(phpPerformanceCommand("phpunit", "report.xml"), ["vendor/bin/phpunit", "--log-junit", "report.xml", "--colors=never"]);
  assert.equal(evidence.schemaVersion, phpPerformanceSchemaVersion);
  assert.equal(evidence.slowTests.schemaVersion, phpSlowTestSchemaVersion);
  assert.equal(evidence.slowTests.status, "code-finding");
  assert.deepEqual(evidence.slowTests.findings.map(({ test, file, line, durationMs, thresholdMs }) => ({ test, file, line, durationMs, thresholdMs })), [{
    test: "Tests\\Feature\\MoneyAllocatorTest::test_allocates_money",
    file: "tests/Feature/MoneyAllocatorTest.php",
    line: 18,
    durationMs: 1250,
    thresholdMs: 500,
  }]);
  assert.equal(evidence.candidates[0]?.kind, "performance");
  assert.equal(evidence.slowQueries.status, "unsupported-input");
});

test("collects explicit Laravel listener output without retaining raw SQL or parameters", async () => {
  const runner = new PerformanceRunner({}, junit, queries);
  const evidence = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config("laravel-listener"), true, runner);

  assert.equal(runner.command?.environment?.DAILY_IMPROVER_LARAVEL_QUERY_THRESHOLD_MS, "100");
  assert.equal(evidence.slowQueries.status, "code-finding");
  assert.equal(evidence.slowQueries.findings.length, 1);
  const finding = evidence.slowQueries.findings[0];
  assert.equal(finding?.file, "app/Repositories/AllocationRepository.php");
  assert.equal(finding?.durationMs, 245);
  assert.match(finding?.queryIdentity ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(evidence).includes("private@example.test"), false);
  assert.equal(JSON.stringify(evidence).includes("8675309"), false);
  assert.equal(evidence.schemaVersion, phpPerformanceSchemaVersion);
  assert.equal(evidence.slowQueries.schemaVersion, laravelSlowQuerySchemaVersion);
  assert.equal(laravelSlowQueryReportSchemaVersion, "laravel-slow-query-report/v1");
});

test("reports clean test and query artifacts independently", async () => {
  const cleanJunit = "<testsuites><testsuite><testcase name=\"fast\" class=\"FastTest\" file=\"tests/FastTest.php\" time=\"0.001\" /></testsuite></testsuites>";
  const cleanQueries = JSON.stringify({ schemaVersion: laravelSlowQueryReportSchemaVersion, queries: [] });
  const evidence = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config("laravel-listener"), true, new PerformanceRunner({}, cleanJunit, cleanQueries));

  assert.equal(evidence.slowTests.status, "clean");
  assert.equal(evidence.slowQueries.status, "clean");
  assert.deepEqual(evidence.findings, []);
});

test("distinguishes unsupported and missing Laravel listener inputs", async () => {
  const unsupported = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config("laravel-listener"), false, new PerformanceRunner());
  const missingListener = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config("laravel-listener"), true, new PerformanceRunner());

  assert.equal(unsupported.slowQueries.status, "unsupported-input");
  assert.equal(missingListener.slowQueries.status, "configuration-failure");
  assert.equal(missingListener.result.status, "configuration-failure");
});

test("distinguishes malformed reports and test configuration failures", async () => {
  const malformedJUnit = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config(), false, new PerformanceRunner({}, "not-xml"));
  const malformedQueries = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config("laravel-listener"), true, new PerformanceRunner({}, junit, "not-json"));
  const configuration = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config(), false, new PerformanceRunner({ exitCode: 2, stderr: "Could not load XML from phpunit.xml" }, null));

  assert.equal(malformedJUnit.slowTests.status, "infrastructure-failure");
  assert.equal(malformedQueries.slowQueries.status, "infrastructure-failure");
  assert.equal(malformedQueries.result.status, "infrastructure-failure");
  assert.equal(configuration.slowTests.status, "configuration-failure");
});

test("preserves unavailable tools, timeouts, output truncation, and infrastructure failures", async () => {
  const unavailable = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config(), false, new PerformanceRunner({ forcedStatus: "unavailable-tool", exitCode: null }, null));
  const timeout = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config(), false, new PerformanceRunner({ forcedStatus: "timeout", exitCode: null }, null));
  const truncated = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config(), false, new PerformanceRunner({ outputTruncated: true }, null));
  const infrastructure = await collectPhpPerformanceEvidence("/repository", phpUnitCapability, config(), false, new PerformanceRunner({ exitCode: 2, stderr: "segmentation fault" }, null));

  assert.equal(unavailable.slowTests.status, "unavailable-tool");
  assert.equal(timeout.slowTests.status, "timeout");
  assert.equal(truncated.slowTests.status, "truncated");
  assert.equal(infrastructure.slowTests.status, "infrastructure-failure");
});

test("rejects oversized artifacts and out-of-repository identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-performance-test-"));
  const oversized = `<testsuites>${"x".repeat(2 * 1024 * 1024)}</testsuites>`;
  const oversizedEvidence = await collectPhpPerformanceEvidence(root, phpUnitCapability, config(), false, new PerformanceRunner({}, oversized));
  const escaped = `<testsuites><testcase name=\"slow\" file=\"../secret.php\" time=\"1\" /></testsuites>`;
  const escapedEvidence = await collectPhpPerformanceEvidence(root, phpUnitCapability, config(), false, new PerformanceRunner({}, escaped));

  assert.equal(oversizedEvidence.slowTests.status, "truncated");
  assert.equal(oversizedEvidence.slowTests.artifact?.truncated, true);
  assert.equal(escapedEvidence.slowTests.status, "infrastructure-failure");
});
