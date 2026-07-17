# Daily Improver

A language-neutral continuous codebase improvement system that opens one independently verified draft PR every day.

PHP/Laravel is the initial vertical, not the product boundary. The TypeScript core selects adapters from repository signals and works through test, lint, static-analysis, mutation, coverage, property-testing, and formatting capabilities.

## Resuming work

Agents should begin with [`AGENTS.md`](AGENTS.md), then read [`docs/STATUS.md`](docs/STATUS.md) for the exact checkpoint and [`PLAN.md`](PLAN.md) for the surrounding milestone. A context clear is safe when the checkpoint is committed, `npm run checkpoint` passes, and the working tree is clean.

## Try it

```bash
npm install
npm test
npm run dev -- inspect /path/to/php-repository
npm run dev -- analyse /path/to/php-repository
npm run dev -- specify /path/to/php-repository
```

To execute the complete local loop with command-backed test and builder agents:

```bash
export DAILY_IMPROVER_TEST_AGENT_COMMAND='your-agent test-command'
export DAILY_IMPROVER_BUILDER_COMMAND='your-agent build-command'
export DAILY_IMPROVER_MANIFEST_KEY="$(openssl rand -hex 32)"
npm run dev -- run /path/to/php-repository
```

Each agent runs in an isolated worktree. It receives `DAILY_IMPROVER_AGENT_STAGE` and `DAILY_IMPROVER_SPEC_PATH`; the test agent must add regression/property tests, while the builder must implement the spec without touching sealed tests.

The command-backed provider remains available for the local CLI. The first structured model provider accepts an injected transport and uses separate versioned `test-agent-request/v1`, `test-agent-response/v1`, `builder-request/v1`, and `builder-response/v1` contracts. Requests expose only the bounded semantic task, repository language/framework context, explicit commands and conventions, and stage-specific repository-relative path permissions. They never serialize host repository paths or credentials. Responses fail closed on unknown fields, unsupported versions, unbounded text or collections, unsafe or unauthorized changed-file claims, malformed commands, or invalid token, latency, and cost usage. Before transport, a `task-complexity-decision/v1` deterministically selects a lower- or higher-complexity test/build route from an exact `model-routing-policy/v1`. The score uses only validated file and changed-line limits plus acceptance-criteria, property-invariant, and evidence counts; it never reads task prose, repository source, host paths, credentials, or model rationale. Each of the four routes has a unique bounded ID and explicit provider/model target. An exact `model-endpoint-policy/v1` then assigns every route exactly once to a bounded endpoint ID with endpoint-neutral structured-protocol, supported-stage, ephemeral-authentication, and maximum-cost capabilities. Incomplete, unsupported, extended, duplicate, same-target, uncovered, or stage-incompatible configuration fails closed before transport, and response usage must match the selected route. Endpoint resolution stays inside the injected transport; URLs and provider-specific behavior do not enter core stage contracts. Structured transports require explicit test, builder, and aggregate daily cost budgets; an injectable ledger reserves cost before every attempt against all three limits and the specification cost ceiling, then accounts validated actual usage. Attempts without validated usage conservatively consume their full reservation. Only an explicitly classified transient transport failure may retry, using a bounded attempt schedule and injected timing; permanent transport failures, malformed responses, policy/path violations, and budget failures stop immediately. Every attempt also requires an injected `model-stage-credential/v1` credential scoped to the exact test or builder stage and repository/specification run, valid for no more than fifteen minutes. Invalid credentials stop before transport, and one secret cannot cross from test to build. Credential secrets remain ephemeral transport context and never enter endpoint metadata, requests, responses, trusted usage, untrusted rationale, routing decisions, attempt metadata, or errors. The versioned trusted `agent-usage/v4` artifact records the routing decision, sanitized attempt classifications, and per-attempt budget decisions without transport error messages. Summaries and implementation notes remain separate and are explicitly marked as untrusted model rationale.

Committed `structured-provider-replay/v3` fixtures under `test/fixtures/model-provider-replay/` replay both structured stages against a deterministic private endpoint without network access or permanent credentials. They pin the explicit routing and endpoint policies plus the trusted complexity decision. The builder replay includes a classified transient failure and verifies deterministic retry timing, fresh credential acquisition, conservative failure accounting, validated response usage, and removal of transport error text and authentication from provider results.

Production structured calls use `HttpsStructuredEndpointTransport`. Its injected trusted runner resolver maps only an opaque endpoint ID to an exact bounded value outside repository configuration:

