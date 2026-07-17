import assert from "node:assert/strict";
import test from "node:test";
import { selectCandidatesByScope } from "../src/core/candidate-scope.js";
import { reproducibleEvidence } from "../src/domain/candidate-reproducibility.js";
import type { ImprovementCandidate } from "../src/domain/model.js";

const base: ImprovementCandidate = {
  id: "candidate",
  kind: "maintainability",
  title: "Refactor a large service boundary",
  rationale: "raw source observation that must not cross into a human task",
  confidence: 0.9,
  impact: 0.9,
  effort: 0.2,
  risk: 0.2,
  subsystemRisk: 0.2,
  testability: 0.9,
  estimatedDiffLines: 80,
  evidence: ["raw source evidence"],
  suggestedFiles: ["src/Service.ts"],
  reproducibility: reproducibleEvidence(0.9, ["bounded collector"]),
};

const limits = { maxFiles: 2, maxChangedLines: 250 };

test("emits one versioned human task when the only credible candidate is oversized", () => {
  const selection = selectCandidatesByScope([{ ...base, estimatedDiffLines: 251 }], [], limits);

  assert.deepEqual(selection.candidates, []);
  assert.deepEqual(selection.exclusions, [{
    schemaVersion: "candidate-exclusion/v1",
    candidateReference: "candidate",
    candidateKind: "maintainability",
    reason: "oversized-scope",
  }]);
  assert.deepEqual(selection.humanTaskRecommendation, {
    schemaVersion: "human-task-recommendation/v1",
    candidateId: "candidate",
    candidateKind: "maintainability",
    title: "Refactor a large service boundary",
    reason: "Route this credible candidate to human review because 251 estimated changed lines exceed the 250-line autonomous limit.",
    estimatedScope: { files: 1, changedLines: 251 },
    autonomousLimits: limits,
  });
  const serialized = JSON.stringify(selection.humanTaskRecommendation);
  assert.doesNotMatch(serialized, /raw source|src\/Service/);
});

test("selects the lower-ranked bounded candidate while recommending oversized work", () => {
  const bounded = { ...base, id: "bounded", title: "Bounded fix", impact: 0.4, estimatedDiffLines: 40 };
  const selection = selectCandidatesByScope([
    { ...base, id: "large", suggestedFiles: ["src/One.ts", "src/Two.ts", "src/Three.ts"], estimatedDiffLines: 40 },
    bounded,
  ], [], limits);

  assert.equal(selection.candidates[0]?.id, "bounded");
  assert.equal(selection.humanTaskRecommendation?.candidateId, "large");
  assert.match(selection.humanTaskRecommendation?.reason ?? "", /3 estimated files exceed the 2-file autonomous limit/);
});

test("accepts candidates exactly at repository file and line limits", () => {
  const selection = selectCandidatesByScope([{
    ...base,
    suggestedFiles: ["src/One.ts", "src/Two.ts"],
    estimatedDiffLines: 250,
  }], [], limits);

  assert.equal(selection.candidates[0]?.id, "candidate");
  assert.equal(selection.humanTaskRecommendation, undefined);
  assert.deepEqual(selection.exclusions, []);
});

test("rejects malformed or unbounded scope without emitting a recommendation", () => {
  const selection = selectCandidatesByScope([
    { ...base, id: "unbounded-lines", estimatedDiffLines: 10_001 },
    { ...base, id: "unbounded-files", suggestedFiles: Array.from({ length: 101 }, (_, index) => `src/${index}.ts`) },
    { ...base, id: "malformed-file", suggestedFiles: [""] },
    { ...base, id: "unbounded-title", title: "x".repeat(241) },
  ], [], limits);

  assert.equal(selection.candidates.length, 0);
  assert.equal(selection.humanTaskRecommendation, undefined);
  assert.deepEqual(selection.exclusions.map(({ candidateReference, reason }) => ({ candidateReference, reason })), [
    { candidateReference: "malformed-file", reason: "malformed-scope" },
    { candidateReference: "unbounded-files", reason: "malformed-scope" },
    { candidateReference: "unbounded-lines", reason: "scoring" },
    { candidateReference: "unbounded-title", reason: "malformed-scope" },
  ]);
});

test("emits bounded machine-readable reasons for every pre-selection rejection", () => {
  const { reproducibility, ...candidateWithoutReproducibility } = base;
  assert.ok(reproducibility);
  const identity = {
    schemaVersion: "candidate-deduplication/v1" as const,
    subsystem: "billing",
    defect: "missing-boundary-test",
  };
  const selected = { ...base, id: "selected", deduplication: identity };
  const candidates: readonly ImprovementCandidate[] = [
    { ...candidateWithoutReproducibility, id: "bad-evidence", evidence: ["raw evidence that must not be retained"] },
    { ...base, id: "bad-score", rationale: "raw scoring rationale", impact: Number.NaN },
    { ...base, id: "", title: "Malformed identity" },
    { ...base, id: "duplicate", rationale: "raw duplicate rationale", confidence: 0.2, deduplication: identity },
    { ...base, id: "large", rationale: "raw oversized rationale", estimatedDiffLines: 251 },
    selected,
  ];
  const selection = selectCandidatesByScope(candidates, [], limits);

  assert.equal(selection.candidates[0]?.id, "selected");
  assert.deepEqual(selection.exclusions.slice(0, 4).map(({ candidateReference, reason, retainedCandidateReference }) => ({
    candidateReference,
    reason,
    ...(retainedCandidateReference === undefined ? {} : { retainedCandidateReference }),
  })), [
    { candidateReference: "bad-evidence", reason: "evidence" },
    { candidateReference: "bad-score", reason: "scoring" },
    { candidateReference: "duplicate", reason: "semantic-deduplication", retainedCandidateReference: "selected" },
    { candidateReference: "large", reason: "oversized-scope" },
  ]);
  assert.match(selection.exclusions[4]?.candidateReference ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(selection.exclusions[4]?.reason, "malformed-scope");
  const serialized = JSON.stringify(selection.exclusions);
  assert.doesNotMatch(serialized, /raw evidence|raw scoring|raw duplicate|raw oversized/);
  assert.ok(serialized.length < 2_000);
  assert.deepEqual(selectCandidatesByScope([...candidates].reverse(), [], limits), selection);
});

test("repeated selection is stable across collector ordering", () => {
  const candidates: readonly ImprovementCandidate[] = [
    { ...base, id: "zulu-large", estimatedDiffLines: 300 },
    { ...base, id: "alpha-large", estimatedDiffLines: 300 },
    { ...base, id: "zulu-bounded", impact: 0.4, estimatedDiffLines: 40 },
    { ...base, id: "alpha-bounded", impact: 0.4, estimatedDiffLines: 40 },
  ];
  const expected = selectCandidatesByScope(candidates, [], limits);

  for (let run = 0; run < 5; run += 1) {
    assert.deepEqual(selectCandidatesByScope([...candidates].reverse(), [], limits), expected);
  }
  assert.equal(expected.candidates[0]?.id, "alpha-bounded");
  assert.equal(expected.humanTaskRecommendation?.candidateId, "alpha-large");
});
