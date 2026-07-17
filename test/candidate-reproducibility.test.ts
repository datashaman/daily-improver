import assert from "node:assert/strict";
import test from "node:test";
import { rejectCandidatesWithoutReproducibleEvidence } from "../src/core/candidate-reproducibility.js";
import { rankCandidates } from "../src/core/ranking.js";
import { reproducibleEvidence } from "../src/domain/candidate-reproducibility.js";
import type { ImprovementCandidate } from "../src/domain/model.js";

const base: ImprovementCandidate = {
  id: "base",
  kind: "maintainability",
  title: "Base",
  rationale: "Base rationale",
  confidence: 0.8,
  impact: 0.7,
  effort: 0.3,
  risk: 0.2,
  evidence: ["tool finding at src/Service.ts:10"],
  suggestedFiles: ["src/Service.ts"],
  reproducibility: reproducibleEvidence(0.9, ["versioned executed collector"]),
};

test("accepts a candidate with reproducible evidence and bounded provenance", () => {
  assert.deepEqual(rejectCandidatesWithoutReproducibleEvidence([base]), [base]);
});

test("rejects absent, non-reproducible, and unbounded candidate evidence", () => {
  const absentEvidence = { ...base, id: "absent-evidence", evidence: [] };
  const { reproducibility, ...candidateWithoutReproducibility } = base;
  assert.ok(reproducibility);
  const absentContract = { ...candidateWithoutReproducibility, id: "absent-contract" };
  const nonReproducible = {
    ...base,
    id: "non-reproducible",
    reproducibility: { ...reproducibleEvidence(0.9, ["collector"]), reproducible: false },
  };
  const absentProvenance = {
    ...base,
    id: "absent-provenance",
    reproducibility: reproducibleEvidence(0.9, []),
  };
  const unboundedProvenance = {
    ...base,
    id: "unbounded-provenance",
    reproducibility: reproducibleEvidence(0.9, ["x".repeat(513)]),
  };

  assert.deepEqual(rejectCandidatesWithoutReproducibleEvidence([
    absentEvidence,
    absentContract,
    nonReproducible,
    absentProvenance,
    unboundedProvenance,
  ]), []);
  assert.deepEqual(rankCandidates([absentEvidence]), []);
});

test("ranks mixed candidate sets deterministically after rejecting weak evidence", () => {
  const accepted = { ...base, id: "accepted" };
  const higherScoreWithoutEvidence = {
    ...base,
    id: "rejected",
    impact: 1,
    confidence: 1,
    evidence: [],
  };

  assert.deepEqual(rankCandidates([higherScoreWithoutEvidence, accepted]).map((candidate) => candidate.id), ["accepted"]);
  assert.deepEqual(rankCandidates([accepted, higherScoreWithoutEvidence]).map((candidate) => candidate.id), ["accepted"]);
});
