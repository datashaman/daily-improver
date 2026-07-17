import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import test from "node:test";
import { BoundedEvidenceRunner } from "../src/infra/bounded-evidence-runner.js";

const runner = new BoundedEvidenceRunner();

test("records bounded metadata for a successful evidence command", async () => {
  const run = await runner.run(command([process.execPath, "-e", "process.stdout.write('valid')"]));

  assert.equal(run.result.status, "success");
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.result.stdoutHash, sha256("valid"));
  assert.equal(run.result.stdoutBytes, 5);
  assert.equal(run.output.stdout, "valid");
  assert.equal("stdout" in run.result, false);
});

test("terminates evidence commands at their explicit timeout", async () => {
  const run = await runner.run(command(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 50 },
  ));

  assert.equal(run.result.status, "timeout");
  assert.ok(run.result.durationMs < 1_000);
});

test("classifies a missing evidence executable as unavailable", async () => {
  const run = await runner.run(command(["daily-improver-command-that-does-not-exist"]));

  assert.equal(run.result.status, "unavailable-tool");
  assert.equal(run.result.exitCode, null);
});

test("hashes all output while truncating transient output to the configured limit", async () => {
  const fullOutput = "abcdefghijklmnop";
  const run = await runner.run(command(
    [process.execPath, "-e", `process.stdout.write('${fullOutput}')`],
    { maxOutputBytes: 8 },
  ));

  assert.equal(run.result.status, "success");
  assert.equal(run.result.outputTruncated, true);
  assert.equal(run.result.stdoutBytes, fullOutput.length);
  assert.equal(run.result.stdoutHash, sha256(fullOutput));
  assert.equal(run.output.stdout, "abcdefgh");
});

function command(
  executable: readonly string[],
  overrides: { readonly timeoutMs?: number; readonly maxOutputBytes?: number } = {},
) {
  return {
    identity: "test.command",
    command: executable,
    cwd: tmpdir(),
    timeoutMs: overrides.timeoutMs ?? 5_000,
    maxOutputBytes: overrides.maxOutputBytes ?? 1_024,
    classify: ({ exitCode }: { readonly exitCode: number }) => exitCode === 0 ? "success" as const : "code-finding" as const,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
