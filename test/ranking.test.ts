import assert from "node:assert/strict";
import test from "node:test";
import { rankCandidates } from "../src/core/ranking.js";
import type { CandidateKind, ImprovementCandidate } from "../src/domain/model.js";
import { reproducibleEvidence } from "../src/domain/candidate-reproducibility.js";
import { candidateValueClassificationSchemaVersion } from "../src/domain/candidate-value.js";

const base: ImprovementCandidate = {
  id: "base", kind: "maintainability", title: "Base", rationale: "Base", confidence: 0.5,
  impact: 0.5, effort: 0.5, risk: 0.5, subsystemRisk: 0.5, testability: 0.5,
  estimatedDiffLines: 80, evidence: ["bounded evidence"], suggestedFiles: [],
  reproducibility: reproducibleEvidence(0.8, ["test collector"]),
};

test("ranking rewards impact and confidence while penalizing effort and risk", () => {
  const ranked = rankCandidates([
    { ...base, id: "safe", confidence: 0.9, impact: 0.9, effort: 0.2, risk: 0.1 },
    { ...base, id: "risky", confidence: 0.6, impact: 0.8, effort: 0.8, risk: 0.9 },
  ]);
  assert.equal(ranked[0]?.id, "safe");
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test("ranking rewards evidence strength, smaller diffs, lower subsystem risk, and testability", () => {
  const score = (candidate: ImprovementCandidate): number => rankCandidates([candidate])[0]?.score ?? Number.NaN;

  assert.ok(score({ ...base, reproducibility: reproducibleEvidence(0.9, ["collector"]) })
    > score({ ...base, reproducibility: reproducibleEvidence(0.2, ["collector"]) }));
  assert.ok(score({ ...base, estimatedDiffLines: 20 }) > score({ ...base, estimatedDiffLines: 200 }));
  assert.ok(score({ ...base, subsystemRisk: 0.2 }) > score({ ...base, subsystemRisk: 0.8 }));
  assert.ok(score({ ...base, testability: 0.8 }) > score({ ...base, testability: 0.2 }));
});

test("ranking caps explicitly cosmetic-only changes near zero", () => {
  const cosmetic: ImprovementCandidate = {
    ...base,
    id: "cosmetic",
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
  const substantive: ImprovementCandidate = {
    ...base,
    id: "substantive",
    impact: 0.2,
    valueClassification: {
      schemaVersion: candidateValueClassificationSchemaVersion,
      classification: "substantive",
    },
  };

  const ranked = rankCandidates([cosmetic, substantive]);

  assert.equal(ranked.find(({ id }) => id === "cosmetic")?.score, 0.01);
  assert.equal(ranked[0]?.id, "substantive");
});

test("ranking fails closed for missing, non-finite, or unbounded scoring factors", () => {
  const missingTestability = { ...base, testability: undefined } as unknown as ImprovementCandidate;

  assert.deepEqual(rankCandidates([
    missingTestability,
    { ...base, id: "invalid-confidence", confidence: Number.NaN },
    { ...base, id: "invalid-impact", impact: 1.01 },
    { ...base, id: "invalid-effort", effort: -0.01 },
    { ...base, id: "invalid-risk", risk: Number.POSITIVE_INFINITY },
    { ...base, id: "invalid-subsystem-risk", subsystemRisk: 1.01 },
    { ...base, id: "invalid-testability", testability: -0.01 },
    { ...base, id: "invalid-diff", estimatedDiffLines: 251 },
    { ...base, id: "fractional-diff", estimatedDiffLines: 1.5 },
    {
      ...base,
      id: "invalid-value-classification",
      valueClassification: { schemaVersion: "candidate-value-classification/v0", classification: "cosmetic-only" },
    } as unknown as ImprovementCandidate,
    {
      ...base,
      id: "unbounded-value-classification",
      valueClassification: {
        schemaVersion: candidateValueClassificationSchemaVersion,
        classification: "cosmetic-only",
        extra: true,
      },
    } as unknown as ImprovementCandidate,
  ]), []);
});

test("ranking applies deterministic category-specific weights to every candidate kind", () => {
  const kinds = [
    "test-protection",
    "static-analysis",
    "mutation-testing",
    "property-testing",
    "dependency-vulnerability",
    "performance",
    "maintainability",
    "documentation",
  ] as const satisfies readonly CandidateKind[];

  const ranked = rankCandidates(kinds.map((kind) => ({
    ...base,
    id: kind,
    kind,
    impact: 0.9,
    confidence: 0.4,
    effort: 0.6,
    risk: 0.2,
    subsystemRisk: 0.3,
    testability: 0.7,
    estimatedDiffLines: 80,
  })));

  assert.deepEqual(
    ranked.map(({ id, score }) => [id, score]),
    [
      ["dependency-vulnerability", 0.4],
      ["test-protection", 0.39],
      ["performance", 0.36],
      ["property-testing", 0.34],
      ["static-analysis", 0.32],
      ["maintainability", 0.31],
      ["mutation-testing", 0.29],
      ["documentation", 0.28],
    ],
  );
});

test("every category rewards impact and confidence and penalizes effort and risk", () => {
  const kinds: readonly CandidateKind[] = [
    "test-protection",
    "static-analysis",
    "mutation-testing",
    "property-testing",
    "dependency-vulnerability",
    "performance",
    "maintainability",
    "documentation",
  ];

  for (const kind of kinds) {
    const score = (candidate: ImprovementCandidate): number => rankCandidates([candidate])[0]?.score ?? Number.NaN;
    const baseline = { ...base, kind };

    assert.ok(score({ ...baseline, impact: 0.8 }) > score({ ...baseline, impact: 0.2 }), `${kind} rewards impact`);
    assert.ok(score({ ...baseline, confidence: 0.8 }) > score({ ...baseline, confidence: 0.2 }), `${kind} rewards confidence`);
    assert.ok(score({ ...baseline, effort: 0.2 }) > score({ ...baseline, effort: 0.8 }), `${kind} penalizes effort`);
    assert.ok(score({ ...baseline, risk: 0.2 }) > score({ ...baseline, risk: 0.8 }), `${kind} penalizes risk`);
    assert.ok(score({ ...baseline, reproducibility: reproducibleEvidence(0.8, ["collector"]) }) > score({ ...baseline, reproducibility: reproducibleEvidence(0.2, ["collector"]) }), `${kind} rewards evidence strength`);
    assert.ok(score({ ...baseline, estimatedDiffLines: 20 }) > score({ ...baseline, estimatedDiffLines: 200 }), `${kind} penalizes estimated diff`);
    assert.ok(score({ ...baseline, subsystemRisk: 0.2 }) > score({ ...baseline, subsystemRisk: 0.8 }), `${kind} penalizes subsystem risk`);
    assert.ok(score({ ...baseline, testability: 0.8 }) > score({ ...baseline, testability: 0.2 }), `${kind} rewards testability`);
  }
});

test("ranking deduplicates semantic overlaps before scoring", () => {
  const semanticIdentity = {
    schemaVersion: "candidate-deduplication/v1" as const,
    subsystem: "src/Service.ts",
    defect: "coverage-gap",
  };
  const ranked = rankCandidates([
    { ...base, id: "weak", impact: 1, reproducibility: reproducibleEvidence(0.5, ["weak collector"]), deduplication: semanticIdentity },
    { ...base, id: "strong", impact: 0.5, reproducibility: reproducibleEvidence(0.99, ["strong collector"]), deduplication: semanticIdentity },
    { ...base, id: "other" },
  ]);

  assert.deepEqual(ranked.map((candidate) => candidate.id), ["strong", "other"]);
});

test("ranking resolves equal scores by stable candidate id", () => {
  assert.deepEqual(
    rankCandidates([{ ...base, id: "zulu" }, { ...base, id: "alpha" }]).map(({ id }) => id),
    ["alpha", "zulu"],
  );
});
