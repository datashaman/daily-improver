import assert from "node:assert/strict";
import test from "node:test";
import {
  assertImprovementIntent,
  classifyImprovementIntent,
  type ImprovementIntent,
} from "../src/domain/improvement-intent.js";
import { candidateKinds, type CandidateKind, type RankedCandidate, type RepositoryProfile } from "../src/domain/model.js";
import { createSpec } from "../src/core/specification.js";
import { proveBaseline } from "../src/core/local-runner.js";

const expected = {
  "test-protection": ["refactor", "refactor-characterization"],
  "static-analysis": ["defect", "defect-regression"],
  "mutation-testing": ["defect", "defect-regression"],
  "property-testing": ["defect", "defect-regression"],
  "dependency-vulnerability": ["defect", "defect-regression"],
  performance: ["performance", "performance-measurement"],
  maintainability: ["maintainability", "maintainability-quality"],
  documentation: ["maintainability", "maintainability-quality"],
} as const satisfies Readonly<Record<CandidateKind, readonly [ImprovementIntent, string]>>;

const profile: RepositoryProfile = {
  root: "/repository",
  adapter: "fixture",
  language: "fixture",
  frameworks: [],
  signals: [],
  capabilities: new Map(),
};

test("derives one exhaustive versioned improvement intent before specification", () => {
  assert.deepEqual(Object.keys(expected).sort(), [...candidateKinds].sort());
  for (const kind of candidateKinds) {
    const contract = classifyImprovementIntent(kind);
    assert.equal(contract.schemaVersion, "improvement-intent/v1");
    assert.equal(contract.intent, expected[kind][0]);
    assert.equal(contract.baselineProof, expected[kind][1]);
    assert.deepEqual(createSpec(candidate(kind), profile, limits).improvementIntent, contract);
  }
  assert.deepEqual(
    createSpec({ ...candidate("test-protection"), improvementIntent: "defect" }, profile, limits).improvementIntent,
    { schemaVersion: "improvement-intent/v1", intent: "defect", baselineProof: "defect-regression" },
  );
  assert.throws(
    () => createSpec({ ...candidate("maintainability"), improvementIntent: "feature" } as unknown as RankedCandidate, profile, limits),
    /Unsupported declared improvement intent/,
  );
});

test("selects defect, refactor, performance, and maintainability baseline proof semantics", () => {
  assert.deepEqual(proveBaseline(classifyImprovementIntent("static-analysis"), 1, "test-assertion"), {
    expected: "fail",
    outcome: "failed-as-expected",
    classification: "test-assertion",
  });
  assert.deepEqual(proveBaseline(classifyImprovementIntent("test-protection"), 0, "unclassified"), {
    expected: "pass",
    outcome: "passed-as-expected",
  });
  assert.deepEqual(proveBaseline(classifyImprovementIntent("performance"), 0, "unclassified"), {
    expected: "pass",
    outcome: "passed-as-expected",
  });
  assert.deepEqual(proveBaseline(classifyImprovementIntent("maintainability"), 0, "unclassified"), {
    expected: "pass",
    outcome: "passed-as-expected",
  });
});

test("rejects missing, malformed, unsupported, extended, and inconsistent intent contracts", () => {
  assert.throws(() => assertImprovementIntent(undefined), /exact improvement-intent\/v1 schema/);
  assert.throws(() => assertImprovementIntent({ schemaVersion: "improvement-intent/v2", intent: "defect", baselineProof: "defect-regression" }), /schema improvement-intent\/v1/);
  assert.throws(() => assertImprovementIntent({ schemaVersion: "improvement-intent/v1", intent: "feature", baselineProof: "defect-regression" }), /unsupported/);
  assert.throws(() => assertImprovementIntent({ schemaVersion: "improvement-intent/v1", intent: "defect", baselineProof: "unknown" }), /unsupported/);
  assert.throws(() => assertImprovementIntent({ schemaVersion: "improvement-intent/v1", intent: "defect", baselineProof: "defect-regression", extra: true }), /exact/);
  assert.throws(() => assertImprovementIntent({ schemaVersion: "improvement-intent/v1", intent: "refactor", baselineProof: "defect-regression" }), /inconsistent/);
});

test("fails closed when the baseline outcome contradicts the selected intent", () => {
  assert.throws(() => proveBaseline(classifyImprovementIntent("static-analysis"), 0, "unclassified"), /did not fail/);
  assert.throws(() => proveBaseline(classifyImprovementIntent("test-protection"), 1, "test-assertion"), /must pass before and after/);
  assert.throws(() => proveBaseline(classifyImprovementIntent("performance"), 1, "test-assertion"), /must pass before and after/);
  assert.throws(() => proveBaseline(classifyImprovementIntent("maintainability"), 1, "test-assertion"), /must pass before and after/);
  assert.throws(() => proveBaseline(classifyImprovementIntent("static-analysis"), 1, "syntax"), /non-behavioral/);
});

const limits = { maxFiles: 2, maxChangedLines: 80, maxCostUsd: 1 };

function candidate(kind: CandidateKind): RankedCandidate {
  return {
    id: `candidate-${kind}`,
    kind,
    title: `Improve ${kind}`,
    rationale: `Evidence supports bounded ${kind} work.`,
    confidence: 0.8,
    impact: 0.8,
    effort: 0.2,
    risk: 0.2,
    subsystemRisk: 0.2,
    testability: 0.8,
    evidence: ["bounded fixture evidence"],
    suggestedFiles: ["src/Target.fixture"],
    ...(kind === "property-testing" ? {
      target: "src/Target.fixture",
      propertyInvariants: ["The selected target preserves its approved invariant."],
    } : {}),
    estimatedDiffLines: 20,
    score: 0.8,
  };
}
