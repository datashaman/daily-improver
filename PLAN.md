# Daily Improver Delivery Plan

Status: active

Last updated: 2026-07-17

Current phase: Phase 1 — portable PHP/Laravel CLI proving loop

## Current checkpoint

The live implementation checkpoint is maintained in [`docs/STATUS.md`](docs/STATUS.md). At this checkpoint:

- Phase 1 foundation and the deterministic PHP/Laravel proving loop are complete.
- Phase 1A is complete; the bounded runner plus Composer, static-analysis, PHPUnit/Pest coverage and timing, targeted Infection, configured PhpMetrics and PHPCPD, version-aware PHP/Laravel deprecation, opt-in Laravel slow-query, versioned Laravel validation/error-handling, language-neutral candidate deduplication, and reproducible-evidence gate are implemented.
- Phase 1B category-specific scoring weights are implemented for every language-neutral candidate kind.
- Executed PHP evidence now carries bounded tool-version and relevant-configuration provenance.
- Expensive normalized PHP evidence is cached against relevant source, trusted command, tool-version, configuration, schema, and collector-policy inputs.
- The exact next task is scoring candidate evidence strength and testability alongside the existing bounded factors.
- A context clear is safe only after `docs/STATUS.md` is current, verification passes, the checkpoint is committed, and the working tree is clean.

Agents must update `docs/STATUS.md` as work progresses; this plan records durable direction rather than transient implementation state.

## Product objective

Build a language-neutral continuous codebase improvement system that opens one independently verified draft PR every day.

PHP/Laravel is the first proving adapter, not the product boundary. The portable CLI is the core product. GitHub Apps and GitHub Actions are its first delivery mechanism, while GitLab, local execution, and customer-hosted deployment remain possible later.

## Non-negotiable principles

- Select exactly one evidence-backed, bounded improvement per run.
- Require independent proof that the proposed change is an improvement.
- Keep orchestration language-neutral and ecosystem knowledge inside adapters.
- Treat specifications, generated tests, policies, and verification artifacts as protected inputs.
- Separate observer, test-agent, builder, verifier, and publisher trust boundaries.
- Execute source-aware work only on GitHub-hosted or customer-controlled runners.
- Do not clone, execute, or retain customer source code in the hosted control plane.
- Use short-lived, stage-scoped credentials.
- Start every PR as a draft.
- Fail closed when a required safety gate cannot run.
- Keep learned preferences separate from mandatory safety policy.

## Completed foundation

- [x] Language-neutral TypeScript orchestration core
- [x] Repository adapter and capability contracts
- [x] PHP/Laravel adapter and project detection
- [x] Capability detection for tests, linting, static analysis, mutation testing, coverage, and property testing
- [x] Candidate ranking and bounded specification generation
- [x] Repository-owned `.ai/improver.yml` configuration
- [x] Cost, diff, and test-protection policies
- [x] JSON run history
- [x] HMAC-protected test and specification manifests
- [x] Git worktree isolation
- [x] Command-backed test and builder agent provider
- [x] PHP evidence readers for Infection, PHPStan, Clover coverage, complexity, and TODOs
- [x] Test-first baseline proof for correctness candidates
- [x] Semantic checks for static-analysis suppressions, broad exception swallowing, public API additions, and trivial property tests
- [x] Verified daily branch and draft-PR request generation
- [x] Laravel-shaped end-to-end MoneyAllocator defect fixture
- [x] Containerized CLI
- [x] Initial four-job GitHub Actions setup template
- [x] Architecture documentation and ADR

## Known gaps

- Agent implementations are command-backed; no first-class model provider exists.
- The Laravel proof uses a controlled fixture rather than a real application.
- Local verification uses an isolated worktree rather than genuinely separate CI runners.
- `publish` emits a request artifact but does not push or open a PR.
- The setup workflow references the not-yet-built `daily-improver-auth` helper.
- The container is not published to GHCR.
- Review outcomes do not yet influence candidate ranking.
- PHP is the only real ecosystem adapter.
- The GitHub App and hosted control plane do not exist.

---