```json
{
  "schemaVersion": "model-endpoint-resolution/v1",
  "endpointId": "customer-private-model-endpoint",
  "url": "https://models.customer.example/structured-agent",
  "timeoutMs": 30000,
  "maxRequestBytes": 128000,
  "maxResponseBytes": 128000
}
```

The transport accepts HTTPS only, rejects embedded URL credentials and fragments, caps request and response bodies at 1 MiB and timeouts at two minutes, and does not follow redirects. Its versioned JSON body contains the validated stage request, selected route, and reserved maximum cost. The ephemeral stage credential is sent only as a bearer authorization header. Connection, timeout, HTTP, body-size, content-type, and JSON failures are classified without copying locators, authentication, response bodies, headers, or underlying error text into provider results. Tests inject the HTTP client and resolver, so no network access or permanent credential is required.

Production stage credentials can be supplied by `TrustedRunnerModelStageCredentialSource`. Its trusted resolver takes no repository-controlled arguments and returns an exact `model-credential-exchange-resolution/v1` containing the HTTPS exchange URL, expected runner issuer and audience, timeout, and request/response limits. A separate injected identity source receives only the derived test/build stage, hashed repository/specification scope, and those trusted issuer/audience values, then returns an exact `trusted-runner-identity/v1`. The assertion is sent only in the exchange authorization header; the bounded exchange body contains its non-secret claims. The exact response must be a `model-stage-credential/v1` for the requested stage and scope with a lifetime no longer than fifteen minutes. Unsupported identity claims, protocols, redirects/statuses, oversized payloads, malformed responses, and scope mismatches fail closed with sanitized retry classifications. No assertion, locator, authorization header, or returned secret enters a model request, usage, rationale, attempt record, or error. Deterministic tests inject all identity, resolution, and HTTPS behavior without network access, a live identity provider, a model API, or permanent credentials.

Customer-controlled production runners compose these boundaries with `createTrustedRunnerStructuredProvider`. The runner owns the exact configuration value; do not load it from the checkout or `.ai/improver.yml`:

```json
{
  "schemaVersion": "trusted-runner-structured-provider-configuration/v1",
  "budgets": {
    "dailyLimitUsd": 5,
    "stages": {
      "test": { "limitUsd": 2.5, "reservationUsd": 1 },
      "build": { "limitUsd": 2.5, "reservationUsd": 1 }
    }
  },
  "retryPolicy": { "maxAttempts": 2, "delaysMs": [1000] },
  "routingPolicy": {
    "schemaVersion": "model-routing-policy/v1",
    "routes": {
      "lower": {
        "test": { "id": "test-lower", "provider": "customer", "model": "model-v1" },
        "build": { "id": "build-lower", "provider": "customer", "model": "model-v1" }
      },
      "higher": {
        "test": { "id": "test-higher", "provider": "customer", "model": "test-model-v2" },
        "build": { "id": "build-higher", "provider": "customer", "model": "build-model-v2" }
      }
    }
  },
  "endpointPolicy": {
    "schemaVersion": "model-endpoint-policy/v1",
    "endpoints": [{
      "id": "customer-private-endpoint",
      "routeIds": ["test-lower", "build-lower", "test-higher", "build-higher"],
      "capabilities": {
        "protocol": "structured-agent/v1",
        "stages": ["test", "build"],
        "authentication": "ephemeral-credential",
        "costLimit": "maximum-cost-usd"
      }
    }]
  }
}
```

The runner must inject its endpoint resolver, trusted identity source, and no-argument credential-exchange resolver. It may also inject its HTTPS client, clock, cost state, and retry timing. Repository content is never consulted for those dependencies, endpoint locators, issuer/audience claims, assertions, or credentials. The ordinary `daily-improver run` command remains command-backed for local proving and does not read this production configuration. `test/trusted-runner-structured-provider.test.ts` is the executable no-network composition example: it proves separate test/build identity, exchange, credential, and endpoint acquisition and the fail-closed cross-stage, cross-scope, and cross-endpoint cases.

An opt-in customer-runner proof exercises the MoneyAllocator fixture through that production composition without entering `npm test` or `npm run checkpoint`. It requires an explicitly selected `skip` or `require` mode and loads policy and resolutions only from absolute runner-owned paths. In `require` mode, missing configuration or distinct short-lived test/build identity assertions fail before any network call; `skip` mode reports an intentional skip when configuration is absent. The live structured endpoint must be runner-side and bound out-of-band to the dedicated workspace because the protected wire protocol does not serialize a host checkout path. See [`docs/live-model-integration.md`](docs/live-model-integration.md) for the exact invocation and trust contract.

