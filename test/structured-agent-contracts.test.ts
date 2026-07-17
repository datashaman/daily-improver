import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBuilderRequest,
  parseBuilderResponse,
  parseTestAgentRequest,
  parseTestAgentResponse,
} from "../src/agents/structured-agent-contracts.js";

const task = {
  id: "spec-money-allocation",
  title: "Preserve allocation totals",
  objective: "Ensure integer allocations preserve the requested total.",
  currentBehaviour: "Remainders are discarded.",
  proposedImprovement: "Distribute the remainder deterministically.",
  behavioursToPreserve: ["Reject invalid part counts."],
  acceptanceCriteria: ["Every allocation sums to the requested total."],
  propertyInvariants: ["sum(allocation) equals total"],
  exclusions: ["Public API changes"],
  evidence: ["An escaped mutation removes remainder distribution."],
  limits: { maxFiles: 2, maxChangedLines: 80, maxCostUsd: 1.5 },
} as const;

const repository = { language: "php", frameworks: ["laravel"] } as const;
const commands = [{ purpose: "test", argv: ["php", "tests/run.php"] }] as const;
const usage = {
  provider: "fixture",
  model: "fixture-model",
  inputTokens: 120,
  outputTokens: 80,
  latencyMs: 25,
  estimatedCostUsd: 0,
} as const;

test("accepts bounded versioned test-agent and builder requests", () => {
  const testRequest = parseTestAgentRequest({
    schemaVersion: "test-agent-request/v1",
    stage: "test",
    task,
    repository,
    allowedTestPaths: ["tests/Property/MoneyAllocatorInvariantTest.php"],
    commands,
    conventions: ["Use the repository test harness."],
  });
  const builderRequest = parseBuilderRequest({
    schemaVersion: "builder-request/v1",
    stage: "build",
    task,
    repository,
    allowedFiles: ["app/Domain/MoneyAllocator.php"],
    protectedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php", ".ai/runs/2026-07-17/spec.json"],
    commands,
    conventions: ["Preserve strict types."],
  });

  assert.equal(testRequest.task.id, task.id);
  assert.deepEqual(builderRequest.allowedFiles, ["app/Domain/MoneyAllocator.php"]);
});

test("accepts bounded versioned test-agent and builder responses", () => {
  const testResponse = parseTestAgentResponse({
    schemaVersion: "test-agent-response/v1",
    status: "completed",
    summary: "Added an allocation property test.",
    changedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php"],
    tests: [{
      path: "tests/Property/MoneyAllocatorInvariantTest.php",
      purpose: "Prove totals are preserved across generated inputs.",
      invariants: ["sum(allocation) equals total"],
    }],
    usage,
  });
  const builderResponse = parseBuilderResponse({
    schemaVersion: "builder-response/v1",
    status: "completed",
    summary: "Distributed the allocation remainder.",
    changedFiles: ["app/Domain/MoneyAllocator.php"],
    implementationNotes: ["Kept the public method signature unchanged."],
    usage,
  });

  assert.equal(testResponse.tests[0]?.path, testResponse.changedFiles[0]);
  assert.equal(builderResponse.usage.outputTokens, 80);
});

test("rejects malformed schemas, unbounded collections, paths, commands, strings, and usage", () => {
  const validTestRequest = {
    schemaVersion: "test-agent-request/v1",
    stage: "test",
    task,
    repository,
    allowedTestPaths: ["tests/Property/MoneyAllocatorInvariantTest.php"],
    commands,
    conventions: [],
  };
  const validBuilderResponse = {
    schemaVersion: "builder-response/v1",
    status: "completed",
    summary: "Implemented the bounded fix.",
    changedFiles: ["app/Domain/MoneyAllocator.php"],
    implementationNotes: [],
    usage,
  };

  assert.throws(() => parseTestAgentRequest({ ...validTestRequest, schemaVersion: "test-agent-request/v2" }), /schemaVersion/);
  assert.throws(() => parseTestAgentRequest({ ...validTestRequest, allowedTestPaths: ["../secrets"] }), /relative POSIX path|traversal/);
  assert.throws(() => parseTestAgentRequest({ ...validTestRequest, commands: [{ purpose: "test", argv: [] }] }), /between 1 and 32/);
  assert.throws(() => parseTestAgentRequest({ ...validTestRequest, conventions: Array.from({ length: 65 }, () => "rule") }), /at most 64/);
  assert.throws(() => parseTestAgentRequest({ ...validTestRequest, task: { ...task, objective: "x".repeat(4_097) } }), /at most 4096/);
  assert.throws(() => parseBuilderResponse({ ...validBuilderResponse, usage: { ...usage, outputTokens: -1 } }), /outputTokens/);
  assert.throws(() => parseBuilderResponse({ ...validBuilderResponse, usage: { ...usage, latencyMs: Number.NaN } }), /latencyMs/);
  assert.throws(() => parseBuilderResponse({ ...validBuilderResponse, unexpected: true }), /contain exactly/);
});

test("rejects incomplete test-agent and builder responses", () => {
  assert.throws(() => parseTestAgentResponse({ schemaVersion: "test-agent-response/v1", status: "completed" }), /contain exactly/);
  assert.throws(() => parseBuilderRequest({
    schemaVersion: "builder-request/v1",
    stage: "build",
    task,
    repository,
    allowedFiles: [],
    protectedFiles: ["tests/Property/MoneyAllocatorInvariantTest.php"],
    commands,
    conventions: [],
  }), /builder allowedFiles/);
});