## Phase 1A — Real PHP observer

Goal: make `analyse` generate and normalize its own evidence.

- [x] Add an evidence-runner contract with timeouts and resource limits.
- [x] Run `composer validate`.
- [x] Run `composer audit --format=json`.
- [x] Run PHPStan or Psalm with machine-readable output.
- [x] Run PHPUnit or Pest with Clover coverage.
- [x] Run targeted Infection analysis.
- [x] Run a configured complexity tool.
- [x] Record command, tool version, duration, exit code, output hash, and relevant configuration hash.
- [x] Normalize tool output into stable internal findings.
- [x] Distinguish unavailable tools, configuration failures, code findings, infrastructure failures, and timeouts.
- [x] Cache expensive evidence when relevant source and configuration have not changed.
- [x] Prevent repository configuration from silently replacing trusted commands.
- [x] Add collectors for deprecated PHP/Laravel APIs.
- [x] Add dependency-vulnerability findings.
- [x] Add slow-test and slow-query findings.
- [x] Add duplicate-code findings.
- [x] Add missing-validation and error-handling findings.
- [x] Deduplicate overlapping findings against the same subsystem.
- [x] Reject candidates without reproducible evidence.

Exit gate: `daily-improver analyse` produces credible ranked candidates on a real Laravel repository without manually prepared `.ai/evidence` files.

## Phase 1B — Deterministic candidate selection

Goal: make selection predictable, bounded, and explainable.

- [x] Add category-specific scoring weights.
- [ ] Include evidence strength, confidence, likely impact, estimated effort, estimated diff, subsystem risk, and testability.
- [ ] Score cosmetic-only changes near zero.
- [ ] Apply repository priority configuration.
- [ ] Enforce exactly one candidate per run.
- [ ] Detect candidates too large for autonomous work and emit a human-task recommendation.
- [ ] Add exclusion reasons to rejected candidates.
- [ ] Enforce one improvement PR per repository per day.
- [ ] Respect `max_open_prs`.
- [ ] Prevent repeated selection of the same unresolved finding.
- [ ] Make ties deterministic.
- [ ] Include a machine-readable score explanation.

Exit gate: repeated analysis against unchanged code produces the same candidate and a clear explanation.

## Phase 1C — Structured model agent providers

Goal: replace generic shell delegation with a versioned agent protocol.

- [ ] Define versioned test-agent request and response schemas.
- [ ] Define versioned builder request and response schemas.
- [ ] Send only the approved spec, allowlist, necessary context, commands, and conventions.
- [ ] Add the first model-backed provider.
- [ ] Track model, token usage, latency, and estimated cost.
- [ ] Enforce per-stage and daily cost budgets before requests.
- [ ] Retry only classified transient failures.
- [ ] Reject malformed or incomplete responses.
- [ ] Store model rationale separately from trusted evidence.
- [ ] Use separate short-lived credentials for test and builder agents.
- [ ] Add deterministic provider replay fixtures.
- [ ] Add model routing based on task complexity.
- [ ] Keep the provider interface compatible with private customer endpoints.

Exit gate: the MoneyAllocator fixture passes with a real model provider rather than the scripted proving agent.

## Phase 1D — Generated-test quality

Goal: prove that generated tests are meaningful and cannot be weakened by the builder.

- [ ] Classify candidates as defect, refactor, performance, or maintainability work.
- [ ] Require defect regression tests to fail against main.
- [ ] Require refactor characterization tests to pass before and after.
- [ ] Require property tests to execute a meaningful generated input space.
- [ ] Require property tests to exercise the selected target and invariant.
- [ ] Require the relevant test to fail under a known mutation where applicable.
- [ ] Detect tests that merely restate implementation details.
- [ ] Detect deleted, skipped, weakened, or newly flaky tests.
- [ ] Detect reduced assertion counts and broadened tolerances.
- [ ] Record test command, baseline output, duration, and hashes.
- [ ] Add Pest-specific quality inspection.
- [ ] Add PHPUnit-specific quality inspection.
- [ ] Add Eris-specific property-test inspection.
- [ ] Quarantine flaky candidates instead of generating a PR.

