# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: bounded machine-readable candidate score explanations.
- Current checkpoint commit: `feat: explain candidate scores`.
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1C — Structured model agent providers.
- Current state: Phase 1A and Phase 1B are complete. Phase 1B has deterministic reproducibility, deduplication, category weights, bounded scoring factors, replayable versioned score explanations, a near-zero cap for explicitly cosmetic-only work, validated repository priority ordering with bounded influence, repository file/line scope gates with a bounded human-task route, deterministic machine-readable exclusions for every pre-selection rejection, one active or completed improvement per canonical repository per UTC day, fresh repository-bound open-PR and unresolved-finding gates, exactly-one selection in a run, and stable-ID tie-breaking. Phase 1C retains strict versioned stage contracts, a structured model provider behind an injected transport, deterministic per-attempt stage/daily/specification cost enforcement, bounded retries for explicitly classified transient failures, and distinct short-lived test/builder credentials; the local CLI continues to expose the command-backed provider.

## Exact next task

Add deterministic provider replay fixtures.

## Acceptance criteria for the next task

- Add committed, deterministic request/response replay fixtures for both structured test-agent and builder stages.
- Replay through the injected transport, credential source, clock/timing, and cost ledger without a live model API or permanent credential.
- Assert stable versioned requests, validated responses, usage, attempt metadata, budget decisions, and separation of untrusted rationale.
- Cover a successful stage and an explicitly classified transient retry/failure path without retaining transport error text.
- Keep fixtures bounded, repository-independent, and safe for concurrent test execution.
- `npm run checkpoint` passes.

## Current verified behavior

- The CLI detects PHP and Laravel repositories.
- The observer runs and normalizes Composer, PHPStan/Psalm, PHPUnit/Pest Clover and JUnit timing, Infection, PhpMetrics, PHPCPD, PHPCompatibility, explicit Laravel deprecation rules, versioned Laravel validation/error-handling rules, and opt-in Laravel listener query timing, with bounded version/configuration provenance, deterministic normalized-evidence caching for the established expensive collectors, and prepared-artifact fallbacks where applicable.
- Candidate selection rejects absent, non-reproducible, malformed, or unbounded evidence and scoring factors before deduplication, applies exhaustive language-neutral category weights across eight deterministic factors, and then chooses one bounded improvement or fails closed.
- Candidate selection caps an explicitly versioned `cosmetic-only` value classification at `0.01`, rejects malformed or extended classifications, applies only validated exhaustive repository priorities with at most `0.05` influence, chooses exactly one candidate per run, and resolves equal scores by stable candidate ID.
- Every ranked candidate emits an ordered `candidate-score-explanation/v1` with all eight normalized factors, exhaustive signed category weights, raw weighted contribution, repository-priority influence, optional cosmetic cap, and final score; replay must match the persisted score and stable-ID order exactly. Version 5 analysis artifacts and planning runs retain the bounded explanations without evidence, rationale, provenance, targets, or source paths, and specification fails closed on malformed, incomplete, unbounded, extended, incorrectly weighted, or configuration-inconsistent records.
- Candidate selection rejects credible work beyond repository file or changed-line limits before specification, emits at most one bounded `human-task-recommendation/v1` without evidence or source paths, continues with a lower-ranked bounded candidate when available, and persists oversized-only planning as rejected.
- Candidate selection emits one bounded `candidate-exclusion/v2` at the first failed gate for malformed scope, evidence, scoring, semantic deduplication, oversized scope, or an unresolved finding; exclusions are deterministic, replace invalid IDs with hashes, and retain no evidence, provenance, rationale, title, target, or source path. Version 5 analysis artifacts and persisted planning runs retain these reasons, including rejected runs where no candidate survives.
- Analysis requires fresh injected `unresolved-finding-state/v1` from the trusted control-plane/GitHub boundary; the exact schema is bound to the SHA-256 of an independently supplied trusted repository scope, expires after fifteen minutes, and contains at most 1,000 unique semantic finding hashes. Matches are excluded before autonomous selection, the highest-ranked unmatched bounded candidate remains eligible, and missing, malformed, non-regular, oversized, stale, future-dated, or cross-repository state fails closed without granting core network access.
- Specification atomically claims `daily-improvement-decision/v1` state keyed by the SHA-256 identity of the canonical repository path and UTC date; active and completed claims block another specification, completed publication requests cannot transition twice, policy-rejected plans release their claim, and candidate rejection or human-task routing does not consume the repository day.
- Specification requires fresh injected `open-pull-request-state/v1` from the trusted control-plane/GitHub boundary; the exact schema is bound to the SHA-256 of an independently supplied trusted repository scope, expires after fifteen minutes, and contains a bounded integer count. Missing scope or state, malformed or non-regular input, stale, future-dated, negative, fractional, unbounded, or cross-repository state fails closed, while a count at or above `limits.max_open_prs` rejects before the daily claim and specification. Candidate rejection and human-task routing do not read the state.
- Test-agent and builder stages have distinct versioned request/response contracts that bound semantic inputs, repository-relative paths, commands, response claims, and provider usage while rejecting unknown fields.
- The structured model provider builds requests only from approved stage inputs, invokes an injected transport, rejects malformed or unauthorized response claims, and persists validated usage separately from model rationale marked as untrusted.
- Structured model requests reserve explicit test or builder cost before transport against stage, daily, and unchanged specification limits; actual validated usage is settled deterministically, unavailable builder budget fails before invocation, and versioned budget decisions are stored with trusted usage.
- Structured model attempts use a bounded five-class failure model; only explicitly transient transport failures retry through injected timing, every attempt has a fresh reservation, unknown usage consumes the reservation conservatively, and sanitized versioned attempt metadata is stored with trusted usage.
- Every structured transport attempt acquires an injected `model-stage-credential/v1` credential scoped to its exact test/build stage and repository/specification run; credentials valid for more than fifteen minutes, unavailable, expired, future-issued, malformed, mis-scoped, or reused across stages fail before transport, while raw secrets remain outside requests and artifacts.
- The local runner creates an isolated daily worktree and branch.
- A correctness regression/property test must fail against baseline behavior.
- Builder changes are checked against sealed test/spec artifacts.
- Verification enforces commands, allowlists, diff limits, protected paths, and semantic source checks.
- A successful run creates a verified commit and draft-PR request artifact.

