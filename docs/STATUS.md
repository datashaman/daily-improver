# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: deterministic PHP/Laravel autonomous improvement proof.
- Last completed implementation commit: `68bd913` (`feat: prove autonomous PHP improvement loop`).
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1A — Real PHP observer.
- Current state: no implementation work for Phase 1A has started.

## Exact next task

Implement the evidence-runner contract and use it to invoke and normalize the first trusted PHP tool: `composer validate`.

This first slice should establish the reusable execution model before adding PHPStan, coverage, Infection, audit, or complexity commands.

## Acceptance criteria for the next task

- A language-neutral evidence-runner contract exists outside the PHP adapter.
- Command execution has an explicit timeout and output-size limit.
- Results distinguish success, code finding, unavailable tool, configuration failure, timeout, and infrastructure failure.
- The result records command identity, duration, exit code, and output hashes without persisting unnecessary raw output.
- The PHP adapter can invoke `composer validate` through the contract.
- Repository commands cannot silently replace this trusted command.
- Unit tests cover success, timeout, missing executable, invalid Composer configuration, and output truncation.
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

- Evidence tools are not automatically executed yet.
- The agent provider delegates to configured commands rather than a first-class model API.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17:

- `npm test`: 11 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- Docker image build passed.
- End-to-end defect → failing property test → bounded fix → independent verification → daily branch flow passed.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint becomes safe to clear after the handoff-document changes are committed and the working tree is clean. After that commit, the exact next task is fully represented above and no conversation-only decision is required.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
