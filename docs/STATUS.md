# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: first structured model agent provider.
- Current checkpoint commit: `feat: add structured model agent provider`.
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1C — Structured model agent providers.
- Current state: Phase 1A is complete. Phase 1B has deterministic reproducibility, deduplication, category weights, and bounded scoring factors; its remaining ranking-policy work stays planned. Phase 1C now has strict versioned stage contracts and a structured model provider behind an injected transport; the local CLI continues to expose the command-backed provider.

## Exact next task

Enforce per-stage and daily model cost budgets before structured transport requests.

## Acceptance criteria for the next task

- Define explicit test-stage, builder-stage, and aggregate daily budget inputs without weakening the specification cost ceiling.
- Reject a stage before invoking its transport when its reserved budget is unavailable or exceeds either the stage or remaining daily limit.
- Account validated actual usage after each response and prevent the builder request when test-stage usage leaves insufficient budget.
- Keep budget state injectable and deterministic in tests; do not require live credentials or wall-clock timing.
- Persist bounded budget decisions alongside usage while keeping model rationale separate from trusted evidence.
- `npm run checkpoint` passes.

## Current verified behavior

- The CLI detects PHP and Laravel repositories.
- The observer runs and normalizes Composer, PHPStan/Psalm, PHPUnit/Pest Clover and JUnit timing, Infection, PhpMetrics, PHPCPD, PHPCompatibility, explicit Laravel deprecation rules, versioned Laravel validation/error-handling rules, and opt-in Laravel listener query timing, with bounded version/configuration provenance, deterministic normalized-evidence caching for the established expensive collectors, and prepared-artifact fallbacks where applicable.
- Candidate selection rejects absent, non-reproducible, malformed, or unbounded evidence and scoring factors before deduplication, applies exhaustive language-neutral category weights across eight deterministic factors, and then chooses one bounded improvement or fails closed.
- Test-agent and builder stages have distinct versioned request/response contracts that bound semantic inputs, repository-relative paths, commands, response claims, and provider usage while rejecting unknown fields.
- The structured model provider builds requests only from approved stage inputs, invokes an injected transport, rejects malformed or unauthorized response claims, and persists validated usage separately from model rationale marked as untrusted.
- The local runner creates an isolated daily worktree and branch.
- A correctness regression/property test must fail against baseline behavior.
- Builder changes are checked against sealed test/spec artifacts.
- Verification enforces commands, allowlists, diff limits, protected paths, and semantic source checks.
- A successful run creates a verified commit and draft-PR request artifact.

## Known placeholders

- Composer validation/audit, PHPStan/Psalm, PHPUnit/Pest coverage and timing, Infection, PhpMetrics, PHPCPD, PHPCompatibility, Laravel deprecation and validation/error-handling rules, and configured Laravel query timing are automatically executed or applied when detected or applicable; some remaining PHP evidence types still depend on prepared artifacts.
- The local CLI delegates to configured commands; the structured provider exists, but a production endpoint transport and credential flow are not implemented yet.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17 for the committed structured-model-provider slice:

- Focused structured-provider and end-to-end tests: 3 tests passed.
- `npm test`: 117 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- `npm run checkpoint` passed after the slice commit.
- Docker image build not required; CLI runtime and production dependencies are unchanged.
- End-to-end defect → failing property test → bounded fix → independently verified usage/rationale artifacts → daily branch flow passed.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint is safe to clear after the structured-model-provider slice is committed, the working tree is clean, and the post-commit checkpoint passes.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
