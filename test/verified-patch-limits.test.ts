import assert from "node:assert/strict";
import test from "node:test";
import { inspectVerifiedPatchLimits, prepareVerifiedPatchLimitPlan, requireVerifiedPatchWithinLimits } from "../src/core/verified-patch-limits.js";
import { assertVerifiedPatchLimitPlan, assertVerifiedPatchLimitResult } from "../src/domain/verified-patch-limits.js";
import type { CommandRunner } from "../src/infra/command-runner.js";

const base = "a".repeat(40);

test("enforces exact sealed file and line limits over authenticated numstat evidence", async () => {
  const plan = prepareVerifiedPatchLimitPlan({ maxChangedFiles: 2, maxDiffLines: 5 });
  const below = await inspect("1\t1\tsrc/one.ts\0", plan);
  assert.deepEqual(
    { files: below.changedFileCount, added: below.addedLineCount, deleted: below.deletedLineCount, lines: below.changedLineCount, outcome: below.outcome },
    { files: 1, added: 1, deleted: 1, lines: 2, outcome: "accepted" },
  );
  const at = await inspect(records("2\t1\tsrc/one.ts", "1\t1\tsrc/two.ts"), plan);
  assert.equal(at.changedFileCount, 2);
  assert.equal(at.changedLineCount, 5);
  assert.equal(at.outcome, "accepted");
  assert.doesNotMatch(JSON.stringify(at), /src\/one|src\/two/);

  const rename = await inspect(records("0\t1\tsrc/old.ts", "1\t0\tsrc/new.ts"), plan);
  assert.equal(rename.changedFileCount, 2);
  assert.equal(rename.changedLineCount, 2);
  const aboveFiles = await inspect(records("1\t0\ta.ts", "1\t0\tb.ts", "1\t0\tc.ts"), plan);
  assert.equal(aboveFiles.outcome, "rejected-file-limit");
  assert.throws(() => requireVerifiedPatchWithinLimits(aboveFiles), /sealed repository file limits/);
  const aboveLines = await inspect("3\t3\ta.ts\0", plan);
  assert.equal(aboveLines.outcome, "rejected-line-limit");
  assert.throws(() => requireVerifiedPatchWithinLimits(aboveLines), /sealed repository line limits/);
  const aboveBoth = await inspect(records("2\t1\ta.ts", "2\t1\tb.ts", "1\t0\tc.ts"), plan);
  assert.equal(aboveBoth.outcome, "rejected-both-limits");
  assert.throws(() => requireVerifiedPatchWithinLimits(aboveBoth), /sealed repository file and line limits/);

  const ignoredRunnerArtifact = await inspect(records("9\t9\t.ai/runs/2026-07-19/report.json", "1\t0\tsrc/one.ts"), plan);
  assert.equal(ignoredRunnerArtifact.changedFileCount, 1);
  assert.equal(ignoredRunnerArtifact.changedLineCount, 1);

  assert.throws(() => assertVerifiedPatchLimitPlan(undefined), /malformed/);
  assert.throws(() => assertVerifiedPatchLimitPlan({ ...plan, extra: true }), /extended/);
  assert.throws(() => assertVerifiedPatchLimitPlan({ ...plan, maxChangedFiles: 0 }), /limit/);
  assert.throws(() => assertVerifiedPatchLimitResult({ ...at, maxDiffLines: 6 }, plan), /exact plan/);
  assert.throws(() => assertVerifiedPatchLimitResult({ ...at, changedLineCount: 4 }, plan), /inconsistent/);
  assert.throws(() => assertVerifiedPatchLimitResult({ ...at, outcome: "rejected-file-limit" }, plan), /outcome/);
  assert.throws(() => assertVerifiedPatchLimitResult({ ...at, extra: "builder-passing-result" }, plan), /extended/);

  for (const output of [
    "-\t-\tsrc/image.png\0",
    "1\t0\t../escape.ts\0",
    "1\t0\t/absolute.ts\0",
    "1\t0\tsrc\\windows.ts\0",
    records("1\t0\tsrc/duplicate.ts", "1\t0\tsrc/duplicate.ts"),
    "1\t0\tsrc/not-terminated.ts",
    "1\t0\tsrc/./malformed.ts\0",
  ]) {
    await assert.rejects(inspect(output, plan), /binary|escaped|duplicate|terminated|malformed/);
  }
  await assert.rejects(inspect("", plan, { exitCode: 1, stderr: "adversarial passing result" }), /unavailable/);
});

async function inspect(
  stdout: string,
  plan: Parameters<typeof inspectVerifiedPatchLimits>[2],
  overrides: { readonly exitCode?: number; readonly stderr?: string } = {},
) {
  const fakeRunner = {
    async run(command: readonly string[]) {
      assert.deepEqual(command, [
        "git", "diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--",
      ]);
      return {
        command,
        exitCode: overrides.exitCode ?? 0,
        stdout,
        stderr: overrides.stderr ?? "",
        durationMs: 1,
      };
    },
  } satisfies Pick<CommandRunner, "run">;
  return await inspectVerifiedPatchLimits("/trusted/verifier", base, plan, fakeRunner);
}

function records(...values: readonly string[]): string {
  return `${values.join("\0")}\0`;
}
