import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestManifest, verifyTestManifest } from "../src/core/artifacts.js";

test("detects builder changes to tests sealed by the test agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-manifest-"));
  await mkdir(join(root, "tests"));
  const file = join(root, "tests", "InvariantTest.php");
  await writeFile(file, "original");
  const manifest = await createTestManifest(root, "ephemeral-key");
  assert.equal(await verifyTestManifest(root, manifest, "ephemeral-key"), true);
  await writeFile(file, "weakened");
  assert.equal(await verifyTestManifest(root, manifest, "ephemeral-key"), false);
});
