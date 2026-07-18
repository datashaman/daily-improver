import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactAuthenticationPath, signArtifact, verifyArtifact } from "../src/core/artifact-authentication.js";

const key = "runner-owned-artifact-key";
const now = new Date("2026-07-18T12:00:00.000Z");

test("authenticates one exact versioned artifact with runner-owned key material", async () => {
  const root = await fixture();
  const path = ".ai/runs/2026-07-18/verification.json";
  await writeFile(join(root, path), '{"schemaVersion":"verification-report/v1","passed":true}\n');
  const authentication = await signArtifact(root, path, "verification-report/v1", key, now);
  assert.equal(authentication.schemaVersion, "artifact-authentication/v1");
  assert.equal((await verifyArtifact(root, path, "verification-report/v1", key, now)).length > 0, true);
});

test("rejects tampered, missing, malformed, extended, unsupported, stale, and future-issued artifacts", async () => {
  const path = ".ai/runs/2026-07-18/verification.json";

  const tampered = await fixture();
  await writeFile(join(tampered, path), '{"schemaVersion":"verification-report/v1","passed":true}\n');
  await signArtifact(tampered, path, "verification-report/v1", key, now);
  await writeFile(join(tampered, path), '{"schemaVersion":"verification-report/v1","passed":false}\n');
  await assert.rejects(verifyArtifact(tampered, path, "verification-report/v1", key, now), /identity changed/);

  const missing = await fixture();
  await writeFile(join(missing, path), '{"schemaVersion":"verification-report/v1"}\n');
  await assert.rejects(verifyArtifact(missing, path, "verification-report/v1", key, now), /missing/);

  const malformed = await fixture();
  await writeFile(join(malformed, path), '{"schemaVersion":"verification-report/v1"}\n');
  await signArtifact(malformed, path, "verification-report/v1", key, now);
  await writeFile(join(malformed, artifactAuthenticationPath(path)), "not-json\n");
  await assert.rejects(verifyArtifact(malformed, path, "verification-report/v1", key, now), /malformed/);

  const extended = await fixture();
  await writeFile(join(extended, path), '{"schemaVersion":"verification-report/v1"}\n');
  await signArtifact(extended, path, "verification-report/v1", key, now);
  const signaturePath = join(extended, artifactAuthenticationPath(path));
  const authentication = JSON.parse(await readFile(signaturePath, "utf8")) as Record<string, unknown>;
  await writeFile(signaturePath, `${JSON.stringify({ ...authentication, extension: true })}\n`);
  await assert.rejects(verifyArtifact(extended, path, "verification-report/v1", key, now), /exact artifact-authentication/);

  const unsupported = await fixture();
  await writeFile(join(unsupported, path), '{"schemaVersion":"verification-report/v2"}\n');
  await assert.rejects(signArtifact(unsupported, path, "verification-report/v1", key, now), /must use verification-report\/v1/);

  const stale = await fixture();
  await writeFile(join(stale, path), '{"schemaVersion":"verification-report/v1"}\n');
  await signArtifact(stale, path, "verification-report/v1", key, now);
  await assert.rejects(
    verifyArtifact(stale, path, "verification-report/v1", key, new Date("2026-07-19T12:00:00.001Z")),
    /stale/,
  );

  const future = await fixture();
  await writeFile(join(future, path), '{"schemaVersion":"verification-report/v1"}\n');
  await signArtifact(future, path, "verification-report/v1", key, new Date("2026-07-18T12:06:00.000Z"));
  await assert.rejects(verifyArtifact(future, path, "verification-report/v1", key, now), /stale/);
});

test("rejects non-regular, symlinked, traversing, and ambiguously addressed artifacts", async () => {
  const root = await fixture();
  const run = join(root, ".ai", "runs", "2026-07-18");
  await mkdir(join(run, "directory.json"));
  await assert.rejects(signArtifact(root, ".ai/runs/2026-07-18/directory.json", "verification-report/v1", key, now), /non-regular/);

  await writeFile(join(run, "outside.json"), '{"schemaVersion":"verification-report/v1"}\n');
  await symlink("outside.json", join(run, "linked.json"));
  await assert.rejects(signArtifact(root, ".ai/runs/2026-07-18/linked.json", "verification-report/v1", key, now), /non-regular/);
  await assert.rejects(signArtifact(root, "../outside.json", "verification-report/v1", key, now), /path is malformed/);
  await assert.rejects(signArtifact(root, ".ai//runs/2026-07-18/outside.json", "verification-report/v1", key, now), /path is malformed/);
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-artifact-authentication-"));
  await mkdir(join(root, ".ai", "runs", "2026-07-18"), { recursive: true });
  return root;
}
