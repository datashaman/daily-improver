# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: trusted configured PhpMetrics execution and bounded complexity normalization.
- Current checkpoint commit: `feat: execute and normalize php complexity analysis`.
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1A — Real PHP observer.
- Current state: the Composer validation/audit, static-analysis, coverage, mutation-analysis, and complexity-analysis slices are implemented and verified.

## Exact next task

Record tool-version and relevant-configuration provenance for every executed PHP evidence collector.

## Acceptance criteria for the next task

- Extend the versioned persistable evidence metadata with a bounded tool version and relevant configuration hash.
- Collect provenance without invoking repository scripts or allowing repository configuration to replace trusted evidence commands.
- Hash only the configuration files that can affect each collector and distinguish absent configuration from unreadable or oversized inputs.
- Unavailable version commands, malformed versions, and configuration-hash failures fail closed without persisting raw output.
- Unit tests cover version capture, configuration changes, absent configuration, unavailable tools, malformed output, and bounded hashing.
- The end-to-end MoneyAllocator proving loop remains green.
- `npm run checkpoint` passes.

## Current verified behavior

- The CLI detects PHP and Laravel repositories.
- The observer runs and normalizes Composer, PHPStan/Psalm, PHPUnit/Pest Clover, Infection, and PhpMetrics evidence, with prepared-artifact fallbacks where applicable.
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

Verified on 2026-07-17 for the configured PhpMetrics slice:

- Focused complexity, adapter-integration, configuration, and end-to-end tests: 15 tests passed.
- `npm test`: 56 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- `npm run checkpoint` passed after the slice commit.
- Docker image build passed (`daily-improver:local`).
- End-to-end defect → failing property test → bounded fix → independent verification → daily branch flow passed.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint is safe to clear: the complexity slice is committed, the working tree is clean, verification passes, the exact next task is recorded above, and no external process or decision remains active.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
