import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonOpenPullRequestStateSource } from "../src/infra/json-open-pull-request-state-source.js";

const decidedAt = "2026-07-17T05:00:00.000Z";

test("accepts fresh bounded open pull request state below the repository limit", async () => {
  const fixture = await repositoryFixture();
  await writeState(fixture.path, fixture.repositoryId, { openPullRequests: 2 });

  const state = await new JsonOpenPullRequestStateSource(fixture.path, fixture.repositoryScope).current(decidedAt);

  assert.equal(state.openPullRequests, 2);
  assert.equal(state.repositoryId, fixture.repositoryId);
});

test("fails closed on missing, malformed, stale, negative, fractional, and unbounded state", async () => {
  const cases: readonly [string, unknown][] = [
    ["missing", undefined],
    ["malformed", { schemaVersion: "open-pull-request-state/v1" }],
    ["stale", stateValue("a".repeat(64), 0, "2026-07-17T04:44:59.999Z")],
    ["negative", stateValue("a".repeat(64), -1)],
    ["fractional", stateValue("a".repeat(64), 1.5)],
    ["unbounded", stateValue("a".repeat(64), 10_001)],
  ];
  for (const [name, value] of cases) {
    const fixture = await repositoryFixture();
    const source = name === "missing"
      ? new JsonOpenPullRequestStateSource(join(fixture.sandbox, "missing.json"), fixture.repositoryScope)
      : new JsonOpenPullRequestStateSource(fixture.path, fixture.repositoryScope);
    if (value !== undefined) {
      const bound = typeof value === "object" && value !== null
        ? { ...(value as Record<string, unknown>), repositoryId: fixture.repositoryId }
        : value;
      await writeFile(fixture.path, `${JSON.stringify(bound)}\n`, "utf8");
    }
    await assert.rejects(source.current(decidedAt), /missing|malformed|unbounded|stale/iu, name);
  }
});

test("rejects state issued for a different trusted repository scope", async () => {
  const first = await repositoryFixture();
  const second = await repositoryFixture();
  await writeState(first.path, second.repositoryId, { openPullRequests: 0 });

  await assert.rejects(
    new JsonOpenPullRequestStateSource(first.path, first.repositoryScope).current(decidedAt),
    /different repository/,
  );
});

async function repositoryFixture() {
  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-open-pr-state-"));
  const path = join(sandbox, "open-pr-state.json");
  const repositoryScope = `fixture:${sandbox}`;
  const repositoryId = createHash("sha256").update(repositoryScope).digest("hex");
  return { sandbox, repositoryScope, repositoryId, path };
}

async function writeState(
  path: string,
  repositoryId: string,
  overrides: { readonly openPullRequests: number },
): Promise<void> {
  await writeFile(path, `${JSON.stringify(stateValue(repositoryId, overrides.openPullRequests))}\n`, "utf8");
}

function stateValue(repositoryId: string, openPullRequests: number, observedAt = decidedAt): Record<string, unknown> {
  return {
    schemaVersion: "open-pull-request-state/v1",
    repositoryId,
    observedAt,
    openPullRequests,
  };
}
