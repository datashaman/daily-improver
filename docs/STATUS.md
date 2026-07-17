# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: bounded tool-version and relevant-configuration provenance for every executed PHP collector.
- Current checkpoint commit: `feat: record php evidence provenance`.
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1A — Real PHP observer.
- Current state: the Composer validation/audit, static-analysis, coverage, mutation-analysis, complexity-analysis, and shared provenance slices are implemented and verified.

## Exact next task

Cache expensive PHP evidence when its relevant source, trusted command, tool version, and configuration have not changed.

## Acceptance criteria for the next task

- Add a versioned bounded cache artifact for normalized static-analysis, coverage, mutation-analysis, and complexity evidence.
- Derive cache identity from relevant source inputs, the exact trusted command, tool version, and relevant configuration hash.
- Reuse only successful or code-finding evidence; never cache or replay unavailable, configuration, timeout, truncation, or infrastructure failures.
- Invalidate deterministically when source, command, tool version, configuration, schema, or collector policy changes.
- Keep cached artifacts bounded, free of raw tool output, and safe under concurrent runs.
- Unit tests cover cache hits, every invalidation input, corrupt/oversized cache artifacts, failure non-caching, and concurrent access.
- The end-to-end MoneyAllocator proving loop remains green.
- `npm run checkpoint` passes.

## Current verified behavior

- The CLI detects PHP and Laravel repositories.
- The observer runs and normalizes Composer, PHPStan/Psalm, PHPUnit/Pest Clover, Infection, and PhpMetrics evidence, with bounded version/configuration provenance and prepared-artifact fallbacks where applicable.
- Candidate selection chooses one bounded improvement.
- The local runner creates an isolated daily worktree and branch.
- A correctness regression/property test must fail against baseline behavior.
- Builder changes are checked against sealed test/spec artifacts.
- Verification enforces commands, allowlists, diff limits, protected paths, and semantic source checks.
- A successful run creates a verified commit and draft-PR request artifact.

## Known placeholders

- Composer validation/audit, PHPStan/Psalm, PHPUnit/Pest coverage, Infection, and PhpMetrics are automatically executed when detected or configured; remaining PHP evidence types still depend on prepared artifacts or are not implemented.
- The agent provider delegates to configured commands rather than a first-class model API.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17 for the PHP evidence-provenance slice:

- Focused provenance tests: 8 tests passed.
- `npm test`: 60 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- `npm run checkpoint` passed after the slice commit.
- Docker image build passed (`daily-improver:local`).
- End-to-end defect → failing property test → bounded fix → independent verification → daily branch flow passed.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint will be safe to clear after the provenance slice is committed from a clean tree and the post-commit checkpoint passes.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
