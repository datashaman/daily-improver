import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  EvidenceCommand,
  EvidenceResultStatus,
  EvidenceRun,
  EvidenceRunner,
} from "../src/contracts.js";
import type { CommandCapability } from "../src/domain/model.js";
import {
  collectPhpComplexityEvidence,
  phpComplexitySchemaVersion,
} from "../src/adapters/php-complexity.js";

const phpMetricsCapability: CommandCapability = {
  kind: "complexity",
  command: ["composer", "repository-owned-complexity-script"],
  source: "manifest",
  framework: "phpmetrics",
};

test("runs trusted PhpMetrics JSON analysis and normalizes clean output", async () => {
  const root = await repository();
  const runner = new StubEvidenceRunner({
    report: phpMetricsReport("App\\Domain\\SimpleService", 4, 92),
  });
  const evidence = await collectPhpComplexityEvidence(root, phpMetricsCapability, runner);

  assert.equal(runner.command?.identity, "phpmetrics.complexity");
  assert.equal(runner.command?.command[0], "vendor/bin/phpmetrics");
  assert.equal(runner.command?.command.includes("repository-owned-complexity-script"), false);
  assert.equal(runner.command?.command.at(-1), "app/Domain,src");
  assert.equal(runner.reportPath?.startsWith(root), false);
  await assert.rejects(access(runner.reportPath ?? ""));
  assert.equal(evidence.schemaVersion, phpComplexitySchemaVersion);
  assert.equal(evidence.result.status, "success");
  assert.deepEqual(evidence.findings, []);
  assert.equal(evidence.artifact?.sha256.startsWith("sha256:"), true);
  assert.equal("content" in (evidence.artifact ?? {}), false);
});

test("normalizes bounded high-complexity per-symbol evidence and maps its source file", async () => {
  const root = await repository();
  const rawMarker = "raw-phpmetrics-field-must-not-persist";
  const runner = new StubEvidenceRunner({
    report: JSON.stringify({
      "App\\Domain\\RiskyService": {
        name: "App\\Domain\\RiskyService",
        ccn: 18,
        ccnMethodMax: 14,
        mi: 43.5,
        methods: [{ raw: rawMarker }],
        _type: "Hal\\Metric\\ClassMetric",
      },
    }),
  });
  const evidence = await collectPhpComplexityEvidence(root, phpMetricsCapability, runner);

  assert.equal(evidence.result.status, "code-finding");
  assert.deepEqual(evidence.findings.map(({ tool, symbol, file, cyclomaticComplexity, maintainabilityIndex }) => ({
    tool,
    symbol,
    file,
    cyclomaticComplexity,
    maintainabilityIndex,
  })), [{
    tool: "phpmetrics",
    symbol: "App\\Domain\\RiskyService",
    file: "app/Domain/RiskyService.php",
    cyclomaticComplexity: 14,
    maintainabilityIndex: 43.5,
  }]);
  assert.equal(evidence.candidates[0]?.target, "app/Domain/RiskyService.php");
  assert.equal(JSON.stringify(evidence).includes(rawMarker), false);
  assert.equal("stdout" in evidence.result, false);
});

test("distinguishes malformed reports and PhpMetrics configuration failure", async () => {
  const root = await repository();
  const malformed = await collectPhpComplexityEvidence(
    root,
    phpMetricsCapability,
    new StubEvidenceRunner({ report: "not-json" }),
  );
  const configuration = await collectPhpComplexityEvidence(
    root,
    phpMetricsCapability,
    new StubEvidenceRunner({
      exitCode: 2,
      stderr: "Source directory does not exist",
      writeArtifact: false,
    }),
  );

  assert.equal(malformed.result.status, "infrastructure-failure");
  assert.equal(configuration.result.status, "configuration-failure");
  assert.deepEqual(malformed.findings, []);
});

