# Architecture

Daily Improver is a portable, language-neutral improvement engine. PHP/Laravel is its first proving adapter. GitHub Actions is an execution substrate, and a GitHub App-backed control plane supplies scheduling, installation state, short-lived credentials, metering, feedback, and PR creation.

```mermaid
flowchart LR
  App[GitHub App] --> Scheduler[Thin scheduler]
  Scheduler --> Actions[Customer GitHub Actions]
  Actions --> Observe[Observe and select]
  Observe --> Tests[Specify and test]
  Tests --> Build[Isolated builder]
  Build --> Verify[Fresh verifier]
  Verify --> Request[Publication request]
  Request --> App
```

The control plane does not clone repositories, install dependencies, run tests, or retain source code. Repository execution remains on GitHub-hosted or customer-controlled runners.

## Trust boundaries

- Analysis has read-only repository access and produces evidence plus one selected candidate.
- Test generation receives the approved candidate and emits tests plus an HMAC integrity manifest.
- The builder receives the repository, immutable tests, the spec, and a file allowlist. It has no access to earlier stage credentials.
- Verification starts from a fresh checkout, validates the manifest and diff, and executes repository-owned verification commands.
- Publication emits a request. The GitHub App, not the workflow token, opens the draft PR.

The model-facing agent protocol uses separate, fail-closed `test-agent-request/v1` / `test-agent-response/v1` and `builder-request/v1` / `builder-response/v1` contracts. Every field is explicit and bounded; unknown fields, unsupported versions, absolute or traversing paths, oversized collections, malformed commands, and invalid usage values are rejected.

Only these approved inputs cross the test-agent boundary: the semantic task and limits, bounded evidence and invariants, language/framework identifiers, explicit test commands, test conventions, and repository-relative paths where tests may be written. The request does not contain a host repository path or credentials. Its response identifies the generated tests and changed files, summarizes the work, and records bounded provider/model usage.

Only these approved inputs cross the builder boundary: the same semantic task and limits, language/framework identifiers, the production-file allowlist, immutable protected-file identities, explicit verification commands, and builder conventions. The builder receives no test-agent credentials. Its response identifies changed files, supplies bounded implementation notes, and records bounded provider/model usage. Filesystem access and response claims remain subject to the independent manifest, diff, and verification gates.

GitHub OIDC is exchanged for short-lived, stage-scoped control-plane credentials. The workflow token only needs repository-local permissions appropriate to its job. The setup workflow is introduced through a human-reviewed setup PR; the App does not request workflow-write permission.

## Extension model

`RepositoryAdapter` detects an ecosystem, constructs capabilities, discovers evidence-backed candidates, and classifies failures. Framework adapters will decorate language profiles. Core ranking, policy, specifications, history, isolation, verification, and publishing stay language-neutral.

The next adapters should be TypeScript and Python, but only after the PHP/Laravel loop consistently yields mergeable PRs.

## Local proving loop

`daily-improver run` is the Phase 1 vertical slice. It reads evidence, selects exactly one candidate, creates an isolated Git worktree and daily branch, delegates tests and implementation through separate `AgentProvider` calls, requires the new regression test to fail against the baseline, seals tests/specification artifacts, runs independent verification, commits the verified result, and emits the draft-PR request.

Verification combines repository commands with structural gates: protected-test hashes, file allowlists, diff limits, protected paths, property-test non-triviality, static-analysis suppression detection, broad exception-swallowing detection, and public API addition detection. These heuristics supplement ecosystem tools; they do not replace PHPStan, PHPUnit/Pest, or Infection.

Performance observation invokes manifest-detected PHPUnit/Pest executables directly and writes JUnit timing output to a trusted temporary path. Laravel query timing is an explicit opt-in test-listener contract: the repository may write a versioned report only to an injected temporary path, but the adapter treats its contents as untrusted. Report size, count, duration, source paths, schema, and thresholds are bounded; SQL is normalized transiently into a fingerprint, and the raw report is removed before normalized evidence crosses the observer boundary.

Duplicate-code observation invokes manifest-detected or explicitly configured PHPCPD directly and writes PMD CPD XML to a trusted temporary path. Only bounded repository-relative regions, line ranges, token/line counts, exact-match similarity, generated messages, and tool/configuration provenance cross the observer boundary. Duplicated code fragments in the report remain transient and are removed with the raw artifact.

Before deduplication or ranking, the language-neutral core requires non-empty bounded evidence and a valid `candidate-reproducibility/v1` contract. The contract explicitly declares reproducibility, strength, and bounded provenance; absent, non-reproducible, malformed, or unbounded inputs are rejected, and analysis fails closed when none remain.

The core then deduplicates candidates that declare the same versioned subsystem and defect identity. The strongest reproducible candidate is retained as a whole, including its evidence, provenance, target, and explanation; deterministic tie-breaks make the result independent of collector order. Different defect identities remain separate even when they point at the same file or package. Candidates without a semantic identity are deduplicated only by their stable candidate ID.

Ranking uses an exhaustive language-neutral weight table keyed by candidate kind. Every category rewards reproducible evidence strength, likely impact, confidence, and testability and penalizes estimated effort, estimated diff, change risk, and subsystem risk. Unit-interval factors and integer diff estimates bounded by the autonomous 250-line limit are mandatory and fail closed before deduplication when invalid. Category emphasis remains language-neutral: dependency vulnerabilities favor impact, static analysis and documentation favor confidence, and mutation testing applies the strongest effort penalty. Scores are rounded consistently and ties are resolved by stable candidate ID.

Laravel validation and error-handling observation uses a bounded, versioned adapter rule registry rather than model inference or repository-owned analysis scripts. The initial rules identify request data passed wholesale into mass-assignment APIs, empty catch blocks, and broad exception catches that return only a default value. The observer retains repository-relative file and line identity, rule identity, generated messages, rule-set provenance, and hashed Composer configuration; source excerpts remain inside the repository boundary.
