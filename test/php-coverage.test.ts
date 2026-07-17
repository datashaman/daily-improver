import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import test from "node:test";
import type {
  EvidenceCommand,
  EvidenceResultStatus,
  EvidenceRun,
  EvidenceRunner,
} from "../src/contracts.js";
import type { CommandCapability } from "../src/domain/model.js";
import {
  collectPhpCoverageEvidence,
  phpCoverageSchemaVersion,
} from "../src/adapters/php-coverage.js";

const phpUnitCapability: CommandCapability = {
  kind: "coverage",
  command: ["composer", "repository-owned-coverage-script"],
  source: "manifest",
  framework: "phpunit",
};

const pestCapability: CommandCapability = {
  kind: "coverage",
  command: ["composer", "repository-owned-coverage-script"],
  source: "manifest",
  framework: "pest",
};

test("runs trusted PHPUnit coverage into an isolated Clover artifact and normalizes clean output", async () => {
  const runner = new StubEvidenceRunner({
    cloverXml: clover("/repository/src/WellTested.php", 10, 9),
  });
  const evidence = await collectPhpCoverageEvidence("/repository", phpUnitCapability, runner);

  assert.equal(runner.command?.identity, "phpunit.coverage");
  assert.equal(runner.command?.command[0], "vendor/bin/phpunit");
  assert.deepEqual(runner.command?.command.slice(1, 2), ["--coverage-clover"]);
  assert.equal(runner.command?.command.includes("repository-owned-coverage-script"), false);
  assert.equal(runner.cloverPath?.startsWith("/repository"), false);
  await assert.rejects(access(runner.cloverPath ?? ""));
  assert.equal(evidence.schemaVersion, phpCoverageSchemaVersion);
  assert.equal(evidence.result.status, "success");
  assert.deepEqual(evidence.findings, []);
  assert.equal(evidence.artifact?.sha256.startsWith("sha256:"), true);
  assert.equal("content" in (evidence.artifact ?? {}), false);
});

test("selects Pest and normalizes bounded low-coverage per-file evidence", async () => {
  const rawMarker = "raw-clover-must-not-persist";
  const runner = new StubEvidenceRunner({
    cloverXml: `<coverage><project>${fileXml("/repository/app/Domain/RiskyService.php", 20, 4)}<!-- ${rawMarker} --></project></coverage>`,
  });
  const evidence = await collectPhpCoverageEvidence("/repository", pestCapability, runner);

  assert.equal(runner.command?.command[0], "vendor/bin/pest");
  assert.equal(evidence.result.status, "code-finding");
  assert.deepEqual(evidence.findings.map(({ tool, file, statements, coveredStatements, coveragePercent }) => ({
    tool,
    file,
    statements,
    coveredStatements,
    coveragePercent,
  })), [{
    tool: "pest",
    file: "app/Domain/RiskyService.php",
    statements: 20,
    coveredStatements: 4,
    coveragePercent: 20,
  }]);
  assert.equal(evidence.candidates[0]?.target, "app/Domain/RiskyService.php");
  assert.equal(JSON.stringify(evidence).includes(rawMarker), false);
  assert.equal("stdout" in evidence.result, false);
});

test("distinguishes malformed Clover, configuration failure, and missing coverage support", async () => {
  const malformed = await collectPhpCoverageEvidence(
    "/repository",
    phpUnitCapability,
    new StubEvidenceRunner({ cloverXml: "<coverage><project>" }),
  );
  const configuration = await collectPhpCoverageEvidence(
    "/repository",
    phpUnitCapability,
    new StubEvidenceRunner({ exitCode: 2, stderr: "Could not load XML from empty phpunit.xml", writeArtifact: false }),
  );
  const missingSupport = await collectPhpCoverageEvidence(
    "/repository",
    pestCapability,
    new StubEvidenceRunner({ exitCode: 1, stderr: "No code coverage driver is available", writeArtifact: false }),
  );

  assert.equal(malformed.result.status, "infrastructure-failure");
  assert.equal(configuration.result.status, "configuration-failure");
  assert.equal(missingSupport.result.status, "missing-coverage-support");
  assert.deepEqual(malformed.findings, []);
});

test("preserves unavailable PHPUnit and timed-out Pest outcomes", async () => {
  const unavailable = await collectPhpCoverageEvidence(
    "/repository",
    phpUnitCapability,
    new StubEvidenceRunner({ forcedStatus: "unavailable-tool", exitCode: null, writeArtifact: false }),
  );
  const timeout = await collectPhpCoverageEvidence(
    "/repository",
    pestCapability,
    new StubEvidenceRunner({ forcedStatus: "timeout", exitCode: null, writeArtifact: false }),
  );

  assert.equal(unavailable.result.status, "unavailable-tool");
  assert.equal(timeout.result.status, "timeout");
  assert.equal(unavailable.artifact, null);
  assert.deepEqual(timeout.findings, []);
});

test("fails closed when PHPUnit command output is truncated", async () => {
  const evidence = await collectPhpCoverageEvidence(
    "/repository",
    phpUnitCapability,
    new StubEvidenceRunner({ outputTruncated: true, writeArtifact: false }),
  );

  assert.equal(evidence.result.status, "infrastructure-failure");
  assert.equal(evidence.result.outputTruncated, true);
  assert.equal(evidence.artifact, null);
});

test("hashes but does not parse a Clover artifact beyond the trusted size limit", async () => {
  const evidence = await collectPhpCoverageEvidence(
    "/repository",
    phpUnitCapability,
    new StubEvidenceRunner({ cloverXml: `<coverage><project><!-- ${"x".repeat(2 * 1024 * 1024)} --></project></coverage>` }),
  );

  assert.equal(evidence.result.status, "infrastructure-failure");
  assert.equal(evidence.artifact?.truncated, true);
  assert.equal(evidence.artifact?.bytes > (evidence.artifact?.limitBytes ?? Infinity), true);
  assert.deepEqual(evidence.findings, []);
});

function clover(file: string, statements: number, covered: number): string {
  return `<coverage><project>${fileXml(file, statements, covered)}</project></coverage>`;
}

function fileXml(file: string, statements: number, covered: number): string {
  return `<file name="${file}"><metrics statements="${statements}" coveredstatements="${covered}" /></file>`;
}

interface StubOptions {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputTruncated?: boolean;
  readonly forcedStatus?: EvidenceResultStatus;
  readonly cloverXml?: string;
  readonly writeArtifact?: boolean;
}

class StubEvidenceRunner implements EvidenceRunner {
  command?: EvidenceCommand;
  cloverPath: string | undefined;

  constructor(private readonly options: StubOptions) {}

  async run(command: EvidenceCommand): Promise<EvidenceRun> {
    this.command = command;
    const pathIndex = command.command.indexOf("--coverage-clover") + 1;
    this.cloverPath = command.command[pathIndex];
    if (this.options.writeArtifact !== false && this.cloverPath) {
      await writeFile(this.cloverPath, this.options.cloverXml ?? "");
    }
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