test("preserves unavailable PhpMetrics and timeout outcomes", async () => {
  const root = await repository();
  const unavailable = await collectPhpComplexityEvidence(
    root,
    phpMetricsCapability,
    new StubEvidenceRunner({ forcedStatus: "unavailable-tool", exitCode: null, writeArtifact: false }),
  );
  const timeout = await collectPhpComplexityEvidence(
    root,
    phpMetricsCapability,
    new StubEvidenceRunner({ forcedStatus: "timeout", exitCode: null, writeArtifact: false }),
  );

  assert.equal(unavailable.result.status, "unavailable-tool");
  assert.equal(timeout.result.status, "timeout");
  assert.equal(unavailable.artifact, null);
  assert.deepEqual(timeout.findings, []);
});

test("fails closed when PhpMetrics command output is truncated", async () => {
  const evidence = await collectPhpComplexityEvidence(
    await repository(),
    phpMetricsCapability,
    new StubEvidenceRunner({ outputTruncated: true, writeArtifact: false }),
  );

  assert.equal(evidence.result.status, "infrastructure-failure");
  assert.equal(evidence.result.outputTruncated, true);
  assert.equal(evidence.artifact, null);
});

test("hashes but does not parse a PhpMetrics report beyond the trusted size limit", async () => {
  const evidence = await collectPhpComplexityEvidence(
    await repository(),
    phpMetricsCapability,
    new StubEvidenceRunner({ report: JSON.stringify({ padding: { raw: "x".repeat(2 * 1024 * 1024) } }) }),
  );

  assert.equal(evidence.result.status, "infrastructure-failure");
  assert.equal(evidence.artifact?.truncated, true);
  assert.equal(evidence.artifact?.bytes > (evidence.artifact?.limitBytes ?? Infinity), true);
  assert.deepEqual(evidence.findings, []);
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-complexity-test-"));
  await mkdir(join(root, "app", "Domain"), { recursive: true });
  await writeFile(join(root, "app", "Domain", "RiskyService.php"), "<?php\nnamespace App\\Domain;\nfinal class RiskyService {}\n");
  await writeFile(join(root, "app", "Domain", "SimpleService.php"), "<?php\nnamespace App\\Domain;\nfinal class SimpleService {}\n");
  return root;
}

function phpMetricsReport(symbol: string, complexity: number, maintainabilityIndex: number): string {
  return JSON.stringify({
    [symbol]: {
      name: symbol,
      ccn: complexity,
      ccnMethodMax: complexity,
      mi: maintainabilityIndex,
      _type: "Hal\\Metric\\ClassMetric",
    },
  });
}

interface StubOptions {
  readonly exitCode?: number | null;
  readonly stderr?: string;
  readonly outputTruncated?: boolean;
  readonly forcedStatus?: EvidenceResultStatus;
  readonly report?: string;
  readonly writeArtifact?: boolean;
}

class StubEvidenceRunner implements EvidenceRunner {
  command?: EvidenceCommand;
  reportPath: string | undefined;

  constructor(private readonly options: StubOptions) {}

  async run(command: EvidenceCommand): Promise<EvidenceRun> {
    this.command = command;
    const reportArgument = command.command.find((argument) => argument.startsWith("--report-json="));
    this.reportPath = reportArgument?.slice("--report-json=".length);
    if (this.options.writeArtifact !== false && this.reportPath) {
      await writeFile(this.reportPath, this.options.report ?? "");
    }
    const exitCode = this.options.exitCode === undefined ? 0 : this.options.exitCode;
    const stderr = this.options.stderr ?? "";
    const outputTruncated = this.options.outputTruncated ?? false;
    const status = this.options.forcedStatus ?? command.classify({
      exitCode: exitCode ?? 1,
      stdout: "",
      stderr,
      outputTruncated,
    });
    return {
      result: {
        commandIdentity: command.identity,
        command: command.command,
        status,
        durationMs: 15,
        exitCode,
        stdoutHash: "sha256:stdout",
        stderrHash: "sha256:stderr",
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(stderr),
        outputLimitBytes: command.maxOutputBytes,
        outputTruncated,
      },
      output: { stdout: "", stderr },
    };
  }
}
