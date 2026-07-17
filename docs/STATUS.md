# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: language-neutral category-specific candidate scoring.
- Current checkpoint commit: `feat: add category-specific scoring weights`.
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1B — Deterministic candidate selection.
- Current state: Phase 1A is complete. The Composer validation/audit, static-analysis, coverage, mutation-analysis, complexity-analysis, duplicate-code analysis, deprecation-analysis, performance-analysis, validation/error-handling analysis, shared provenance, evidence-cache, candidate-deduplication, reproducible-evidence, and category-specific scoring slices are implemented and verified.

## Exact next task

Score candidate evidence strength and testability alongside the existing bounded factors.

## Acceptance criteria for the next task

- Include reproducibility strength, estimated diff, subsystem risk, and testability alongside confidence, impact, effort, and risk.
- Keep every factor bounded, language-neutral, and deterministic, with fail-closed handling for invalid inputs.
- Preserve category-specific weighting and stable ID tie-breaking.
- Add deterministic unit tests isolating each new factor and its intended scoring direction.
- The end-to-end MoneyAllocator proving loop remains green.
- `npm run checkpoint` passes.

## Current verified behavior

- The CLI detects PHP and Laravel repositories.
- The observer runs and normalizes Composer, PHPStan/Psalm, PHPUnit/Pest Clover and JUnit timing, Infection, PhpMetrics, PHPCPD, PHPCompatibility, explicit Laravel deprecation rules, versioned Laravel validation/error-handling rules, and opt-in Laravel listener query timing, with bounded version/configuration provenance, deterministic normalized-evidence caching for the established expensive collectors, and prepared-artifact fallbacks where applicable.
- Candidate selection rejects absent, non-reproducible, malformed, or unbounded evidence before deduplication, applies exhaustive language-neutral category weights, and then chooses one bounded improvement or fails closed.
- The local runner creates an isolated daily worktree and branch.
- A correctness regression/property test must fail against baseline behavior.
- Builder changes are checked against sealed test/spec artifacts.
- Verification enforces commands, allowlists, diff limits, protected paths, and semantic source checks.
- A successful run creates a verified commit and draft-PR request artifact.

## Known placeholders

- Composer validation/audit, PHPStan/Psalm, PHPUnit/Pest coverage and timing, Infection, PhpMetrics, PHPCPD, PHPCompatibility, Laravel deprecation and validation/error-handling rules, and configured Laravel query timing are automatically executed or applied when detected or applicable; some remaining PHP evidence types still depend on prepared artifacts.
- The agent provider delegates to configured commands rather than a first-class model API.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17 for the category-specific-scoring slice:

- Focused ranking, reproducibility, deduplication, PHP adapter, and MoneyAllocator tests: 23 tests passed.
- `npm test`: 108 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- `npm run checkpoint` passed after the slice commit.
- Docker image build not required; CLI runtime and production dependencies are unchanged.
- End-to-end defect → failing property test → bounded fix → independent verification → daily branch flow passed.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint is safe to clear after the category-specific-scoring slice is committed, the working tree is clean, and the post-commit checkpoint passes.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