Exit gate: generated tests demonstrate an observable difference between defective and corrected behavior.

## Phase 1E — Builder isolation

Goal: prevent unauthorized changes rather than only detecting them afterward.

- [ ] Give the builder a strict filesystem allowlist.
- [ ] Make sealed tests, specifications, policies, workflows, and migrations read-only.
- [ ] Remove test-agent and analysis-agent credentials from the builder environment.
- [ ] Disable outbound networking by default.
- [ ] Block dependency installation unless explicitly approved.
- [ ] Prevent symlink and path-traversal escapes.
- [ ] Limit CPU, memory, disk, output, and wall-clock duration.
- [ ] Capture filesystem state before and after execution.
- [ ] Fail immediately when protected content changes.
- [ ] Prevent commits, pushes, and PR operations inside the builder.
- [ ] Prevent generated output from altering the verifier.

Exit gate: the builder cannot modify protected files even when explicitly instructed to do so.

## Phase 1F — Production verifier

Goal: authorize publication only from a clean, independent environment.

- [ ] Verify from a fresh checkout based on the expected main SHA.
- [ ] Confirm main has not advanced before publication.
- [ ] Apply the patch without reusing the builder workspace.
- [ ] Validate all artifact signatures and hashes.
- [ ] Run repository commands in a clean environment.
- [ ] Run targeted mutation testing against changed production files.
- [ ] Compare mutation score to baseline.
- [ ] Compare static-analysis findings to baseline.
- [ ] Compare public API surfaces with an ecosystem tool.
- [ ] Detect new ignored static-analysis findings.
- [ ] Detect broad exception swallowing.
- [ ] Detect weakened validation.
- [ ] Detect deleted, skipped, or weakened tests.
- [ ] Detect accidental dependency, migration, workflow, and generated-binary changes.
- [ ] Scan the patch for secrets.
- [ ] Enforce file and line limits.
- [ ] Enforce spec allowlists and exclusions.
- [ ] Verify that the implementation matches the stated objective.
- [ ] Produce a signed `verification.json`.
- [ ] Fail closed when a required verifier is unavailable.

Exit gate: only the fresh verifier can authorize publication.

## Phase 1G — Real Laravel dogfood

Goal: demonstrate repeated mergeable improvements on a real repository.

- [ ] Select a repository with meaningful domain logic, PHPUnit/Pest, PHPStan, and manageable CI duration.
- [ ] Establish baseline health and known failures.
- [ ] Run analysis-only mode for several days.
- [ ] Review candidate quality manually.
- [ ] Enable test/spec generation without building.
- [ ] Review generated tests manually.
- [ ] Enable builder and verifier locally.
- [ ] Produce draft branches without publishing.
- [ ] Compare generated patches with human solutions.
- [ ] Enable draft PR creation.
- [ ] Require human review and merge.
- [ ] Record false positives, rejected candidates, review changes, and reversions.
- [ ] Tune operating limits conservatively.
- [ ] Complete at least ten credible runs.
- [ ] Merge several improvements without a safety incident.

Exit gate: the loop consistently produces reviewable, mergeable PRs on real Laravel code.

---

## Phase 2A — Production container and GitHub Action

- [ ] Publish versioned multi-architecture images to GHCR.
- [ ] Generate an SBOM.
- [ ] Sign images and verify signatures in workflows.
- [ ] Pin dependencies and GitHub Actions by immutable SHA.
- [ ] Add release automation and changelogs.
- [ ] Add image vulnerability scanning.
- [ ] Make every CLI stage resumable.
- [ ] Give artifacts explicit versioned schemas.
- [ ] Add artifact size and retention limits.
- [ ] Add workflow concurrency controls.
- [ ] Cancel stale runs when main advances.
- [ ] Add bounded stage retry.
- [ ] Publish check-run summaries.
- [ ] Replace every placeholder in the setup workflow.
- [ ] Test GitHub-hosted and self-hosted runners.

Exit gate: a repository runs the complete workflow from a released image without local installation.

