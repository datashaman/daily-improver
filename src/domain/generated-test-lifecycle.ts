import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CommandResult } from "../infra/command-runner.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const noncePattern = /^[a-f0-9]{32}$/u;
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]{1,240}$/u;

export type GeneratedTestStatus = "executed" | "skipped" | "disabled";

export interface GeneratedTestObservation {
  readonly path: string;
  readonly status: GeneratedTestStatus;
  readonly assertionCount: number;
  readonly toleranceSha256: string;
}

export interface GeneratedTestLifecycleReport {
  readonly schemaVersion: "generated-test-lifecycle-report/v1";
  readonly executionNonce: string;
  readonly tests: readonly GeneratedTestObservation[];
}

export interface TestCommandOutcome {
  readonly attempt: number;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly tests: readonly GeneratedTestObservation[];
}

export interface GeneratedTestLifecycleDecision {
  readonly schemaVersion: "generated-test-lifecycle-decision/v1";
  readonly phase: "baseline" | "verification";
  readonly outcome: "accepted";
  readonly command: readonly string[];
  readonly testSha256: Readonly<Record<string, string>>;
  readonly attempts: readonly TestCommandOutcome[];
}

export async function readGeneratedTestLifecycleReport(
  path: string,
  executionNonce: string,
  requiredTestPaths: readonly string[],
): Promise<GeneratedTestLifecycleReport> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Generated test lifecycle report is missing.");
    throw new Error("Generated test lifecycle report is malformed.");
  }
  if (!isRecord(value) || !exactKeys(value, ["executionNonce", "schemaVersion", "tests"]) || value.schemaVersion !== "generated-test-lifecycle-report/v1") {
    throw new Error("Generated test lifecycle report is malformed.");
  }
  if (value.executionNonce !== executionNonce || !noncePattern.test(executionNonce)) {
    throw new Error("Generated test lifecycle report has a stale execution nonce.");
  }
  if (!Array.isArray(value.tests) || value.tests.length < 1 || value.tests.length > 32) {
    throw new Error("Generated test lifecycle report has an invalid test collection.");
  }
  const tests = value.tests.map(parseObservation);
  if (new Set(tests.map((test) => test.path)).size !== tests.length) throw new Error("Generated test lifecycle report repeats a test path.");
  if (requiredTestPaths.length < 1 || requiredTestPaths.length > 32 || new Set(requiredTestPaths).size !== requiredTestPaths.length) {
    throw new Error("Generated test lifecycle expectation is malformed.");
  }
  const observed = [...tests.map((test) => test.path)].sort();
  const required = [...requiredTestPaths].sort();
  if (JSON.stringify(observed) !== JSON.stringify(required)) throw new Error("Generated test lifecycle report does not cover the required generated tests.");
  for (const test of tests) {
    if (test.status !== "executed") throw new Error(`Generated test is ${test.status}: ${test.path}`);
    if (test.assertionCount < 1) throw new Error(`Generated test executed no assertions: ${test.path}`);
  }
  return { schemaVersion: "generated-test-lifecycle-report/v1", executionNonce, tests };
}

export function commandOutcome(attempt: number, result: CommandResult, report: GeneratedTestLifecycleReport): TestCommandOutcome {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) throw new Error("Generated test lifecycle attempt is invalid.");
  return {
    attempt,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    tests: report.tests,
  };
}

export function decideGeneratedTestLifecycle(input: {
  readonly phase: "baseline" | "verification";
  readonly command: readonly string[];
  readonly testSha256: Readonly<Record<string, string>>;
  readonly attempts: readonly TestCommandOutcome[];
  readonly expectedExit: "zero" | "nonzero";
  readonly baseline?: GeneratedTestLifecycleDecision;
}): GeneratedTestLifecycleDecision {
  if (input.attempts.length !== 3 || input.attempts.some((attempt, index) => attempt.attempt !== index + 1)) {
    throw new Error("Generated test lifecycle requires exactly three ordered attempts.");
  }
  const outcomes = input.attempts.map((attempt) => attempt.exitCode === 0);
  if (new Set(outcomes).size !== 1) throw new NewlyFlakyGeneratedTestError(input.phase, "command-outcome-varied");
  const expectedZero = input.expectedExit === "zero";
  if (outcomes[0] !== expectedZero) throw new Error(`Generated test lifecycle ${input.phase} command had the wrong outcome.`);
  const metrics = input.attempts.map((attempt) => JSON.stringify(attempt.tests));
  if (new Set(metrics).size !== 1) throw new NewlyFlakyGeneratedTestError(input.phase, "execution-metrics-varied");
  if (input.phase === "verification") {
    if (!input.baseline) throw new Error("Generated test verification lifecycle requires baseline evidence.");
    if (JSON.stringify(input.testSha256) !== JSON.stringify(input.baseline.testSha256)) throw new Error("Generated tests were deleted or changed after baseline sealing.");
    const baselineTests = input.baseline.attempts[0]?.tests ?? [];
    for (const test of input.attempts[0]?.tests ?? []) {
      const previous = baselineTests.find((candidate) => candidate.path === test.path);
      if (!previous) throw new Error(`Generated test is absent from baseline lifecycle: ${test.path}`);
      if (test.assertionCount < previous.assertionCount || test.toleranceSha256 !== previous.toleranceSha256) {
        throw new Error(`Generated test was observably weakened: ${test.path}`);
      }
    }
  }
  return {
    schemaVersion: "generated-test-lifecycle-decision/v1",
    phase: input.phase,
    outcome: "accepted",
    command: input.command,
    testSha256: input.testSha256,
    attempts: input.attempts,
  };
}

export class NewlyFlakyGeneratedTestError extends Error {
  constructor(readonly phase: "baseline" | "verification", readonly reason: "command-outcome-varied" | "execution-metrics-varied") {
    super(`Generated test is newly flaky during ${phase}: ${reason}.`);
  }
}

function parseObservation(value: unknown): GeneratedTestObservation {
  if (!isRecord(value) || !exactKeys(value, ["assertionCount", "path", "status", "toleranceSha256"])) throw new Error("Generated test lifecycle observation is malformed.");
  if (typeof value.path !== "string" || !pathPattern.test(value.path)) throw new Error("Generated test lifecycle path is malformed.");
  if (value.status !== "executed" && value.status !== "skipped" && value.status !== "disabled") throw new Error("Generated test lifecycle status is unsupported.");
  if (!Number.isInteger(value.assertionCount) || (value.assertionCount as number) < 0 || (value.assertionCount as number) > 1_000_000) throw new Error("Generated test lifecycle assertion count is invalid.");
  if (typeof value.toleranceSha256 !== "string" || !sha256Pattern.test(value.toleranceSha256)) throw new Error("Generated test lifecycle tolerance identity is malformed.");
  return { path: value.path, status: value.status, assertionCount: value.assertionCount as number, toleranceSha256: value.toleranceSha256 };
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
