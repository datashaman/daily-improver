import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preparePhpVerifierStaticAnalysis } from "../src/adapters/php-verifier-static-analysis.js";
import { runRequiredVerifierCommand, unavailableRequiredVerifierAdapter } from "../src/core/required-verifier.js";
import { createVerifierCommandEnvironmentDecision } from "../src/core/verifier-command-environment.js";
import {
  assertRequiredVerifierUnavailableDecision,
  createRequiredVerifierUnavailableDecision,
  RequiredVerifierUnavailableError,
} from "../src/domain/required-verifier.js";
import { CommandRunner } from "../src/infra/command-runner.js";

test("validates one exact bounded source-free required-verifier unavailability decision", () => {
  const decision = createRequiredVerifierUnavailableDecision(
    "static-analysis",
    "tool",
    "tool-unavailable",
    "php:phpstan:/private/repository:secret-command --token credential",
  );
  assert.deepEqual(assertRequiredVerifierUnavailableDecision(decision), decision);
  assert.equal(decision.requiredResultSchemaVersion, "static-analysis-result/v1");
  const serialized = JSON.stringify(decision);
  for (const forbidden of ["/private/repository", "secret-command", "credential", "phpstan"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.throws(() => assertRequiredVerifierUnavailableDecision({ ...decision, command: "npm test" }), /extended/);
  assert.throws(() => assertRequiredVerifierUnavailableDecision({ ...decision, requiredResultSchemaVersion: "other/v1" }), /inconsistent/);
  assert.throws(() => assertRequiredVerifierUnavailableDecision({ ...decision, reason: "capability-unavailable" }), /inconsistent/);
  assert.throws(() => assertRequiredVerifierUnavailableDecision({ ...decision, selectionSha256: "repository/path" }), /identity/);
});

test("classifies unavailable sealed commands without retaining the command or its output", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-required-command-"));
  const command = ["/bin/sh", "-c", "printf 'sensitive verifier output' >&2; exit 127"];
  await assert.rejects(
    runRequiredVerifierCommand(
      new CommandRunner(),
      createVerifierCommandEnvironmentDecision(process.env),
      command,
      root,
      10_000,
      "ordinary-command",
      "sealed-command:sensitive-command",
    ),
    (error: unknown) => {
      assert.ok(error instanceof RequiredVerifierUnavailableError);
      assert.equal(error.decision.boundary, "command");
      assert.equal(error.decision.requiredResultSchemaVersion, "verification-check-binding/v1");
      assert.equal(JSON.stringify(error.decision).includes("sensitive"), false);
      return true;
    },
  );
});

test("classifies unavailable adapter and tool boundaries with exact contract identities", async () => {
  assert.throws(
    () => unavailableRequiredVerifierAdapter("php", "validation-boundaries"),
    (error: unknown) => {
      assert.ok(error instanceof RequiredVerifierUnavailableError);
      assert.equal(error.decision.boundary, "adapter");
      assert.equal(error.decision.requiredResultSchemaVersion, "validation-boundary-result/v1");
      return true;
    },
  );

  const root = await mkdtemp(join(tmpdir(), "daily-improver-required-tool-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({ require: { php: "^8.2" } }));
  await assert.rejects(preparePhpVerifierStaticAnalysis(root), (error: unknown) => {
    assert.ok(error instanceof RequiredVerifierUnavailableError);
    assert.equal(error.decision.boundary, "tool");
    assert.equal(error.decision.verifierContract, "static-analysis");
    assert.equal(JSON.stringify(error.decision).includes(root), false);
    return true;
  });
});
