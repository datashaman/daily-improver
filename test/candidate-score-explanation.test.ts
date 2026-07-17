import assert from "node:assert/strict";
import test from "node:test";
import {
  assertScoreExplanations,
  candidateScoreFactorNames,
  replayScoreExplanation,
  type CandidateScoreExplanation,
} from "../src/domain/candidate-score.js";
import { rankCandidatesWithExclusions } from "../src/core/ranking.js";
import { reproducibleEvidence } from "../src/domain/candidate-reproducibility.js";
import { candidateValueClassificationSchemaVersion } from "../src/domain/candidate-value.js";
import type { ImprovementCandidate } from "../src/domain/model.js";

const base: ImprovementCandidate = {
  id: "base",
  kind: "maintainability",
  title: "Base candidate",
  rationale: "raw rationale must not enter score explanations",
  confidence: 0.8,
  impact: 0.7,
  effort: 0.2,
  risk: 0.3,
  subsystemRisk: 0.4,
  testability: 0.9,
  estimatedDiffLines: 50,
  evidence: ["raw evidence must not enter score explanations"],
  suggestedFiles: ["src/PrivateService.ts"],
  reproducibility: reproducibleEvidence(0.85, ["private collector provenance"]),
};

test("score explanations are bounded, exhaustive, replayable, and ordered with deterministic ties", () => {
  const ranking = rankCandidatesWithExclusions([
    { ...base, id: "zulu" },
    { ...base, id: "alpha" },
  ], ["maintainability"]);

  assert.deepEqual(ranking.candidates.map(({ id }) => id), ["alpha", "zulu"]);
  assert.deepEqual(ranking.explanations.map(({ candidateReference }) => candidateReference), ["alpha", "zulu"]);
  for (const [index, explanation] of ranking.explanations.entries()) {
    assert.deepEqual(Object.keys(explanation.normalizedFactors), candidateScoreFactorNames);
    assert.deepEqual(Object.keys(explanation.categoryWeights), candidateScoreFactorNames);
    assert.equal(replayScoreExplanation(explanation), ranking.candidates[index]?.score);
  }
  assert.doesNotMatch(
    JSON.stringify(ranking.explanations),
    /raw evidence|raw rationale|PrivateService|collector provenance/u,
  );
});

test("score explanations record repository influence and the cosmetic-only cap", () => {
  const cosmetic: ImprovementCandidate = {
    ...base,
    id: "cosmetic",
    kind: "documentation",
    confidence: 1,
    impact: 1,
    effort: 0,
    risk: 0,
    subsystemRisk: 0,
    testability: 1,
    reproducibility: reproducibleEvidence(1, ["visual review"]),
    valueClassification: {
      schemaVersion: candidateValueClassificationSchemaVersion,
      classification: "cosmetic-only",
    },
  };

  const ranking = rankCandidatesWithExclusions([cosmetic], ["documentation"]);
  const explanation = ranking.explanations[0];
  assert.ok(explanation);
  assert.equal(explanation.repositoryPriorityInfluence, 0.05);
  assert.equal(explanation.valueClassificationCap, 0.01);
  assert.equal(explanation.finalRoundedScore, 0.01);
  assert.equal(ranking.candidates[0]?.score, 0.01);
});

test("score explanation validation fails closed for malformed, incomplete, unbounded, or inconsistent records", () => {
  const ranking = rankCandidatesWithExclusions([base]);
  const explanation = ranking.explanations[0];
  assert.ok(explanation);
  const invalid: readonly CandidateScoreExplanation[] = [
    { ...explanation, schemaVersion: "candidate-score-explanation/v0" } as unknown as CandidateScoreExplanation,
    { ...explanation, normalizedFactors: { ...explanation.normalizedFactors, testability: 2 } },
    { ...explanation, categoryWeights: { ...explanation.categoryWeights, impact: 0.99 } },
    { ...explanation, rawWeightedContribution: explanation.rawWeightedContribution + 0.01 },
    { ...explanation, finalRoundedScore: explanation.finalRoundedScore + 0.01 },
    { ...explanation, extra: true } as unknown as CandidateScoreExplanation,
  ];
  for (const item of invalid) assert.throws(() => replayScoreExplanation(item), /score explanation/u);
  assert.throws(
    () => assertScoreExplanations([{ ...ranking.candidates[0]!, score: 0.99 }], ranking.explanations),
    /persisted score/u,
  );
});
