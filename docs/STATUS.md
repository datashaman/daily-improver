# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: version-aware deprecated PHP and Laravel API evidence.
- Current checkpoint commit: `feat: collect deprecated php apis`.
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1A — Real PHP observer.
- Current state: the Composer validation/audit, static-analysis, coverage, mutation-analysis, complexity-analysis, deprecation-analysis, shared provenance, and evidence-cache slices are implemented and verified.

## Exact next task

Collect slow-test and slow-query evidence directly from bounded trusted inputs.

## Acceptance criteria for the next task

- Define bounded, versioned normalized slow-test and slow-query evidence artifacts.
- Collect machine-readable PHPUnit/Pest timing evidence without executing repository-owned scripts.
- Collect supported Laravel slow-query evidence from an explicit trusted mechanism with bounded configuration and output.
- Preserve repository-relative test/query identity, duration, threshold provenance, and bounded messages without retaining query parameters or sensitive raw SQL.
- Distinguish clean output, code findings, unsupported inputs, unavailable tooling, configuration failures, timeouts, truncation, and infrastructure failures.
- Add deterministic fixtures and unit tests for findings plus every failure class.
- The end-to-end MoneyAllocator proving loop remains green.
- `npm run checkpoint` passes.

## Current verified behavior

- The CLI detects PHP and Laravel repositories.
- The observer runs and normalizes Composer, PHPStan/Psalm, PHPUnit/Pest Clover, Infection, PhpMetrics, PHPCompatibility, and explicit Laravel deprecation-rule evidence, with bounded version/configuration provenance, deterministic normalized-evidence caching for the established expensive collectors, and prepared-artifact fallbacks where applicable.
- Candidate selection chooses one bounded improvement.
- The local runner creates an isolated daily worktree and branch.
- A correctness regression/property test must fail against baseline behavior.
- Builder changes are checked against sealed test/spec artifacts.
- Verification enforces commands, allowlists, diff limits, protected paths, and semantic source checks.
- A successful run creates a verified commit and draft-PR request artifact.

## Known placeholders

- Composer validation/audit, PHPStan/Psalm, PHPUnit/Pest coverage, Infection, PhpMetrics, PHPCompatibility, and Laravel deprecation rules are automatically executed when detected or applicable; remaining PHP evidence types still depend on prepared artifacts or are not implemented.
- The agent provider delegates to configured commands rather than a first-class model API.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17 for the deprecated-API evidence slice:

- Focused deprecation and adapter tests: 15 tests passed.
- `npm test`: 73 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- `npm run checkpoint` passed after the slice commit.
- Docker image build passed (`daily-improver:local`).
- End-to-end defect → failing property test → bounded fix → independent verification → daily branch flow passed.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint is safe to clear: the deprecated-API evidence slice is committed, the working tree is clean, and the post-commit checkpoint passes.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
