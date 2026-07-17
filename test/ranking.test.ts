import assert from "node:assert/strict";
import test from "node:test";
import { rankCandidates } from "../src/core/ranking.js";
import type { CandidateKind, ImprovementCandidate } from "../src/domain/model.js";
import { reproducibleEvidence } from "../src/domain/candidate-reproducibility.js";

const base: ImprovementCandidate = {
  id: "base", kind: "maintainability", title: "Base", rationale: "Base", confidence: 0.5,
  impact: 0.5, effort: 0.5, risk: 0.5, evidence: ["bounded evidence"], suggestedFiles: [],
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
  })));

  assert.deepEqual(
    ranked.map(({ id, score }) => [id, score]),
    [
      ["dependency-vulnerability", 0.41],
      ["test-protection", 0.36],
      ["performance", 0.34],
      ["property-testing", 0.31],
      ["maintainability", 0.29],
      ["static-analysis", 0.29],
      ["documentation", 0.24],
      ["mutation-testing", 0.24],
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

  assert.deepEqual(ranked.map((candidate) => candidate.id), ["other", "strong"]);
});