For a simpler developer proof, `OpenAiResponsesAgentProvider` calls the OpenAI Responses API directly from the disposable local runner worktree. It reads only bounded allowlisted source and detected test-harness files, excludes protected test inputs from the builder, sends no host path, treats source as untrusted prompt data, requests strict Structured Outputs, validates every returned path and complete replacement body, and prepares atomic writes only after the whole response passes policy. Runner-owned requirements describe the exact test loading contract without trusting repository instructions. A defect baseline is accepted only when its classified failure is behavioral rather than syntax, resource, dependency, or autoload failure. The API key stays inside the HTTPS client authorization header; unsuccessful API responses retain only the HTTP status and a bounded machine error code. The opt-in `npm run test:openai-live` command is excluded from `npm test` and `npm run checkpoint`, loads `OPENAI_API_KEY` from the ignored `.daily-improver/openai.env` file when present, and caps each stage at an estimated `$0.25`. See [`docs/openai-local-proof.md`](docs/openai-local-proof.md).

Run artifacts are written to `.ai/runs/<date>/`. The repository interface is [`.ai/improver.yml`](.ai/improver.yml). A setup-PR payload lives in [`templates/setup`](templates/setup), including the four-job Actions workflow.

Analysis and planning require `DAILY_IMPROVER_UNRESOLVED_FINDING_STATE_PATH` to point to a trusted `unresolved-finding-state/v1` JSON artifact supplied by the control-plane/GitHub boundary, and `DAILY_IMPROVER_REPOSITORY_SCOPE` to contain its matching external repository scope:

```json
{
  "schemaVersion": "unresolved-finding-state/v1",
  "repositoryId": "<sha256-of-trusted-repository-scope>",
  "observedAt": "2026-07-17T05:00:00.000Z",
  "findingIds": ["<64-character-lowercase-sha256>"]
}
```

The exact-schema artifact is limited to 1,000 unique finding IDs and 80,000 bytes, expires after fifteen minutes, and should be mounted read-only outside the repository. Missing, malformed, oversized, stale, future-dated, or cross-repository state fails closed. A finding ID is SHA-256 over the JSON tuple `["candidate-deduplication/v1", kind, subsystem, defect]`; candidates without that semantic contract use `["candidate-id/v1", kind, id]`. Only the hash crosses the state boundary. Matching candidates receive a deterministic `unresolved-finding` exclusion, and selection continues with the highest-ranked unmatched bounded candidate.

Before creating a specification, Daily Improver atomically claims the canonical repository identity for its UTC day in local state. An active plan or completed publication request blocks another specification and publication for that repository until the next UTC date; a different repository remains independent. Candidate rejection and oversized human-task routing do not consume the daily claim, and a policy-rejected plan releases it. The versioned `daily-improvement-decision/v1` artifact records the claim and its completed publication transition without retaining the repository path.

Specification also requires `DAILY_IMPROVER_OPEN_PR_STATE_PATH` to point to a trusted `open-pull-request-state/v1` JSON artifact supplied by the control-plane/GitHub boundary, and `DAILY_IMPROVER_REPOSITORY_SCOPE` to carry the matching trusted external repository scope (for example `github:123456789`):

```json
{
  "schemaVersion": "open-pull-request-state/v1",
  "repositoryId": "<sha256-of-trusted-repository-scope>",
  "observedAt": "2026-07-17T05:00:00.000Z",
  "openPullRequests": 2
}
```

The artifact must be no more than fifteen minutes old, repository-bound, exact-schema, and contain an integer count from 0 through 10,000. It should live outside the repository and be mounted read-only for the CLI. The source accepts a 1–256 character bounded repository scope, hashes it, and requires it to match `repositoryId`, so identical `/repo` container mounts cannot collapse repository identities. Missing scope or state, malformed or non-regular input, oversized, stale, future-dated, negative, fractional, unbounded, or cross-repository state fails closed. When the count meets or exceeds repository-owned `limits.max_open_prs` (itself bounded from 1 through 1,000), planning stops before the daily claim and specification. The resulting `open-pull-request-limit-decision/v1` records only the bounded state and decision. The injected state source performs no network access; `analyse` and oversized/candidate-only rejection do not read it.

## Pipeline

