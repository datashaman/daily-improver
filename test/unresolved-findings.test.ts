import assert from "node:assert/strict";
import test from "node:test";
import { selectCandidatesByScope } from "../src/core/candidate-scope.js";
import { candidateFindingId, excludeUnresolvedFindings } from "../src/core/unresolved-findings.js";
import { reproducibleEvidence } from "../src/domain/candidate-reproducibility.js";
import type { ImprovementCandidate, UnresolvedFindingState } from "../src/domain/model.js";

const limits = { maxFiles: 2, maxChangedLines: 250 };
const candidate = (id: string, impact: number, subsystem: string, defect: string): ImprovementCandidate => ({
  id,
  kind: "static-analysis",
  title: `Resolve ${id}`,
  rationale: `raw rationale for ${id}`,
  confidence: 0.9,
  impact,
  effort: 0.2,
  risk: 0.1,
  subsystemRisk: 0.1,
  testability: 0.9,
  estimatedDiffLines: 20,
  evidence: [`raw evidence at ${subsystem}`],
  suggestedFiles: [subsystem],
  reproducibility: reproducibleEvidence(0.9, ["fixture collector"]),
  deduplication: { schemaVersion: "candidate-deduplication/v1", subsystem, defect },
});

test("excludes a repeated semantic finding and selects the highest-ranked unmatched candidate", () => {
  const repeated = candidate("collector-id-changed", 0.95, "src/SecretService.ts", "missing-boundary-check");
  const lower = candidate("lower-ranked", 0.6, "src/OtherService.ts", "invalid-return-type");
  const state: UnresolvedFindingState = {
    schemaVersion: "unresolved-finding-state/v1",
    repositoryId: "a".repeat(64),
    observedAt: "2026-07-17T05:00:00.000Z",
    findingIds: [candidateFindingId({ ...repeated, id: "previous-collector-id" })],
  };

  const selection = excludeUnresolvedFindings(
    selectCandidatesByScope([lower, repeated], [], limits),
    state,
  );

  assert.equal(selection.candidates[0]?.id, "lower-ranked");
  assert.deepEqual(selection.exclusions, [{
    schemaVersion: "candidate-exclusion/v2",
    candidateReference: "collector-id-changed",
    candidateKind: "static-analysis",
    reason: "unresolved-finding",
    findingId: candidateFindingId(repeated),
  }]);
  assert.doesNotMatch(JSON.stringify(selection.exclusions), /raw evidence|raw rationale|SecretService|missing-boundary-check/u);
});

test("unresolved filtering is deterministic across collector ordering", () => {
  const repeated = candidate("repeated", 0.95, "src/Service.ts", "same-defect");
  const available = candidate("available", 0.7, "src/Available.ts", "other-defect");
  const state: UnresolvedFindingState = {
    schemaVersion: "unresolved-finding-state/v1",
    repositoryId: "b".repeat(64),
    observedAt: "2026-07-17T05:00:00.000Z",
    findingIds: [candidateFindingId(repeated)],
  };
  const select = (candidates: readonly ImprovementCandidate[]) => excludeUnresolvedFindings(
    selectCandidatesByScope(candidates, [], limits),
    state,
  );

  assert.deepEqual(select([repeated, available]), select([available, repeated]));
});