## Phase 2B — OIDC authentication

- [ ] Build `daily-improver-auth`.
- [ ] Request the GitHub workflow OIDC token.
- [ ] Validate issuer, audience, repository, owner, workflow, ref, job/environment, and lifetime.
- [ ] Exchange workflow identity for a short-lived stage credential.
- [ ] Scope credentials to one installation, repository, run, and stage.
- [ ] Issue distinct credentials for analysis, testing, building, and verification.
- [ ] Rotate manifest-signing keys per run.
- [ ] Prevent cross-stage credential use.
- [ ] Add replay protection.
- [ ] Record credential issuance in the audit trail.
- [ ] Avoid permanent Daily Improver repository secrets.

Exit gate: Actions authenticates without a long-lived product API key.

## Phase 2C — GitHub App

- [ ] Register the App with minimal permissions.
- [ ] Implement installation and repository selection.
- [ ] Store installation and repository metadata.
- [ ] Generate setup PR contents.
- [ ] Open a human-reviewed setup PR.
- [ ] Process installation, repository, workflow, check, PR, review, and merge webhooks.
- [ ] Validate webhook signatures and delivery IDs.
- [ ] Dispatch repository workflows.
- [ ] Have the workflow token push the verified branch.
- [ ] Have the App identity open the draft PR.
- [ ] Add labels, structured body, and verification links.
- [ ] Avoid workflow-write permission.
- [ ] Handle suspension and permission changes.
- [ ] Handle renamed, transferred, archived, and deleted repositories.
- [ ] Add dispatch and publication idempotency.

Exit gate: install App, merge setup PR, and receive a verified draft PR.

## Phase 2D — Thin hosted control plane

- [ ] Installation and repository registry
- [ ] Timezone-aware scheduler
- [ ] Workflow dispatch
- [ ] Run-state machine
- [ ] Short-lived credential issuance
- [ ] Usage and cost metering
- [ ] Model routing
- [ ] Candidate history
- [ ] Review and merge feedback
- [ ] Configuration UI
- [ ] Webhook processing
- [ ] Audit events
- [ ] Data-retention and deletion controls
- [ ] Operational dashboards and alerts
- [ ] Rate limits and abuse controls
- [ ] Idempotent jobs and retry policy
- [ ] Dead-letter handling

The control plane must not clone repositories, install dependencies, retain source code, execute tests, or run builders.

Exit gate: the service coordinates work without becoming a source-code execution or storage platform.

## Phase 2E — Scheduling and operating limits

- [ ] Interpret repository timezone and configured execution time.
- [ ] Handle daylight-saving transitions.
- [ ] Ensure one dispatch per intended local day.
- [ ] Add manual dispatch, pause, and resume controls.
- [ ] Enforce one PR per repository per day.
- [ ] Count open AI PRs before dispatch.
- [ ] Skip unhealthy main branches.
- [ ] Skip when another improvement run is active.
- [ ] Back off after repeated failures.
- [ ] Pause after reversions or security findings.
- [ ] Support quiet periods.
- [ ] Add organization-wide cost caps.

Exit gate: scheduling is deterministic, bounded, and safe across timezones.

## Phase 2F — PR lifecycle

- [ ] Create every PR as a draft.
- [ ] Include evidence, spec, verification, risk, and cost.
- [ ] Link exact workflow and check runs.
- [ ] Rebase or discard when main moves.
- [ ] Process review comments as future constraints.
- [ ] Allow one bounded revision cycle.
- [ ] Reverify revisions from scratch.
- [ ] Promote from draft only after every gate passes.
- [ ] Close stale or superseded proposals.
- [ ] Record merged, rejected, closed, and reverted outcomes.
- [ ] Detect reverts automatically.
- [ ] Keep auto-merge disabled initially.

Exit gate: every proposed change has a complete, auditable lifecycle.

## Phase 2G — Continuous learning

