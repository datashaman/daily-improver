# Current Project Status

Last updated: 2026-07-18

## Checkpoint

- Last completed milestone: Command-backed test and builder agents receive exact runner-owned environments without ambient credentials.
- Current checkpoint commit: `feat: isolate command agent environments`.
- Last planning commit: `b6f1580` (`docs: add durable delivery plan`).
- Current phase: Phase 1E — Builder isolation.
- Current state: Phase 1A through Phase 1D are complete. Phase 1C has strict versioned stage contracts, deterministic cost enforcement and bounded retries, isolated stage credentials, deterministic replays and routing, a production HTTPS customer-runner composition boundary, and opt-in live harnesses outside deterministic checkpoints. Its exit gate passed on 2026-07-17 when a real OpenAI model generated a credible failing MoneyAllocator defect test and a separate builder call produced a bounded patch that passed sealed-artifact and independent verification gates. Phase 1D has exhaustive intent-specific baseline semantics, nonce-bound property execution proof, applicable known-mutation execution proof, source-free implementation-restatement inspection, three-attempt generated-test lifecycle gates, and source-free Pest, PHPUnit, and Eris quality inspection before building and publishing. Phase 1E derives one exact production-file write allowlist, runs without Git metadata in a disposable copy, imports only approved regular-file writes, and materializes a versioned protected-input snapshot from trusted configuration plus sealed identities. Protected tests, specifications, policies, workflows, and migrations are immutable at the builder boundary and revalidated before import. Command-backed agents now execute through a non-login shell with only a validated runner-owned absolute `PATH`, the exact current stage, and a repository-contained specification path; ambient test, analysis, manifest, control-plane, GitHub, and unrelated model credentials do not cross into the builder. The structured provider retains its separate short-lived stage credential transport boundary. The configured customer-runner structured-endpoint proof remains a separate deployment gate.

## Exact next task

Disable outbound networking in the builder by default.

## Acceptance criteria for the next task

