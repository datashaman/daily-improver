import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestManifest, verifyTestManifest, verifyVerifierTestManifest } from "../src/core/artifacts.js";

test("detects builder changes to tests or specifications sealed by the test agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-manifest-"));
  await mkdir(join(root, "tests"));
  const file = join(root, "tests", "InvariantTest.php");
  await writeFile(file, "original");
  const spec = join(root, ".ai", "runs", "fixture", "spec.json");
  await mkdir(join(root, ".ai", "runs", "fixture"), { recursive: true });
  await writeFile(spec, "approved specification");
  const manifest = await createTestManifest(root, "ephemeral-key");
  assert.equal(await verifyTestManifest(root, manifest, "ephemeral-key"), true);
  await writeFile(file, "weakened");
  assert.equal(await verifyTestManifest(root, manifest, "ephemeral-key"), false);
  await writeFile(file, "original");
  await writeFile(spec, "builder-altered specification");
  assert.equal(await verifyTestManifest(root, manifest, "ephemeral-key"), false);
});

test("authenticates the signed manifest while omitting model rationale from verifier materialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-verifier-manifest-"));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests", "InvariantTest.php"), "original");
  const run = join(root, ".ai", "runs", "fixture");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "spec.json"), "approved specification");
  const rationale = join(run, "test-agent-rationale.json");
  await writeFile(rationale, "untrusted model output");
  const manifest = await createTestManifest(root, "ephemeral-key");

  await rm(rationale);
  assert.equal(await verifyTestManifest(root, manifest, "ephemeral-key"), false);
  assert.equal(await verifyVerifierTestManifest(root, manifest, "ephemeral-key"), true);
  await writeFile(join(root, "tests", "InvariantTest.php"), "weakened");
  assert.equal(await verifyVerifierTestManifest(root, manifest, "ephemeral-key"), false);
});
