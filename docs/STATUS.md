# Current Project Status

Last updated: 2026-07-17

## Checkpoint

- Last completed milestone: bounded production HTTPS structured endpoint transport behind trusted opaque resolution.
- Current checkpoint commit: `feat: add HTTPS structured endpoint transport`.
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1C — Structured model agent providers.
- Current state: Phase 1A and Phase 1B are complete. Phase 1B has deterministic reproducibility, deduplication, category weights, bounded scoring factors, replayable versioned score explanations, a near-zero cap for explicitly cosmetic-only work, validated repository priority ordering with bounded influence, repository file/line scope gates with a bounded human-task route, deterministic machine-readable exclusions for every pre-selection rejection, one active or completed improvement per canonical repository per UTC day, fresh repository-bound open-PR and unresolved-finding gates, exactly-one selection in a run, and stable-ID tie-breaking. Phase 1C retains strict versioned stage contracts, deterministic per-attempt stage/daily/specification cost enforcement, bounded retries for explicitly classified transient failures, distinct short-lived test/builder credentials, committed deterministic test/build replays, versioned lower/higher routing, exact endpoint-neutral private-endpoint capabilities, and a production HTTPS transport that resolves only opaque IDs through an injected trusted runner boundary and bounds payloads, timeouts, protocols, status handling, and sanitized failures; the local CLI continues to expose the command-backed provider.

## Exact next task

Add production exchange of trusted runner identity for short-lived, stage-scoped model credentials.

## Acceptance criteria for the next task

- Acquire trusted runner identity only through an injected boundary; repository inputs cannot provide an OIDC assertion, exchange URL, audience, or credential.
- Exchange identity for an exact `model-stage-credential/v1` bound to the requested test/build stage and repository/specification scope with at most a fifteen-minute lifetime.
- Bound exchange request/response sizes and timeouts, fail closed on unsupported protocols, identity claims, status codes, malformed responses, or scope mismatches, and classify retryability explicitly.
- Keep runner assertions, exchange locators, authorization headers, and returned credential secrets out of requests, usage, rationale, attempts, and sanitized errors.
- Add deterministic injected-exchange success and failure examples without network access, a live identity provider, a model API, or permanent credentials.
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
- A `task-complexity-decision/v1` scores only validated task scope and collection counts, selects explicit lower/higher test and build routes from `model-routing-policy/v1`, and is retained in trusted `agent-usage/v4`; malformed, unsupported, duplicate, ambiguous, or response-mismatched routes fail closed without inspecting task prose, source, host paths, credentials, or rationale.
- An exact `model-endpoint-policy/v1` assigns every route once to an opaque endpoint ID with explicit structured-protocol, stage, ephemeral-authentication, and maximum-cost capabilities; incomplete, unsupported, extended, duplicate, uncovered, or route-incompatible policies fail before reservation, credential acquisition, or transport.
- Committed `structured-provider-replay/v3` fixtures bind both routed stages to a deterministic private endpoint while pinning route and endpoint policies together with the established credential, retry, validation, and cost boundaries.
- `HttpsStructuredEndpointTransport` resolves the selected opaque endpoint ID only through an injected trusted resolver, accepts an exact bounded `model-endpoint-resolution/v1`, sends a versioned JSON body containing only the validated stage request, route, and maximum cost, and keeps the ephemeral credential in the authorization header.
- The production HTTPS path rejects non-HTTPS or mismatched resolution, embedded URL authentication, fragments, redirects, invalid bounds, oversized bodies, invalid content types, and malformed JSON; connection, timeout, HTTP, and malformed-response outcomes are explicit and sanitized without retaining locators, headers, bodies, credentials, or underlying client error text.
- The local runner creates an isolated daily worktree and branch.
- A correctness regression/property test must fail against baseline behavior.
- Builder changes are checked against sealed test/spec artifacts.
- Verification enforces commands, allowlists, diff limits, protected paths, and semantic source checks.
- A successful run creates a verified commit and draft-PR request artifact.

## Known placeholders

- Composer validation/audit, PHPStan/Psalm, PHPUnit/Pest coverage and timing, Infection, PhpMetrics, PHPCPD, PHPCompatibility, Laravel deprecation and validation/error-handling rules, and configured Laravel query timing are automatically executed or applied when detected or applicable; some remaining PHP evidence types still depend on prepared artifacts.
- The local CLI delegates to configured commands; the structured provider has a production HTTPS endpoint transport, but production trusted-runner endpoint-resolution wiring and credential exchange are not implemented yet.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation; its `daily-improver-auth unresolved-findings` and `daily-improver-auth open-pull-requests` producers are not implemented.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-17 for the production HTTPS structured endpoint transport slice:

- Focused HTTPS transport and structured-provider tests: 19 tests passed.
- `npm test`: 173 tests passed.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed.
- `npm run checkpoint` passed after the slice commit.
- `docker build -t daily-improver:local .` passed.
- End-to-end defect → failing property test → bounded fix → independently verified daily branch flow passed.
- Deterministic injected-HTTP examples proved opaque trusted resolution, the exact bounded HTTPS payload and authentication split, protocol/request/response/timeout limits, sanitized connection and status failures, malformed-response handling, and no network or permanent credential dependency.

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
