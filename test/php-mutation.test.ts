import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSON5 from "json5";
import type {
  EvidenceCommand,
  EvidenceResultStatus,
  EvidenceRun,
  EvidenceRunner,
} from "../src/contracts.js";
import { evidenceStubMetadata } from "./evidence-stub.js";
import type { CommandCapability } from "../src/domain/model.js";
import {
  collectPhpMutationEvidence,
  phpMutationSchemaVersion,
} from "../src/adapters/php-mutation.js";

const infectionCapability: CommandCapability = {
  kind: "mutation-testing",
  command: ["composer", "repository-owned-mutation-script"],
  source: "manifest",
  framework: "infection",
};

test("runs targeted Infection with a trusted mirrored config and normalizes clean output", async () => {
  const root = await repository();
  await writeFile(join(root, "infection.json5"), `{
    // The trusted copy must preserve analysis settings but replace repository loggers.
    source: { directories: ["src"], },
    mutators: { "@default": true, },
    logs: { json: ".ai/evidence/repository-owned.json", text: "infection.log" },
  }`);
  const runner = new StubEvidenceRunner({ report: infectionReport(root) });

  const evidence = await collectPhpMutationEvidence(root, infectionCapability, runner);

  assert.equal(runner.command?.identity, "infection.mutation");
  assert.equal(runner.command?.command[0], "vendor/bin/infection");
  assert.equal(runner.command?.command.includes("--filter=app/Domain,src"), true);
  assert.equal(runner.command?.command.includes("--threads=1"), true);
  assert.equal(runner.command?.command.includes("repository-owned-mutation-script"), false);
  assert.notEqual(runner.command?.cwd, root);
  assert.deepEqual(runner.command?.provenance.versionCommand, ["vendor/bin/infection", "--version"]);
  assert.deepEqual(runner.command?.provenance.configurationPaths, ["infection.json5"]);
  assert.equal(runner.command?.provenance.configurationRoot, root);
  assert.deepEqual(runner.generatedConfig?.source, { directories: ["src"] });
  assert.deepEqual(runner.generatedConfig?.mutators, { "@default": true });
  assert.deepEqual(Object.keys(runner.generatedConfig?.logs ?? {}), ["json"]);
  assert.equal(runner.reportPath?.startsWith(root), false);
  await assert.rejects(access(runner.reportPath ?? ""));
  assert.equal(evidence.schemaVersion, phpMutationSchemaVersion);
  assert.equal(evidence.result.status, "success");
  assert.deepEqual(evidence.findings, []);
  assert.equal(evidence.artifact?.sha256.startsWith("sha256:"), true);
  assert.equal("content" in (evidence.artifact ?? {}), false);
});

test("normalizes bounded escaped and not-covered mutations without retaining raw report fields", async () => {
  const root = await repository();
  const rawMarker = "raw-mutant-content-must-not-persist";
  const report = infectionReport(root, {
    escaped: [mutation(`${root}/src/Allocator.php`, 42, "ConditionalBoundary", rawMarker)],
    uncovered: [mutation(`${root}/app/Domain/Ledger.php`, 19, "ReturnRemoval", rawMarker)],
  });
  const evidence = await collectPhpMutationEvidence(
    root,
    infectionCapability,
    new StubEvidenceRunner({ report, exitCode: 1, stdout: "1 escaped mutant; 1 mutant was not covered" }),
  );

  assert.equal(evidence.result.status, "code-finding");
  assert.deepEqual(evidence.findings.map(({ status, file, line, mutator }) => ({ status, file, line, mutator })), [
    { status: "escaped", file: "src/Allocator.php", line: 42, mutator: "ConditionalBoundary" },
    { status: "not-covered", file: "app/Domain/Ledger.php", line: 19, mutator: "ReturnRemoval" },
  ]);
  assert.deepEqual(evidence.candidates.map((candidate) => candidate.target), [
    "src/Allocator.php",
    "app/Domain/Ledger.php",
  ]);
  assert.equal(JSON.stringify(evidence).includes(rawMarker), false);
  assert.equal("stdout" in evidence.result, false);
});

test("distinguishes malformed reports and invalid Infection configuration", async () => {
  const malformedRoot = await repository();
  const malformed = await collectPhpMutationEvidence(
    malformedRoot,
    infectionCapability,
    new StubEvidenceRunner({ rawReport: "not-json" }),
  );

  const configurationRoot = await repository();
  await writeFile(join(configurationRoot, "infection.json5"), "{ source: [ }");
  const configuration = await collectPhpMutationEvidence(
    configurationRoot,
    infectionCapability,
    new StubEvidenceRunner({ exitCode: 1, stderr: "Infection configuration is invalid", writeReport: false }),
  );

  assert.equal(malformed.result.status, "infrastructure-failure");
  assert.equal(configuration.result.status, "configuration-failure");
  assert.deepEqual(malformed.findings, []);
  assert.equal(configuration.artifact, null);
});

