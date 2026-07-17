import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonDailyImprovementStore } from "../src/infra/json-daily-improvement-store.js";

test("claims the first repository improvement and blocks another active improvement on the same UTC day", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-day-"));
  const repository = join(sandbox, "repository");
  await mkdir(repository);
  const store = new JsonDailyImprovementStore(join(sandbox, "state"));

  const first = await store.claim(repository, "2026-07-17", "2026-07-17T00:05:00.000Z");
  const repeated = await store.claim(repository, "2026-07-17", "2026-07-17T23:55:00.000Z");

  assert.equal(first.outcome, "claimed");
  assert.equal(repeated.outcome, "blocked-active");
  assert.equal(repeated.repositoryId, first.repositoryId);
  assert.equal(repeated.claimId, first.claimId);
});

test("blocks a completed repository improvement for the rest of its UTC day", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-completed-"));
  const repository = join(sandbox, "repository");
  await mkdir(repository);
  const store = new JsonDailyImprovementStore(join(sandbox, "state"));
  const first = await store.claim(repository, "2026-07-17", "2026-07-17T00:05:00.000Z");

  const completed = await store.complete(first, "2026-07-17T01:00:00.000Z");
  const repeated = await store.claim(repository, "2026-07-17", "2026-07-17T02:00:00.000Z");

  assert.equal(completed.outcome, "completed");
  assert.equal(repeated.outcome, "blocked-completed");
  await assert.rejects(
    store.complete(first, "2026-07-17T03:00:00.000Z"),
    /claim is no longer active/,
  );
});

test("allows a new claim across the UTC date boundary", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-boundary-"));
  const repository = join(sandbox, "repository");
  await mkdir(repository);
  const store = new JsonDailyImprovementStore(join(sandbox, "state"));

  const beforeMidnight = await store.claim(repository, "2026-07-17", "2026-07-17T23:59:59.999Z");
  const afterMidnight = await store.claim(repository, "2026-07-18", "2026-07-18T00:00:00.000Z");

  assert.equal(beforeMidnight.outcome, "claimed");
  assert.equal(afterMidnight.outcome, "claimed");
  assert.notEqual(afterMidnight.claimId, beforeMidnight.claimId);
});

test("isolates daily claims by canonical repository identity", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-repositories-"));
  const firstRepository = join(sandbox, "first");
  const secondRepository = join(sandbox, "second");
  await mkdir(firstRepository);
  await mkdir(secondRepository);
  const store = new JsonDailyImprovementStore(join(sandbox, "state"));

  const first = await store.claim(firstRepository, "2026-07-17", "2026-07-17T05:00:00.000Z");
  const second = await store.claim(secondRepository, "2026-07-17", "2026-07-17T05:00:00.000Z");

  assert.equal(first.outcome, "claimed");
  assert.equal(second.outcome, "claimed");
  assert.notEqual(first.repositoryId, second.repositoryId);
});