1. `analyse` observes tool output and repository signals, rejects candidates without reproducible bounded evidence, deduplicates and ranks semantic findings, filters fresh repository-scoped unresolved matches, and selects exactly one bounded candidate. Every candidate removed before autonomous selection receives one deterministic `candidate-exclusion/v2` record. A credible candidate beyond repository file or line limits is excluded from autonomous work and may produce one `human-task-recommendation/v1` summary.
2. `specify` first enforces the fresh repository-bound open-PR limit, then acquires the repository/day claim and converts the candidate into a bounded contract with an allowlist, invariants, preservation rules, exclusions, and diff/cost limits.
3. `test` seals generated regression, characterization, and property tests in an HMAC manifest.
4. `build` invokes an isolated builder provider using only the approved inputs.
5. `verify` checks test integrity, protected paths, allowlists, diff limits, and repository verification commands from a fresh checkout.
6. `publish` completes the active repository/day claim and emits one publication request for the GitHub App to turn into a draft PR.

## PHP evidence

The PHP adapter directly runs trusted Composer, static-analysis, test-coverage, mutation-analysis, and complexity commands with timeouts and bounded output capture. Repository scripts and plugins cannot replace these command definitions. It runs `composer validate --no-interaction --no-plugins` and `composer audit --format=json --no-interaction --no-plugins`; validation errors and warnings become normalized candidates, while audit output from legacy Composer releases through Composer 2.10 is normalized by its JSON content rather than version-specific numeric exit codes.

Every executed collector records versioned, persistable provenance alongside its command result: a bounded tool version, the direct version command, and a deterministic hash of only its allowlisted configuration inputs. Individual configuration inputs are recorded as hashed, absent, unreadable, or oversized without retaining their content. Missing or malformed version output and unreadable or oversized configuration fail closed before the evidence command runs; raw version and configuration output is never persisted.

Every rankable candidate carries the language-neutral `candidate-reproducibility/v1` contract: an explicit reproducible status, a bounded strength from greater than zero through one, and one to eight bounded provenance entries. Candidates with absent or unbounded evidence, a missing or non-reproducible contract, invalid strength, or missing or unbounded provenance are rejected before deduplication and scoring. Analysis fails closed when no candidate qualifies.

Candidates may also carry the language-neutral `candidate-deduplication/v1` identity: a bounded subsystem and a materially distinct defect. Candidates with the same subsystem and defect are reduced before scoring. The candidate with the strongest reproducible evidence is preserved intact with deterministic tie-breaking, while different defects in the same subsystem remain independently rankable. Candidates without that semantic identity are deduplicated only when their stable candidate IDs match.

The core scores every language-neutral candidate kind with an exhaustive category-specific weight table. Evidence strength, impact, confidence, and testability increase a score; effort, estimated diff, change risk, and subsystem risk reduce it. Unit-interval factors and integer diff estimates from 1 through the bounded 10,000-line observation ceiling are required; missing, non-finite, fractional, or out-of-range inputs fail closed before deduplication and scoring. The relative weights reflect the category without encoding PHP or framework knowledge, and equal scores are resolved by stable candidate ID.

Every ranked candidate has a `candidate-score-explanation/v1` in deterministic ranking order. The record contains its bounded reference and category, all eight normalized factors, the exhaustive signed category weights, raw weighted contribution, repository-priority influence, optional `0.01` cosmetic-only cap, and final two-decimal score. It contains no evidence, rationale, target, provenance, or source path. The version 5 analysis artifact and planning-run history retain these explanations, including for candidates later routed as oversized or suppressed as unresolved. Replaying an explanation must reproduce its score and ordering exactly; malformed, incomplete, unbounded, extended, incorrectly weighted, or configuration-inconsistent records fail closed before specification.

After ranking, candidate scope is compared with repository-owned `limits.max_changed_files` and `limits.max_diff_lines`. Candidates exactly at both limits remain eligible. Larger credible candidates cannot be specified or built; the highest-ranked one is emitted as a bounded `human-task-recommendation/v1` containing only its stable identity, category, generated title, estimated counts, configured limits, and a generated routing reason. Evidence, rationale, targets, and source paths do not cross into that recommendation. If another bounded candidate remains, it is still selected; an oversized-only plan is persisted as rejected without a specification.

The version 5 analysis artifact and persisted planning runs include deterministically ordered `candidate-exclusion/v2` records for candidates rejected by malformed scope, evidence, scoring, semantic deduplication, oversized autonomous scope, or an unresolved semantic finding match. Each record contains only a bounded candidate reference, an optional valid candidate kind, its reason code, the retained candidate reference when deduplication selected stronger evidence, and the finding hash for an unresolved match. Invalid candidate IDs are replaced by a SHA-256 reference. Raw evidence, provenance, rationale, titles, targets, and source paths are not retained in exclusions. A candidate is assigned exactly one reason at its first failed gate.

