import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EvidenceResultStatus } from "../src/contracts.js";
import {
  PhpEvidenceCache,
  phpEvidenceCacheSchemaVersion,
  type PhpEvidenceCachePolicy,
} from "../src/infra/php-evidence-cache.js";

const basePolicy: PhpEvidenceCachePolicy = {
  collector: "static-analysis-phpstan",
  policyVersion: "collector-policy/v1",
  evidenceSchemaVersion: "normalized-evidence/v1",
  command: ["vendor/bin/phpstan", "analyse", "--error-format=json"],
  versionCommand: ["vendor/bin/phpstan", "--version"],
  configurationPaths: ["phpstan.neon"],
  sourcePatterns: ["composer.json", "src/**/*.php"],
};

test("reuses normalized successful and code-finding PHP evidence", async () => {
  const root = await repository();
  const cache = cacheFor(() => "1.12.0");
  let collections = 0;
  const collect = async () => {
    collections += 1;
    return evidence("normalized-evidence/v1", "code-finding", collections);
  };

  const first = await cache.collect(root, basePolicy, collect);
  const second = await cache.collect(root, basePolicy, collect);

  assert.equal(collections, 1);
  assert.deepEqual(second, first);
  const artifact = await onlyCacheArtifact(root);
  assert.equal(JSON.parse(await readFile(artifact, "utf8")).schemaVersion, phpEvidenceCacheSchemaVersion);
  assert.doesNotMatch(await readFile(artifact, "utf8"), /raw tool output/i);
});

test("invalidates on every source, command, tool, configuration, schema, and policy input", async () => {
  const root = await repository();
  let toolVersion = "1.12.0";
  const cache = cacheFor(() => toolVersion);
  let collections = 0;
  const run = async (policy: PhpEvidenceCachePolicy = basePolicy) => cache.collect(root, policy, async () => {
    collections += 1;
    return evidence(policy.evidenceSchemaVersion, "success", collections);
  });

  await run();
  await run();
  assert.equal(collections, 1);

  await writeFile(join(root, "src", "Service.php"), "<?php final class Service { public function changed(): void {} }\n");
  await run();
  assert.equal(collections, 2, "source change");

  await run({ ...basePolicy, command: [...basePolicy.command, "--no-progress"] });
  assert.equal(collections, 3, "command change");

  toolVersion = "1.12.1";
  await run({ ...basePolicy, command: [...basePolicy.command, "--no-progress"] });
  assert.equal(collections, 4, "tool-version change");

  await writeFile(join(root, "phpstan.neon"), "parameters:\n  level: 9\n");
  await run({ ...basePolicy, command: [...basePolicy.command, "--no-progress"] });
  assert.equal(collections, 5, "configuration change");

  await run({ ...basePolicy, evidenceSchemaVersion: "normalized-evidence/v2" });
  assert.equal(collections, 6, "schema change");

  await run({ ...basePolicy, policyVersion: "collector-policy/v2" });
  assert.equal(collections, 7, "collector-policy change");
});

test("ignores corrupt and oversized cache artifacts", async () => {
  const root = await repository();
  const cache = cacheFor(() => "1.12.0");
  let collections = 0;
  const collect = async () => evidence("normalized-evidence/v1", "success", ++collections);

  await cache.collect(root, basePolicy, collect);
  const path = await onlyCacheArtifact(root);
  await writeFile(path, "{corrupt");
  await cache.collect(root, basePolicy, collect);
  assert.equal(collections, 2);

  await writeFile(path, JSON.stringify({ padding: "x".repeat(1024) }));
  const tinyCache = new PhpEvidenceCache({
    resolveToolVersion: async () => "1.12.0",
    cacheArtifactLimitBytes: 64,
  });
  await tinyCache.collect(root, basePolicy, collect);
  assert.equal(collections, 3);
});

test("never caches unavailable, configuration, timeout, truncation, or infrastructure outcomes", async () => {
  const statuses: readonly EvidenceResultStatus[] = [
    "unavailable-tool",
    "configuration-failure",
    "missing-packages",
    "missing-coverage-support",
    "timeout",
    "infrastructure-failure",
  ];
  for (const status of statuses) {
    const root = await repository();
    const cache = cacheFor(() => "1.12.0");
    let collections = 0;
    const collect = async () => evidence("normalized-evidence/v1", status, ++collections);
    await cache.collect(root, basePolicy, collect);
    await cache.collect(root, basePolicy, collect);
    assert.equal(collections, 2, status);
  }

  const root = await repository();
  const cache = cacheFor(() => "1.12.0");
  let truncatedCollections = 0;
  const collectTruncated = async () => ({
    ...evidence("normalized-evidence/v1", "success", ++truncatedCollections),
    result: { status: "success" as const, outputTruncated: true },
  });
  await cache.collect(root, basePolicy, collectTruncated);
  await cache.collect(root, basePolicy, collectTruncated);
  assert.equal(truncatedCollections, 2, "truncated success");
});

test("serializes concurrent cache misses and publishes one complete artifact", async () => {
  const root = await repository();
  const firstCache = cacheFor(() => "1.12.0");
  const secondCache = cacheFor(() => "1.12.0");
  let collections = 0;
  const collect = async () => {
    collections += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return evidence("normalized-evidence/v1", "success", collections);
  };

  const [first, second] = await Promise.all([
    firstCache.collect(root, basePolicy, collect),
    secondCache.collect(root, basePolicy, collect),
  ]);

  assert.equal(collections, 1);
  assert.deepEqual(first, second);
  const parsed = JSON.parse(await readFile(await onlyCacheArtifact(root), "utf8"));
  assert.equal(parsed.schemaVersion, phpEvidenceCacheSchemaVersion);
  assert.equal(parsed.payload.sequence, 1);
});

function cacheFor(version: () => string): PhpEvidenceCache {
  return new PhpEvidenceCache({ resolveToolVersion: async () => version() });
}

function evidence(schemaVersion: string, status: EvidenceResultStatus, sequence: number) {
  return { schemaVersion, result: { status }, findings: [], candidates: [], sequence };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-cache-test-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "composer.json"), "{}\n");
  await writeFile(join(root, "phpstan.neon"), "parameters:\n  level: 8\n");
  await writeFile(join(root, "src", "Service.php"), "<?php final class Service {}\n");
  return root;
}

async function onlyCacheArtifact(root: string): Promise<string> {
  const files: string[] = [];
  for await (const path of (await import("node:fs/promises")).glob(".daily-improver/cache/php-evidence/**/*.json", { cwd: root })) {
    files.push(join(root, path));
  }
  assert.equal(files.length, 1);
  return files[0] as string;
}