- [ ] Introduce a durable outcome schema.
- [ ] Store candidate category, evidence, score, model, cost, diff, review changes, outcome, and timing.
- [ ] Cautiously boost historically successful categories.
- [ ] Penalize frequently rejected patterns.
- [ ] Convert review comments into repository constraints.
- [ ] Store reverted changes as negative examples.
- [ ] Detect repeated subsystem findings.
- [ ] Escalate repeated findings into human-designed tasks.
- [ ] Keep safety policy independent from learned preference.
- [ ] Make ranking adjustments explainable.
- [ ] Support resetting learned preferences.
- [ ] Measure candidate precision rather than raw PR volume.

Exit gate: historical outcomes improve selection quality without weakening safety.

## Phase 2H — Public beta readiness

- [ ] Complete a threat model.
- [ ] Commission an external security review.
- [ ] Publish privacy policy and terms.
- [ ] Document data flows and retention.
- [ ] Implement installation deletion.
- [ ] Add backup and disaster recovery.
- [ ] Write operational runbooks.
- [ ] Establish support and escalation processes.
- [ ] Define usage and billing boundaries.
- [ ] Add a status page.
- [ ] Build App onboarding and configuration validation.
- [ ] Publish example policy packs.
- [ ] Document common failures and recovery.
- [ ] Measure merge rate, revert rate, cost per merged PR, verifier rejection rate, and time to merge.

Exit gate: a small external cohort can install and operate the product safely.

---

## Phase 3 — Additional ecosystem adapters

Recommended order:

1. TypeScript/Node
2. Python
3. Go
4. Rust
5. Java

Each adapter must include:

- [ ] Project and monorepo detection
- [ ] Dependency installation
- [ ] Tests
- [ ] Formatting and linting
- [ ] Static analysis
- [ ] Coverage
- [ ] Property testing
- [ ] Mutation testing
- [ ] Framework conventions
- [ ] Failure classification
- [ ] Public API detection
- [ ] Test-quality analysis
- [ ] Evidence normalization
- [ ] End-to-end defective fixture
- [ ] Real-repository dogfood period

Framework packages extend language packages. Likely early packages include React, Next.js, Django, and FastAPI.

Exit gate: each ecosystem independently meets the same evidence and verification standard as PHP.

## Phase 3B — Monorepos

- [ ] Detect multiple manifests.
- [ ] Build a repository component graph.
- [ ] Select one component per run.
- [ ] Resolve component-specific commands.
- [ ] Account for cross-package dependencies.
- [ ] Limit affected workspaces.
- [ ] Run impacted tests plus required integration tests.
- [ ] Prevent component adapters from owning the repository globally.
- [ ] Support mixed-language verification.
- [ ] Apply organization and root policies over component policies.

Exit gate: one bounded improvement safely targets one component in a mixed monorepo.

## Phase 4 — Enterprise

- [ ] Self-hosted runner support
- [ ] Private model endpoints
- [ ] SSO
- [ ] RBAC
- [ ] Organization policy inheritance
- [ ] Central budgets
- [ ] Approval gates
- [ ] Repository groups
- [ ] Audit export
- [ ] SIEM integration
- [ ] Customer-managed encryption
- [ ] Regional control-plane deployment
- [ ] Data-retention controls
- [ ] Air-gapped or customer-hosted control plane
- [ ] Custom policy plugins
- [ ] Compliance evidence
- [ ] SLA and enterprise support

---

## Immediate implementation sequence

The recent and next commit-sized milestones are:

1. [x] `feat: reject candidates without reproducible evidence`
2. [x] `feat: add category-specific scoring weights`
3. [ ] `feat: score candidate evidence and testability`
4. [ ] `feat: add structured model agent provider`

The immediate next task is Phase 1B: include evidence strength, estimated diff, subsystem risk, and testability in deterministic scoring.

## Initial operating limits

```yaml
daily_improvement:
  max_prs_per_day: 1
  max_open_ai_prs: 3
  max_changed_files: 5
  max_diff_lines: 250
  require_tests: true
  allow_dependencies: false
  allow_migrations: false
  allow_public_api_changes: false
  allow_ci_changes: false
  draft_by_default: true
```

These defaults remain restrictive until real-repository dogfooding provides evidence that any limit can safely change.