Repository configuration may order candidate kinds under `selection.priorities`. Supported values are `test-protection`, `static-analysis`, `mutation-testing`, `property-testing`, `dependency-vulnerability`, `performance`, `maintainability`, and `documentation`; unsupported or duplicate entries make configuration loading fail closed. Earlier entries receive a larger deterministic per-candidate influence, capped at `0.05`, while an empty list preserves category scoring unchanged. Priority never admits a candidate rejected by evidence or scoring bounds, never lifts a cosmetic-only candidate above its cap, and equal priority-adjusted scores still resolve by stable candidate ID.

Candidates may explicitly carry the bounded `candidate-value-classification/v1` contract. A `cosmetic-only` classification caps the weighted score at `0.01`, even when its other factors are strong, while a `substantive` classification leaves category scoring unchanged. Malformed, unsupported, or extended classification values fail closed before ranking; candidates without the optional classification retain the established substantive scoring behavior.

Normalized static-analysis, coverage, mutation-analysis, complexity, duplicate-code, and performance evidence is cached under the ignored `.daily-improver/cache/php-evidence/` runtime directory. A cache hit requires the same relevant PHP sources, canonical trusted command, bounded tool version, relevant configuration hash, evidence schema, and collector-policy version. Only successful or code-finding evidence is reusable; unavailable tools, configuration failures, missing coverage support, timeouts, truncation, malformed output, and infrastructure failures always run again. Cache artifacts are size-limited, contain no raw tool output, and are published atomically under a per-key lock so concurrent analysis cannot expose partial JSON.

When PHPStan or Psalm is declared in `composer.json`, the adapter selects that manifest capability and invokes `vendor/bin/phpstan analyse --error-format=json --no-progress --no-interaction` or `vendor/bin/psalm --output-format=json --no-progress`. Findings retain a normalized repository-relative file, line, rule/identifier, and bounded message. Malformed output, invalid configuration, unavailable tools, timeouts, truncated output, infrastructure failures, and source findings remain distinct outcomes. Persistable evidence retains the schema version, normalized bounded findings, command identity, duration, exit code, byte counts, and full-output hashes rather than raw command output.

When PHPUnit or Pest is declared in `composer.json`, the adapter invokes the selected executable directly with `--coverage-clover` and a fresh trusted temporary output path. Clover artifacts are hashed, size-limited, removed after normalization, and reduced to bounded low-coverage findings for domain files. Missing coverage drivers, configuration failures, malformed or oversized XML, unavailable tools, timeouts, infrastructure failures, clean coverage, and low-coverage findings remain distinct outcomes. Repository-owned Composer scripts are not invoked.

When Infection is declared in `composer.json`, the adapter runs a single-threaded mutation analysis targeted to `app/Domain` and `src`. It mirrors the repository with temporary symlinks, preserves valid repository Infection settings, replaces repository-configured loggers with one trusted full JSON report outside the repository, and removes the mirror after normalization. Escaped and not-covered mutants retain only bounded file, line, mutator, and status fields. Missing coverage support, invalid configuration, malformed or oversized reports, mutation-run infrastructure failures, unavailable tools, timeouts, and clean runs remain distinct outcomes. Repository-owned Composer scripts and logger paths are not invoked.

When `phpmetrics/phpmetrics` is declared in `composer.json`, the adapter invokes `vendor/bin/phpmetrics` directly and writes its JSON report to a fresh trusted temporary path. Set `analysis.php.complexity_tool` in `.ai/improver.yml` to `phpmetrics` to opt in when the package is supplied outside the manifest, `auto` to use manifest detection, or `off` to disable execution. High-complexity symbols retain only bounded symbol, mapped source-file, cyclomatic-complexity, and maintainability-index fields. Malformed or oversized reports, invalid tool configuration, unavailable tools, timeouts, infrastructure failures, and clean runs remain distinct outcomes.

When `sebastian/phpcpd` is declared in `composer.json`, the adapter invokes `vendor/bin/phpcpd` directly against existing `app/` and `src/` roots and writes PMD CPD XML to a fresh trusted temporary path. Set `analysis.php.duplicate_code_tool` in `.ai/improver.yml` to `phpcpd` to opt in when the executable is supplied outside the manifest, `auto` to use manifest detection, or `off` to disable execution. Findings retain bounded repository-relative regions, line ranges, occurrence count, exact-match similarity, line/token size, generated messages, and tool/configuration provenance. Duplicated source bodies and raw report excerpts are discarded. Clean reports, code findings, unsupported inputs, unavailable tooling, configuration failures, timeouts, command or artifact truncation, malformed output, and infrastructure failures remain distinct outcomes; repository-owned Composer scripts are never invoked.

