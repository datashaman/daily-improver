import assert from "node:assert/strict";
import test from "node:test";
import type {
  EvidenceCommand,
  EvidenceResultStatus,
  EvidenceRun,
  EvidenceRunner,
} from "../src/contracts.js";
import type { CommandCapability } from "../src/domain/model.js";
import {
  collectPhpStaticAnalysisEvidence,
  phpStaticAnalysisSchemaVersion,
} from "../src/adapters/php-static-analysis.js";

const phpStanCapability: CommandCapability = {
  kind: "static-analysis",
  command: ["composer", "repository-owned-analysis-script"],
  source: "manifest",
  framework: "phpstan",
};

const psalmCapability: CommandCapability = {
  kind: "static-analysis",
  command: ["composer", "repository-owned-analysis-script"],
  source: "manifest",
  framework: "psalm",
};

test("runs the trusted PHPStan JSON command and normalizes clean output", async () => {
  const runner = new StubEvidenceRunner({
    stdout: JSON.stringify({ totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] }),
  });
  const evidence = await collectPhpStaticAnalysisEvidence("/repository", phpStanCapability, runner);

  assert.deepEqual(runner.command?.command, [
    "vendor/bin/phpstan",
    "analyse",
    "--error-format=json",
    "--no-progress",
    "--no-interaction",
  ]);
  assert.equal(runner.command?.identity, "phpstan.analyse");
  assert.equal(runner.command?.cwd, "/repository");
  assert.equal(evidence.schemaVersion, phpStaticAnalysisSchemaVersion);
  assert.equal(evidence.result.status, "success");
  assert.deepEqual(evidence.findings, []);
});

test("normalizes bounded PHPStan file, line, identifier, and message evidence", async () => {
  const rawSuffix = "must-not-persist";
  const runner = new StubEvidenceRunner({
    exitCode: 1,
    stdout: JSON.stringify({
      totals: { errors: 0, file_errors: 1 },
      files: {
        "/repository/src/Allocator.php": {
          errors: 1,
          messages: [{
            message: `Return type does not match ${"x".repeat(600)}${rawSuffix}`,
            line: 42,
            ignorable: true,
            identifier: "return.type",
            tip: "raw tip must not persist",
          }],
        },
      },
      errors: [],
    }),
  });
  const evidence = await collectPhpStaticAnalysisEvidence("/repository", phpStanCapability, runner);

  assert.equal(evidence.result.status, "code-finding");
  assert.equal(evidence.findings[0]?.file, "src/Allocator.php");
  assert.equal(evidence.findings[0]?.line, 42);
  assert.equal(evidence.findings[0]?.rule, "return.type");
  assert.equal(evidence.findings[0]?.message.length, 512);
  assert.equal(evidence.candidates[0]?.target, "src/Allocator.php");
  assert.equal(JSON.stringify(evidence).includes(rawSuffix), false);
  assert.equal(JSON.stringify(evidence).includes("raw tip"), false);
  assert.equal("stdout" in evidence.result, false);
});

test("selects Psalm from manifest capability and normalizes its JSON issues", async () => {
  const runner = new StubEvidenceRunner({
    exitCode: 2,
    stdout: JSON.stringify([{
      type: "InvalidReturnType",
      message: "The declared return type is incorrect",
      file_name: "Service.php",
      file_path: "/repository/app/Service.php",
      line_from: 17,
      shortcode: 11,
    }]),
  });
  const evidence = await collectPhpStaticAnalysisEvidence("/repository", psalmCapability, runner);

  assert.deepEqual(runner.command?.command, [
    "vendor/bin/psalm",
    "--output-format=json",
    "--no-progress",
  ]);
  assert.equal(evidence.result.status, "code-finding");
  assert.deepEqual(evidence.findings.map(({ tool, file, line, rule }) => ({ tool, file, line, rule })), [{
    tool: "psalm",
    file: "app/Service.php",
    line: 17,
    rule: "InvalidReturnType",
  }]);
});

test("distinguishes malformed machine output from configuration failure", async () => {
  const malformed = await collectPhpStaticAnalysisEvidence(
    "/repository",
    phpStanCapability,
    new StubEvidenceRunner({ exitCode: 1, stdout: "not-json" }),
  );
  const configuration = await collectPhpStaticAnalysisEvidence(
    "/repository",
    phpStanCapability,
    new StubEvidenceRunner({ exitCode: 1, stderr: "Configuration file phpstan.neon is invalid." }),
  );
  const globalError = await collectPhpStaticAnalysisEvidence(
    "/repository",
    phpStanCapability,
    new StubEvidenceRunner({
      exitCode: 1,
      stdout: JSON.stringify({ files: {}, errors: ["Path app/Legacy does not exist"] }),
    }),
  );

  assert.equal(malformed.result.status, "infrastructure-failure");
  assert.equal(configuration.result.status, "configuration-failure");
  assert.equal(globalError.result.status, "configuration-failure");
  assert.deepEqual(malformed.findings, []);
});

test("preserves missing executable and timeout outcomes without parsing output", async () => {
  const unavailable = await collectPhpStaticAnalysisEvidence(
    "/repository",
    phpStanCapability,
    new StubEvidenceRunner({ forcedStatus: "unavailable-tool", exitCode: null }),
  );
  const timeout = await collectPhpStaticAnalysisEvidence(
    "/repository",
    psalmCapability,
    new StubEvidenceRunner({ forcedStatus: "timeout", exitCode: null }),
  );

  assert.equal(unavailable.result.status, "unavailable-tool");
  assert.equal(timeout.result.status, "timeout");
  assert.deepEqual(unavailable.findings, []);
  assert.deepEqual(timeout.findings, []);
});

test("fails closed when static-analysis output is truncated", async () => {
  const evidence = await collectPhpStaticAnalysisEvidence(
    "/repository",
    phpStanCapability,
    new StubEvidenceRunner({
      exitCode: 1,
      stdout: JSON.stringify({ files: {}, errors: [] }),
      outputTruncated: true,
    }),
  );

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
        commandIdentity: command.identity,
        command: command.command,
        status,
        durationMs: 15,
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
