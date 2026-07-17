# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: trusted Composer audit execution and bounded dependency finding normalization.
- Last completed implementation commit: `f6b0166` (`feat: execute and normalize composer audit`).
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1A — Real PHP observer.
- Current state: the Composer validation and audit slices are implemented, verified, and committed.

## Exact next task

Invoke PHPStan or Psalm through the evidence-runner contract with machine-readable output and normalize static-analysis findings.

## Acceptance criteria for the next task

- Select PHPStan or Psalm from detected manifest capabilities without invoking repository scripts.
- Request a supported machine-readable format and normalize file, line, rule/identifier, and bounded message evidence.
- Code findings, malformed output, configuration failure, timeout, unavailable-tool, and infrastructure outcomes remain distinguishable.
- Findings and execution metadata do not persist raw command output.
- Unit tests cover clean output, findings, malformed output/configuration failure, missing executable, timeout, and truncation.
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

- Only Composer validation and audit are automatically executed; the other PHP evidence tools still depend on prepared artifacts.
- The agent provider delegates to configured commands rather than a first-class model API.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17 for the Composer audit slice:

- Focused Composer audit tests: 8 tests passed.
- `npm test`: 26 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- `npm run checkpoint` passed.
- Docker image build passed (`daily-improver:local`).
- End-to-end defect → failing property test → bounded fix → independent verification → daily branch flow passed.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint is safe to clear: the Composer audit slice is committed, the working tree is clean, verification passes, the exact next task is recorded above, and no external process or decision remains active.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