When `phpcompatibility/php-compatibility` is declared in `composer.json`, the adapter invokes `vendor/bin/phpcs` directly with the `PHPCompatibility` standard, JSON output, and an explicit PHP target resolved from `config.platform.php` or the root PHP requirement. Only deprecated or removed API findings are retained, with repository-relative file, line, sniff rule, symbol, bounded message, and replacement guidance when the tool reports it. Laravel repositories are also checked against the bounded `laravel-deprecation-rules/v1` registry, selected from the installed framework version in `composer.lock` or the root framework constraint. Each Laravel finding records its official upgrade-guide provenance. Unsupported PHP/Laravel versions, unsupported rule coverage, unavailable tooling, configuration failures, timeouts, truncation, malformed output, infrastructure failures, clean output, and code findings remain distinct; unsupported inputs never fall back to model inference.

When PHPUnit or Pest is manifest-detected, the adapter also invokes the executable directly with a trusted temporary `--log-junit` path. Test cases at or above `analysis.php.slow_test_threshold_ms` become performance findings with a repository-relative test file, bounded test identity and message, duration, and configured threshold. The JUnit artifact is size-limited, hashed, normalized, and removed; repository-owned Composer scripts are never used.

Laravel repositories are also inspected with the explicit `php-validation-error-rules/v1` adapter registry. The bounded rules identify request data passed wholesale to `create`, `update`, `fill`, or `forceFill`, empty catch blocks, and broad `Throwable` / `Exception` catches that only return `null`, `false`, or an empty array. Findings retain only a repository-relative file and line, stable rule identity, bounded generated message, rule-set version, and hashed Composer configuration provenance. Comments, strings, and source excerpts are not retained. Clean repositories, findings, unsupported inputs, malformed Composer configuration, oversized or excessive inputs, malformed PHP lexical structure, and infrastructure failures remain distinct outcomes; no repository-owned analysis command or model inference is used.

Laravel slow-query collection is explicitly opt-in. Set `analysis.php.slow_query.mechanism` to `laravel-listener` and configure `threshold_ms`. During the direct test run, Daily Improver supplies `DAILY_IMPROVER_LARAVEL_QUERY_LOG` as a fresh temporary path and `DAILY_IMPROVER_LARAVEL_QUERY_THRESHOLD_MS`. A test-only Laravel service provider or bootstrap listener may use `DB::listen` to write this report contract:

```json
{
  "schemaVersion": "laravel-slow-query-report/v1",
  "queries": [
    {
      "sql": "select * from allocations where account_id = ?",
      "durationMs": 245,
      "file": "app/Repositories/AllocationRepository.php",
      "line": 42
    }
  ]
}
```

The listener must ignore query bindings and write only to the supplied path. The adapter treats the report as untrusted input: it bounds its size and finding count, rejects paths outside `app/` or `src/`, filters against the configured threshold, normalizes SQL literals, and persists only a SHA-256 query fingerprint. Raw SQL, bindings, and query parameters are removed with the temporary report. Disabled/non-Laravel inputs, a missing listener, malformed or oversized reports, unavailable tooling, test configuration failures, timeouts, truncated command output, infrastructure failures, clean output, and findings remain distinct outcomes.

The adapter also consumes machine-readable evidence under `.ai/evidence/`:

- `infection.json`: fallback prepared escaped/not-covered mutations when no manifest-backed Infection runner is detected.
- `clover.xml`: fallback prepared PHPUnit/Pest Clover coverage when no manifest-backed runner is detected; domain files below 50% become test-protection candidates.
- `complexity.json`: fallback prepared per-file complexity evidence when trusted PhpMetrics execution is not detected or configured.
- `TODO` and `FIXME` markers in `app/**/*.php` and `src/**/*.php` as low-priority maintainability evidence.

The end-to-end fixture proves the intended contract: a generated property test fails against the morning baseline, a bounded builder change makes it pass, protected artifacts remain unchanged, semantic safety checks pass, and the verified commit is retained on an `ai/daily/<date>-<description>` branch.

See [`docs/architecture.md`](docs/architecture.md) for delivery and trust boundaries.
