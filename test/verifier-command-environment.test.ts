import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createVerifierCommandEnvironmentDecision,
  runVerifierCommand,
  validateVerifierCommandEnvironmentDecision,
} from "../src/core/verifier-command-environment.js";
import { CommandRunner, type CommandResult } from "../src/infra/command-runner.js";

test("runs each verifier command with exact ambient-free variables and fresh storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-verifier-environment-test-"));
  const runner = new CommandRunner();
  const decision = createVerifierCommandEnvironmentDecision({
    PATH: process.env.PATH,
    DAILY_IMPROVER_AMBIENT_CREDENTIAL: "must-not-cross",
    XDG_CACHE_HOME: join(root, "untrusted-cache"),
  });
  const first = await runVerifierCommand(runner, decision, [
    "/bin/sh",
    "-c",
    "test -z \"${DAILY_IMPROVER_AMBIENT_CREDENTIAL:-}\" && test \"$DAILY_IMPROVER_VERIFIER_ENVIRONMENT\" = verifier-command-environment/v1 && test ! -e \"$XDG_CACHE_HOME/sentinel\" && touch \"$HOME/first-command-state\" && printf '%s' \"$HOME\"",
  ], root);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.match(first.stdout, /daily-improver-verifier-command-/);

  const second = await runVerifierCommand(runner, decision, [
    "/bin/sh",
    "-c",
    "test ! -e \"$HOME/first-command-state\" && test ! -e \"$XDG_CACHE_HOME/sentinel\"",
  ], root);
  assert.equal(second.exitCode, 0, second.stderr);
});

test("rejects unavailable, malformed, extended, unsupported, and escaped decisions before commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-verifier-environment-rejection-"));
  const valid = createVerifierCommandEnvironmentDecision({ PATH: "/usr/bin:/bin" });
  const invalid = [
    undefined,
    { ...valid, schemaVersion: "verifier-command-environment/v0" },
    { ...valid, isolation: "shared" },
    { ...valid, inheritedVariables: ["HOME"] },
    { ...valid, path: ".:/usr/bin" },
    { ...valid, extra: true },
  ];
  for (const value of invalid) {
    assert.throws(() => validateVerifierCommandEnvironmentDecision(value));
  }
  await assert.rejects(
    runVerifierCommand(new CommandRunner(), valid, ["/bin/true"], root, 1_000, {
      DAILY_IMPROVER_TEST_LIFECYCLE_PATH: join(root, "..", "escaped.json"),
    }),
    /escapes the fresh checkout/,
  );
});

test("rejects ineffective exact-environment execution before the repository command", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-verifier-environment-probe-"));
  const marker = join(root, "repository-command-ran");
  const runner = new IneffectiveEnvironmentRunner();
  await assert.rejects(
    runVerifierCommand(
      runner,
      createVerifierCommandEnvironmentDecision({ PATH: "/usr/bin:/bin" }),
      ["/bin/sh", "-c", `printf ran > ${marker}`],
      root,
    ),
    /isolation was ineffective/,
  );
  await assert.rejects(readFile(marker), /ENOENT/);
});

class IneffectiveEnvironmentRunner extends CommandRunner {
  override async runWithExactEnvironment(
    command: readonly string[],
    cwd: string,
    _timeoutMs: number,
    environment: Readonly<Record<string, string>>,
  ): Promise<CommandResult> {
    if (command[0] === "/usr/bin/env") {
      return {
        command,
        exitCode: 0,
        stdout: `${Object.entries(environment).map(([name, value]) => `${name}=${value}`).join("\0")}\0AMBIENT_SECRET=leaked\0`,
        stderr: "",
        durationMs: 0,
      };
    }
    await writeFile(join(cwd, "repository-command-ran"), "ran");
    return { command, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  }
}
