import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonUnresolvedFindingStateSource } from "../src/infra/json-unresolved-finding-state-source.js";

const decidedAt = "2026-07-17T05:00:00.000Z";

test("accepts fresh bounded repository-scoped unresolved finding state", async () => {
  const fixture = await repositoryFixture();
  const findingIds = ["1".repeat(64), "2".repeat(64)];
  await writeState(fixture.path, stateValue(fixture.repositoryId, findingIds));

  const state = await new JsonUnresolvedFindingStateSource(fixture.path, fixture.repositoryScope).current(decidedAt);

  assert.deepEqual(state.findingIds, findingIds);
  assert.equal(state.repositoryId, fixture.repositoryId);
});

test("fails closed on missing, malformed, stale, duplicate, and unbounded unresolved state", async () => {
  const cases: readonly [string, Record<string, unknown> | undefined][] = [
    ["missing", undefined],
    ["malformed", { schemaVersion: "unresolved-finding-state/v1" }],
    ["stale", stateValue("a".repeat(64), [], "2026-07-17T04:44:59.999Z")],
    ["duplicate", stateValue("a".repeat(64), ["1".repeat(64), "1".repeat(64)])],
    ["unbounded", stateValue("a".repeat(64), Array.from({ length: 1_001 }, (_, index) => index.toString(16).padStart(64, "0")))],
  ];
  for (const [name, value] of cases) {
    const fixture = await repositoryFixture();
    const source = name === "missing"
      ? new JsonUnresolvedFindingStateSource(join(fixture.sandbox, "missing.json"), fixture.repositoryScope)
      : new JsonUnresolvedFindingStateSource(fixture.path, fixture.repositoryScope);
    if (value !== undefined) await writeState(fixture.path, { ...value, repositoryId: fixture.repositoryId });
    await assert.rejects(source.current(decidedAt), /missing|malformed|unbounded|stale/iu, name);
  }
});

test("rejects unresolved finding state issued for a different repository", async () => {
  const first = await repositoryFixture();
  const second = await repositoryFixture();
  await writeState(first.path, stateValue(second.repositoryId, []));

  await assert.rejects(
    new JsonUnresolvedFindingStateSource(first.path, first.repositoryScope).current(decidedAt),
    /different repository/u,
  );
});

async function repositoryFixture() {
  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-unresolved-state-"));
  const path = join(sandbox, "unresolved-state.json");
  const repositoryScope = `fixture:${sandbox}`;
  const repositoryId = createHash("sha256").update(repositoryScope).digest("hex");
  return { sandbox, repositoryScope, repositoryId, path };
}

async function writeState(path: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function stateValue(repositoryId: string, findingIds: readonly string[], observedAt = decidedAt): Record<string, unknown> {
  return { schemaVersion: "unresolved-finding-state/v1", repositoryId, observedAt, findingIds };
}
