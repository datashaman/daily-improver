import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceCommand, EvidenceRun, EvidenceRunner } from "../src/contracts.js";
import { evidenceStubMetadata } from "./evidence-stub.js";
import { collectComposerValidationEvidence } from "../src/adapters/composer-validation.js";

test("invokes the trusted Composer validation command directly", async () => {
  const runner = new StubEvidenceRunner(0, "./composer.json is valid");
  const evidence = await collectComposerValidationEvidence("/repository", runner);

  assert.deepEqual(runner.command?.command, ["composer", "validate", "--no-interaction", "--no-plugins"]);
  assert.equal(runner.command?.identity, "composer.validate");
  assert.equal(runner.command?.cwd, "/repository");
  assert.deepEqual(runner.command?.provenance.versionCommand, ["composer", "--version"]);
  assert.deepEqual(runner.command?.provenance.configurationPaths, ["composer.json", "composer.lock"]);
  assert.deepEqual(evidence.candidates, []);
});

test("normalizes invalid Composer configuration without retaining raw output", async () => {
  const runner = new StubEvidenceRunner(1, "", "raw composer error");
  const evidence = await collectComposerValidationEvidence("/repository", runner);

  assert.equal(evidence.result.status, "configuration-failure");
  assert.equal(evidence.candidates[0]?.id, "php-composer-validation");
  assert.equal(evidence.candidates[0]?.title, "Repair invalid Composer configuration");
  assert.equal(JSON.stringify(evidence.result).includes("raw composer error"), false);
});

test("normalizes successful Composer validation warnings as code findings", async () => {
  const runner = new StubEvidenceRunner(0, "valid, but with some warnings");
  const evidence = await collectComposerValidationEvidence("/repository", runner);

  assert.equal(evidence.result.status, "code-finding");
  assert.equal(evidence.candidates[0]?.title, "Resolve Composer validation warnings");
});

class StubEvidenceRunner implements EvidenceRunner {
  command?: EvidenceCommand;

  constructor(
    private readonly exitCode: number,
    private readonly stdout = "",
    private readonly stderr = "",
  ) {}

  async run(command: EvidenceCommand): Promise<EvidenceRun> {
    this.command = command;
    const status = command.classify({
      exitCode: this.exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
      outputTruncated: false,
    });
    return {
      result: {
        ...evidenceStubMetadata(command),
        commandIdentity: command.identity,
        command: command.command,
        status,
        durationMs: 12,
        exitCode: this.exitCode,
        stdoutHash: "sha256:stdout",
        stderrHash: "sha256:stderr",
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(this.stderr),
        outputLimitBytes: command.maxOutputBytes,
        outputTruncated: false,
      },
      output: { stdout: this.stdout, stderr: this.stderr },
    };
  }
}