- Run the disposable builder with outbound network access denied unless a trusted runner policy explicitly approves it.
- Keep network policy outside repository-controlled configuration and model output.
- Fail closed when the requested isolation mechanism is unavailable or cannot be verified.
- Prove deterministically that a builder can still read protected inputs and modify one approved production file while connection attempts fail.
- Preserve the exact command environment, protected-input immutability, production write allowlist, response validation, cost accounting, diff limits, and independent verification.
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
- `TrustedRunnerModelStageCredentialSource` resolves exchange configuration without repository arguments, validates exact trusted issuer/audience/stage/scope identity claims, keeps the assertion only in the bounded exchange authorization header, and accepts only an exact short-lived `model-stage-credential/v1` response for the requested stage and hashed repository/specification scope.
- Credential exchange bounds identity, request, response, and timeout values; unsupported protocols, extended schemas, mismatched claims, status failures, malformed responses, and oversized values fail closed with sanitized explicit classifications. Only transient acquisition failures retry, and failed exchanges settle zero model cost.
- The local runner creates an isolated daily worktree and branch.
- Specification removes configured protected scopes before producing the builder write allowlist. The runner accepts only a non-empty, unique, bounded collection of exact repository-relative production files, rejects absolute paths, traversal, wildcards, protected overlap, non-regular targets, missing parents, and symlink crossings before builder invocation, and passes the narrowed allowlist to the builder request.
- The builder executes against a disposable repository copy without Git metadata. A language-neutral `builder-protected-inputs/v1` snapshot expands only trusted protected patterns and sealed artifact identities, rejects missing, mutable, replaced, non-regular, excessive, malformed, or symlink-crossing inputs, and materializes tests, specifications, policies, workflows, and migrations plus their parent directories read-only. The builder can read them, but write, replace, rename, and delete attempts fail; identities and permissions are checked again before only approved regular-file changes or deletions are atomically imported. The established response, manifest, diff, semantic, and verification gates still run independently.
- Command-backed agents receive an exact PATH-only runner environment plus their current stage and repository-contained specification path through a non-login shell. Missing, malformed, extended, relative, or oversized runtime configuration fails before execution, and deterministic sentinel credentials prove that test, analysis, manifest, control-plane, GitHub, and unrelated model secrets cannot cross into the builder while required commands still execute.
- The opt-in live runner harness uses explicit `skip`/`require` invocation, runner-owned absolute configuration paths, distinct bounded stage assertions, a disposable exact workspace, and fail-before-network absence checks; it is excluded from the checkpoint test glob.
- The direct OpenAI provider uses the Responses API with strict Structured Outputs, bounded allowlisted regular-file source context, no serialized host path, pre-request estimated cost limits, sanitized HTTP failures, trusted runner requirements, protected builder context, and validated same-worktree replacement writes before the existing manifest/diff/verification gates.
- A correctness regression/property test must fail against baseline behavior; syntax, resource-limit, dependency, and autoload failures are rejected as non-behavioral proof.
- Every specification and structured agent request carries an exact `improvement-intent/v1` contract. Candidate categories provide exhaustive deterministic defaults, while adapters may declare more precise bounded intent from evidence; escaped mutations are defects and uncovered behavior remains refactor/test-protection work.
- `test-plan/v7` retains the sealed intent, observed baseline outcome, generated-test lifecycle reference, adapter-quality reference, execution-proof references, and implementation-inspection reference. Defects require a credible behavioral failure; refactor characterization, performance measurement, and maintainability quality baselines must pass before the builder runs; every intent must then pass independent verification.
- Property specifications require one evidence-backed production target. Their executed tests must emit an exact nonce-bound `property-test-execution-proof/v1` with 32–1,000 unique input digests, one target execution and approved-invariant check per input, and intent-consistent failure counts. Missing, malformed, stale, trivial, duplicate, unexecuted, wrong-test, wrong-target, or wrong-invariant proof fails before the builder, and the validated artifact is sealed.
- Evidence that explicitly marks the baseline target as a known mutant produces exact `known-mutation/v1` specification input. Before the builder, the relevant observed generated test must fail its approved invariant or acceptance criterion; `known-mutation-execution-proof/v1` retains only the bounded mutation identity, test, target, criterion, exact command, behavioral outcome, duration, and output hashes. Missing, malformed, unexecuted, survived, wrong-test, wrong-target, wrong-criterion, or non-behavioral proof fails closed, and the validated artifact is sealed.
- Property work also produces exact `test-implementation-inspection/v1` evidence over the observed generated test and selected target. Direct production-source inspection, exact token runs of at least 24 tokens, and identifier-normalized structural runs of at least 48 tokens reject before the builder; accepted decisions retain only bounded paths, SHA-256 identities, metrics, exhaustive signals, and the approved criterion, and are sealed through `test-plan/v7` and the test manifest.
- Every generated test emits exact nonce-bound `generated-test-lifecycle-report/v1` observations during three baseline and three verification attempts. Missing, skipped, disabled, assertion-free, deleted, changed, reduced-assertion, tolerance-changed, or inconsistently executing tests fail closed. Varying outcomes or metrics produce bounded `candidate-quarantine/v1`, release the daily claim, and stop before the builder or publication. Sealed baseline and post-change decisions retain only commands, file identities, exit codes, durations, assertion/tolerance metrics, and output hashes.
- Detected Pest work runs the PHP adapter's exact `pest-generated-test-quality-inspection/v1` after accepted baseline lifecycle proof and before the builder. Every bounded generated test is inspected; focused `only`, `skip`/`todo`, assertion-free declarations, empty providers, dynamic or named providers without locally provable cases, malformed lexical structure, unsupported discovery syntax, non-regular/oversized files, and lifecycle/path/hash/metric mismatches fail closed. Accepted sealed evidence retains no source text, only framework/schema identity, paths, SHA-256 identities, bounded counts, and exhaustive signals.
- Detected PHPUnit work runs the PHP adapter's exact `phpunit-generated-test-quality-inspection/v1` at the same lifecycle boundary. Public convention-, attribute-, and docblock-discovered methods are accepted only inside `TestCase` subclasses; skipped/incomplete markers, per-method assertion gaps, non-public discovery, empty providers, external providers, and missing or dynamic named providers fail closed. Exact evidence is bound to the selected path, every observed lifecycle path, hashes, attempts, and assertion metrics and retains no source text.
- Detected Eris property work runs the ordinary Pest or PHPUnit gate first, then emits exact `eris-property-test-quality-inspection/v1` bound to the accepted lifecycle, validated property proof, selected test, production target, approved invariant, and observed input/execution/check counts. It requires class-applied `Eris\TestTrait`, supported static `Eris\Generators` construction, direct `forAll(...)->then(...)` execution, target invocation, invariant assertions, and the bounded default iteration mode; dynamic or fake generators, execution bypasses, iteration overrides, missing target/assertion structure, malformed files, and inconsistent exact evidence fail closed. The retained artifact nests its accepted source-free runner evidence and contains no generated source text.
- The opt-in direct OpenAI MoneyAllocator proof passed end to end with separate real-model test and builder calls, sealed protected artifacts, independent verification, and a draft publication request.
- Builder changes are checked against sealed test/spec artifacts.
- Verification enforces commands, allowlists, diff limits, protected paths, and semantic source checks.
- A successful run creates a verified commit and draft-PR request artifact.

## Known placeholders

- Composer validation/audit, PHPStan/Psalm, PHPUnit/Pest coverage and timing, Infection, PhpMetrics, PHPCPD, PHPCompatibility, Laravel deprecation and validation/error-handling rules, and configured Laravel query timing are automatically executed or applied when detected or applicable; some remaining PHP evidence types still depend on prepared artifacts.
- The local CLI delegates to configured commands; the live MoneyAllocator harness exists, but it has not yet been executed against a configured customer-runner model endpoint.
- `daily-improver-auth` does not exist.
- The setup workflow is architectural scaffolding, not production-ready automation; its `daily-improver-auth unresolved-findings` and `daily-improver-auth open-pull-requests` producers are not implemented.
- `publish` does not push a branch or create a GitHub PR.
- The GHCR image is not published.
- The GitHub App and hosted control plane do not exist.
- Outcome-based ranking and review learning are not implemented.
- Only PHP has a real adapter.

## Last verification

Verified on 2026-07-18 for the command-agent environment slice:

- Focused command-agent environment tests: 2 tests passed.
- Focused command-agent, builder-filesystem, and local-runner integration tests: 10 tests passed.
- `npm test`: 234 tests passed; both live model proofs remained excluded.
- Strict TypeScript check passed.
- TypeScript unused-local and unused-parameter check passed.
- `git diff --check` passed before commit.
- `npm run checkpoint` passed after the slice commit.
- The local container image built successfully because command-backed CLI runtime behavior changed; production dependencies did not change.
- Deterministic sentinel examples prove command execution with the exact stage and specification path while ambient test, analysis, manifest, control-plane, GitHub, and unrelated model credentials are absent; malformed runner environments fail before command execution.
- The live OpenAI proof was not rerun; the previously recorded `gpt-5.6-terra` proof remains valid and outside deterministic checkpoints.

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
