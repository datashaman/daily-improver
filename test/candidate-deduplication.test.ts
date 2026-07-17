import assert from "node:assert/strict";
import test from "node:test";
import { deduplicateCandidates } from "../src/core/candidate-deduplication.js";
import type { ImprovementCandidate } from "../src/domain/model.js";

const base: ImprovementCandidate = {
  id: "base",
  kind: "maintainability",
  title: "Base candidate",
  rationale: "Base explanation",
  confidence: 0.8,
  impact: 0.7,
  effort: 0.3,
  risk: 0.2,
  evidence: ["base evidence"],
  suggestedFiles: ["src/Service.ts"],
  target: "src/Service.ts",
};

function identity(defect: string, reproducibility: number, provenance: string) {
  return {
    schemaVersion: "candidate-deduplication/v1" as const,
    subsystem: "src/Service.ts",
    defect,
    reproducibility,
    provenance: [provenance],
  };
}

test("keeps the strongest reproducible candidate for overlapping evidence", () => {
  const prepared = {
    ...base,
    id: "prepared",
    title: "Prepared title",
    rationale: "Prepared explanation",
    evidence: ["prepared report"],
    deduplication: identity("coverage-gap", 0.7, "prepared collector"),
  };
  const executed = {
    ...base,
    id: "executed",
    title: "Executed title",
    rationale: "Executed explanation",
    evidence: ["executed command and artifact hash"],
    deduplication: identity("coverage-gap", 0.99, "executed collector"),
  };

  assert.deepEqual(deduplicateCandidates([prepared, executed]), [executed]);
});

test("does not collapse materially different defects in the same subsystem", () => {
  const coverage = { ...base, id: "coverage", deduplication: identity("coverage-gap", 0.9, "coverage") };
  const deprecated = { ...base, id: "deprecated", deduplication: identity("deprecated-api", 0.9, "deprecation") };

  assert.deepEqual(deduplicateCandidates([deprecated, coverage]).map((candidate) => candidate.id), ["coverage", "deprecated"]);
});

test("uses deterministic tie-breaking and stable ordering", () => {
  const zeta = { ...base, id: "zeta", deduplication: identity("same-defect", 0.9, "zeta") };
  const alpha = { ...base, id: "alpha", deduplication: identity("same-defect", 0.9, "alpha") };
  const independent = { ...base, id: "independent", target: "src/Other.ts" };

  const forward = deduplicateCandidates([zeta, independent, alpha]);
  const reverse = deduplicateCandidates([alpha, independent, zeta]);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.map((candidate) => candidate.id), ["alpha", "independent"]);
  assert.deepEqual(forward[0]?.deduplication?.provenance, ["alpha"]);
});

test("resolves duplicate candidate ids independently of collector order", () => {
  const first = { ...base, rationale: "First explanation", evidence: ["first evidence"] };
  const second = { ...base, rationale: "Second explanation", evidence: ["second evidence"] };

  assert.deepEqual(deduplicateCandidates([first, second]), deduplicateCandidates([second, first]));
});
