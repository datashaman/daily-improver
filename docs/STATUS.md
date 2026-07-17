# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: trusted targeted Infection execution and bounded mutation normalization.
- Current checkpoint commit: `feat: execute and normalize php mutation analysis`.
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1A — Real PHP observer.
- Current state: the Composer validation/audit, static-analysis, coverage, and mutation-analysis slices are implemented, verified, and committed.

## Exact next task

Invoke a configured PHP complexity tool through the evidence-runner contract and normalize complexity evidence.

## Acceptance criteria for the next task

- Detect one supported complexity tool from manifest or explicit Daily Improver configuration without invoking repository scripts.
- Request machine-readable per-file or per-symbol complexity output through a trusted bounded command.
- High-complexity findings, malformed output, configuration failure, timeout, unavailable-tool, and infrastructure outcomes remain distinguishable.
- Findings and execution metadata do not persist raw command output or unbounded reports.
- Unit tests cover clean output, high-complexity findings, malformed output/configuration failure, missing executable, timeout, and truncation.
- The end-to-end MoneyAllocator proving loop remains green.
- `npm run checkpoint` passes.

## Current verified behavior

- The CLI detects PHP and Laravel repositories.
- The observer reads normalized Infection, PHPStan, Clover, complexity, and TODO evidence.
- Candidate selection chooses one bounded improvement.
- The local runner creates an isolated daily worktree and branch.
- A correctness regression/property test must fail against baseline behavior.
- Builder changes are checked against sealed test/spec artifacts.
- Verification enforces commands, allowlists, diff limits, protected paths, and semantic source checks.
- A successful run creates a verified commit and draft-PR request artifact.

## Known placeholders

- Composer validation/audit, PHPStan/Psalm, PHPUnit/Pest coverage, and Infection are automatically executed; complexity and the remaining PHP evidence tools still depend on prepared artifacts.
- The agent provider delegates to configured commands rather than a first-class model API.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17 for the targeted Infection slice:

- Focused mutation, adapter-integration, and end-to-end tests: 13 tests passed.
- `npm test`: 48 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- `npm run checkpoint` passed after the slice commit.
- Docker image build passed (`daily-improver:local`).
- End-to-end defect → failing property test → bounded fix → independent verification → daily branch flow passed.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint is safe to clear: the mutation slice is committed, the working tree is clean, verification passes, the exact next task is recorded above, and no external process or decision remains active.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