## Known placeholders

- Composer validation/audit, PHPStan/Psalm, PHPUnit/Pest coverage and timing, Infection, PhpMetrics, PHPCPD, PHPCompatibility, Laravel deprecation and validation/error-handling rules, and configured Laravel query timing are automatically executed or applied when detected or applicable; some remaining PHP evidence types still depend on prepared artifacts.
- The local CLI delegates to configured commands; the structured provider accepts bounded ephemeral credentials, but a production endpoint transport and production credential exchange are not implemented yet.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation; its `daily-improver-auth unresolved-findings` and `daily-improver-auth open-pull-requests` producers are not implemented.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17 for the machine-readable score explanation slice:

- Focused score-explanation, ranking, scope, and pipeline tests: 33 tests passed.
- `npm test`: 163 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- `npm run checkpoint` passed after the slice commit.
- `docker build -t daily-improver:local .` passed for the changed CLI runtime.
- End-to-end defect → failing property test → bounded fix → independently verified daily branch flow passed.
- All checked foundation, Phase 1A, Phase 1B, and completed Phase 1C items in `PLAN.md` were reviewed against current code, executable tests, and slice history; the audit found and fixed the standalone analysis artifact retaining more than one selected candidate.

Run `npm run checkpoint` after resuming to confirm the checkout still matches this checkpoint.

## Clear-safety state

This checkpoint is safe to clear: the slice is committed, the working tree is clean, the post-commit checkpoint passes, and the exact next task is recorded above.

## Updating this file

Keep this document short-lived and factual. Replace stale state rather than appending a diary. Update it whenever:

- the exact next task changes;
- a milestone or commit completes;
- a blocker appears or clears;
- verification expectations change;
- a decision would otherwise live only in conversation context.
