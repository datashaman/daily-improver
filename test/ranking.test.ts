import assert from "node:assert/strict";
import test from "node:test";
import { rankCandidates } from "../src/core/ranking.js";
import type { ImprovementCandidate } from "../src/domain/model.js";

const base: ImprovementCandidate = {
  id: "base", kind: "maintainability", title: "Base", rationale: "Base", confidence: 0.5,
  impact: 0.5, effort: 0.5, risk: 0.5, evidence: [], suggestedFiles: [],
};

test("ranking rewards impact and confidence while penalizing effort and risk", () => {
  const ranked = rankCandidates([
    { ...base, id: "safe", confidence: 0.9, impact: 0.9, effort: 0.2, risk: 0.1 },
    { ...base, id: "risky", confidence: 0.6, impact: 0.8, effort: 0.8, risk: 0.9 },
  ]);
  assert.equal(ranked[0]?.id, "safe");
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});