test("distinguishes missing coverage support from mutation infrastructure failures", async () => {
  const missingCoverage = await collectPhpMutationEvidence(
    await repository(),
    infectionCapability,
    new StubEvidenceRunner({ exitCode: 1, stderr: "No code coverage driver is available", writeReport: false }),
  );
  const infrastructureRoot = await repository();
  const erroredReport = infectionReport(infrastructureRoot, { errorCount: 1 });
  const infrastructure = await collectPhpMutationEvidence(
    infrastructureRoot,
    infectionCapability,
    new StubEvidenceRunner({ report: erroredReport }),
  );

  assert.equal(missingCoverage.result.status, "missing-coverage-support");
  assert.equal(infrastructure.result.status, "infrastructure-failure");
  assert.deepEqual(infrastructure.candidates, []);
});

test("preserves unavailable Infection and runner timeout outcomes", async () => {
  const unavailable = await collectPhpMutationEvidence(
    await repository(),
    infectionCapability,
    new StubEvidenceRunner({ forcedStatus: "unavailable-tool", exitCode: null, writeReport: false }),
  );
  const timeout = await collectPhpMutationEvidence(
    await repository(),
    infectionCapability,
    new StubEvidenceRunner({ forcedStatus: "timeout", exitCode: null, writeReport: false }),
  );

  assert.equal(unavailable.result.status, "unavailable-tool");
  assert.equal(timeout.result.status, "timeout");
  assert.equal(unavailable.artifact, null);
  assert.deepEqual(timeout.findings, []);
});

test("fails closed when Infection command output is truncated", async () => {
  const evidence = await collectPhpMutationEvidence(
    await repository(),
    infectionCapability,
    new StubEvidenceRunner({ outputTruncated: true, writeReport: false }),
  );

  assert.equal(evidence.result.status, "infrastructure-failure");
  assert.equal(evidence.result.outputTruncated, true);
  assert.equal(evidence.artifact, null);
});

test("hashes but does not parse an Infection report beyond the trusted size limit", async () => {
  const root = await repository();
  const evidence = await collectPhpMutationEvidence(
    root,
    infectionCapability,
    new StubEvidenceRunner({
      report: infectionReport(root, {
        escaped: [mutation(`${root}/src/Allocator.php`, 42, "ConditionalBoundary", "x".repeat(2 * 1024 * 1024))],
      }),
    }),
  );

  assert.equal(evidence.result.status, "infrastructure-failure");
  assert.equal(evidence.artifact?.truncated, true);
  assert.equal(evidence.artifact?.bytes > (evidence.artifact?.limitBytes ?? Infinity), true);
  assert.deepEqual(evidence.findings, []);
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-mutation-test-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "app", "Domain"), { recursive: true });
  await mkdir(join(root, "vendor", "bin"), { recursive: true });
  await writeFile(join(root, "composer.json"), "{}");
  return root;
}

interface InfectionReportOptions {
  readonly escaped?: readonly unknown[];
  readonly uncovered?: readonly unknown[];
  readonly errorCount?: number;
}

function infectionReport(root: string, options: InfectionReportOptions = {}): unknown {
  return {
    stats: {
      totalMutantsCount: (options.escaped?.length ?? 0) + (options.uncovered?.length ?? 0),
      killedCount: 0,
      notCoveredCount: options.uncovered?.length ?? 0,
      escapedCount: options.escaped?.length ?? 0,
      errorCount: options.errorCount ?? 0,
      syntaxErrorCount: 0,
      timeOutCount: 0,
      msi: 100,
    },
    escaped: options.escaped ?? [],
    timeouted: [],
    killed: [],
    errored: [],
    syntaxErrors: [],
    uncovered: options.uncovered ?? [],
    ignored: [],
    root,
  };
}

function mutation(file: string, line: number, mutatorName: string, rawMarker: string): unknown {
  return {
    mutator: {
      mutatorName,
      originalSourceCode: rawMarker,
      mutatedSourceCode: rawMarker,
      originalFilePath: file,
      originalStartLine: line,
    },
    diff: rawMarker,
    processOutput: rawMarker,
  };
}

interface StubOptions {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputTruncated?: boolean;
  readonly forcedStatus?: EvidenceResultStatus;
  readonly report?: unknown;
  readonly rawReport?: string;
  readonly writeReport?: boolean;
}

class StubEvidenceRunner implements EvidenceRunner {
  command?: EvidenceCommand;
  generatedConfig?: Record<string, unknown>;
  reportPath: string | undefined;

  constructor(private readonly options: StubOptions) {}

  async run(command: EvidenceCommand): Promise<EvidenceRun> {
    this.command = command;
    const configArgument = command.command.find((argument) => argument.startsWith("--configuration="));
    const configPath = configArgument?.slice("--configuration=".length);
    if (configPath) {
      try {
        this.generatedConfig = JSON5.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
        const logs = this.generatedConfig.logs as Record<string, unknown> | undefined;
        this.reportPath = typeof logs?.json === "string" ? logs.json : undefined;
      } catch {
        // The collector deliberately passes malformed repository configuration to Infection.
      }
    }
    if (this.options.writeReport !== false && this.reportPath) {
      await writeFile(
        this.reportPath,
        this.options.rawReport ?? JSON.stringify(this.options.report ?? infectionReport("/repository")),
      );
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
        ...evidenceStubMetadata(command),
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
