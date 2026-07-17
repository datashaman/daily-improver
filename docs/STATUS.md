# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: language-neutral bounded evidence runner and trusted Composer validation integration.
- Last completed implementation commit: `c86c690` (`feat: validate composer evidence with bounded runner`).
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1A — Real PHP observer.
- Current state: the first Phase 1A slice is implemented, verified, and committed.

## Exact next task

Invoke `composer audit --format=json` through the evidence-runner contract and normalize dependency-vulnerability findings.

## Acceptance criteria for the next task

- The command is trusted and direct; repository scripts cannot silently replace it.
- Composer 2.10 and earlier supported audit JSON shapes and exit semantics are normalized deliberately.
- Vulnerability, abandoned-package, policy, missing-package, configuration, timeout, unavailable-tool, and infrastructure outcomes remain distinguishable.
- Findings contain stable package/advisory identity and bounded evidence without persisting raw command output.
- Unit tests cover clean audit output, vulnerabilities, malformed JSON/configuration failure, missing Composer, timeout, and truncation.
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

- Only `composer validate` is automatically executed; the other PHP evidence tools still depend on prepared artifacts.
- The agent provider delegates to configured commands rather than a first-class model API.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17 for the Composer validation slice:

- `npm test`: 18 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- Docker image build passed.
- End-to-end defect → failing property test → bounded fix → independent verification → daily branch flow passed.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint is safe to clear: the Composer validation slice is committed, the working tree is clean, verification passes, and the exact next task is fully represented above.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
