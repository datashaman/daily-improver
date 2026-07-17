import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  liveRunnerEnvironment,
  loadLiveTrustedRunnerInvocation,
} from "./support/live-trusted-runner-configuration.js";

test("live integration skips before reading configuration when explicitly optional", async () => {
  const invocation = await loadLiveTrustedRunnerInvocation({
    [liveRunnerEnvironment.mode]: "skip",
  });
  assert.equal(invocation.status, "skip");
});

test("live integration fails before network when explicitly required configuration is absent", async () => {
  await assert.rejects(
    () => loadLiveTrustedRunnerInvocation({ [liveRunnerEnvironment.mode]: "require" }),
    /required before network access/,
  );
  await assert.rejects(() => loadLiveTrustedRunnerInvocation({}), /must explicitly equal skip or require/);
});

test("live integration accepts only distinct ephemeral stage assertions and runner-owned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-live-config-"));
  const configurationPath = join(root, "configuration.json");
  const endpointPath = join(root, "endpoint.json");
  const exchangePath = join(root, "exchange.json");
  await Promise.all([
    writeFile(configurationPath, "{}\n"),
    writeFile(endpointPath, '{"url":"https://models.example/structured"}\n'),
    writeFile(exchangePath, '{"url":"https://control.example/exchange"}\n'),
  ]);
  const environment = {
    [liveRunnerEnvironment.mode]: "require",
    [liveRunnerEnvironment.configurationPath]: configurationPath,
    [liveRunnerEnvironment.endpointResolutionPath]: endpointPath,
    [liveRunnerEnvironment.exchangeResolutionPath]: exchangePath,
    [liveRunnerEnvironment.testIdentityAssertion]: "test-assertion",
    [liveRunnerEnvironment.buildIdentityAssertion]: "build-assertion",
    [liveRunnerEnvironment.workspace]: join(root, "workspace"),
  };
  const invocation = await loadLiveTrustedRunnerInvocation(environment);
  assert.equal(invocation.status, "ready");
  if (invocation.status === "ready") {
    assert.deepEqual(invocation.value.sensitiveValues, [
      "test-assertion",
      "build-assertion",
      "https://models.example/structured",
      "https://control.example/exchange",
    ]);
  }
  await assert.rejects(
    () => loadLiveTrustedRunnerInvocation({
      ...environment,
      [liveRunnerEnvironment.buildIdentityAssertion]: "test-assertion",
    }),
    /must be distinct/,
  );
});
