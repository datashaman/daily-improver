# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: bounded PHPCPD duplicate-code evidence.
- Current checkpoint commit: `feat: collect duplicate PHP code evidence`.
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1A — Real PHP observer.
- Current state: the Composer validation/audit, static-analysis, coverage, mutation-analysis, complexity-analysis, duplicate-code analysis, deprecation-analysis, performance-analysis, shared provenance, and evidence-cache slices are implemented and verified.

## Exact next task

Collect missing-validation and error-handling evidence from bounded reproducible analysis.

## Acceptance criteria for the next task

- Define bounded, reproducible PHP/Laravel signals for missing validation and error handling without model inference.
- Invoke only trusted tools or apply explicit versioned adapter rules; never execute repository-owned scripts as analysis shortcuts.
- Normalize repository-relative locations, rule identity, bounded messages, and relevant tool/configuration provenance without retaining raw source excerpts.
- Distinguish clean output, findings, unsupported inputs, unavailable tooling, configuration failures, timeouts, truncation, malformed output, and infrastructure failures where execution applies.
- Add deterministic fixtures and unit tests for findings plus every supported failure class.
- The end-to-end MoneyAllocator proving loop remains green.
- `npm run checkpoint` passes.

## Current verified behavior

- The CLI detects PHP and Laravel repositories.
- The observer runs and normalizes Composer, PHPStan/Psalm, PHPUnit/Pest Clover and JUnit timing, Infection, PhpMetrics, PHPCPD, PHPCompatibility, explicit Laravel deprecation rules, and opt-in Laravel listener query timing, with bounded version/configuration provenance, deterministic normalized-evidence caching for the established expensive collectors, and prepared-artifact fallbacks where applicable.
- Candidate selection chooses one bounded improvement.
- The local runner creates an isolated daily worktree and branch.
- A correctness regression/property test must fail against baseline behavior.
- Builder changes are checked against sealed test/spec artifacts.
- Verification enforces commands, allowlists, diff limits, protected paths, and semantic source checks.
- A successful run creates a verified commit and draft-PR request artifact.

## Known placeholders

- Composer validation/audit, PHPStan/Psalm, PHPUnit/Pest coverage and timing, Infection, PhpMetrics, PHPCPD, PHPCompatibility, Laravel deprecation rules, and configured Laravel query timing are automatically executed when detected or applicable; remaining PHP evidence types still depend on prepared artifacts or are not implemented.
- The agent provider delegates to configured commands rather than a first-class model API.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17 for the PHP duplicate-code-evidence slice:

- Focused duplicate-code, configuration, and adapter tests: 20 tests passed.
- `npm test`: 92 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- `npm run checkpoint` passed after the slice commit.
- Docker image build not required; CLI runtime and production dependencies are unchanged.
- End-to-end defect → failing property test → bounded fix → independent verification → daily branch flow passed.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint is safe to clear after the duplicate-code-evidence slice is committed, the working tree is clean, and the post-commit checkpoint passes.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
