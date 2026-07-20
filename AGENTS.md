# Agent Operating Guide

This file is the starting point for every agent working in this repository. Do not rely on prior conversation history.

## Required reading order

1. `AGENTS.md` — operating rules and verification expectations.
2. `docs/STATUS.md` — current checkpoint, exact next task, and known limitations.
3. The relevant section of `PLAN.md` — milestone scope and exit gate.
4. `docs/architecture.md` — product and trust boundaries.
5. Relevant ADRs under `docs/adr/`.
6. `README.md` — CLI and repository-facing behavior.

When these sources disagree, executable tests and current code win, followed by Git history, `docs/STATUS.md`, ADRs, `PLAN.md`, and finally prose in `README.md`.

## Product invariants

- The core orchestration pipeline is language-neutral.
- PHP/Laravel is the first adapter, not a core dependency.
- Select exactly one bounded, evidence-backed candidate per run.
- A generated change is not an improvement until independently verified.
- Defect tests must fail against the baseline and pass after the patch.
- Test-agent artifacts, specifications, policies, and verification inputs are protected from the builder.
- Observer, test agent, builder, verifier, and publisher are separate trust boundaries.
- The hosted control plane must not clone, execute, or retain customer source code.
- Repository execution belongs in customer GitHub Actions or customer-controlled runners.
- Pull requests start as drafts and remain human-reviewed during initial phases.
- Required safety gates fail closed.
- Learned preferences may affect ranking but never weaken policy or verification.

## Repository map

- `src/adapters/` — ecosystem detection, capabilities, evidence normalization, and failure classification.
- `src/agents/` — model/agent provider boundaries.
- `src/core/` — language-neutral selection, specification, policies, isolation flow, and verification.
- `src/infra/` — shell, Git worktree, and persistence implementations.
- `src/domain/` — shared domain model.
- `test/fixtures/` — deterministic defective repositories used to prove full workflows.
- `templates/setup/` — setup-PR payload for customer repositories.
- `.ai/` — this repository's Daily Improver configuration and policies.
- `docs/adr/` — accepted architectural decisions.
- `PLAN.md` — long-term roadmap and milestone exit gates.
- `docs/STATUS.md` — short-lived handoff checkpoint.

Keep files focused and named after their responsibility. Do not introduce catch-all `utils`, `helpers`, `common`, or `misc` modules.

## Development commands

```bash
npm install
npm run check
npm test
npm run checkpoint
docker build -t daily-improver:local .
```

The full test suite should remain well under two minutes and must support concurrent execution from independent worktrees.

Before handing work back:

1. Run the narrowest relevant test while iterating.
2. Update `PLAN.md`, user-facing documentation, and `docs/STATUS.md` as part of the same logical slice.
3. Commit the complete slice once; the repository owner has granted standing authorization for these end-of-slice commits.
4. Run `npm run checkpoint` from the resulting clean tree before declaring the slice complete.
5. Build the container when CLI runtime or production dependencies change.
6. Run `git diff --check`.
7. Inspect `git status` and preserve unrelated user changes.

Use one commit per completed slice. Do not create a separate checkpoint or handoff commit: the implementation, tests, durable plan updates, and current status belong in the slice commit. Because a commit cannot embed its own final hash, identify the last completed slice in `docs/STATUS.md` by its subject as the current checkpoint commit rather than recording a hash. Do not leave a completed slice uncommitted unless verification is failing, the slice is incomplete, unrelated user changes prevent a safe commit, or the user explicitly asks not to commit. If a post-commit checkpoint fails, fix the failure in a follow-up commit and rerun the checkpoint.

## Implementation rules

- Preserve strict TypeScript and avoid `any` in domain paths.
- Use semantic domain types and version external artifact schemas.
- Add an executable example for every new behavior and failure mode.
- Prefer dependency injection at process, filesystem, time, model, and network boundaries.
- Never make tests depend on permanent credentials or live model APIs.
- Keep end-to-end fixtures deterministic and self-contained.
- Treat repository-provided commands as untrusted inputs requiring explicit policy.
- Do not broaden permissions, network access, or credential scope as a convenience.
- Do not implement language-specific behavior in `src/core/`.
- Update documentation when a contract, trust boundary, or user-facing command changes.
- Do not mark a `PLAN.md` item complete until its exit behavior is tested.

## Checkpoint and handoff protocol

`PLAN.md` records durable direction. `docs/STATUS.md` records where work has actually stopped.

At the end of a meaningful milestone or before recommending a context clear:

1. Finish or deliberately revert the active edit.
2. Ensure required tests pass.
3. Update `docs/STATUS.md` with:
   - last completed milestone and checkpoint commit subject;
   - exact next task;
   - current acceptance criteria;
   - known blockers or unresolved decisions;
   - last verification results.
4. Update completed checkboxes in `PLAN.md` only when evidence supports them.
5. Include these checkpoint updates in the single end-of-slice commit under the repository owner's standing authorization.
6. Confirm the working tree is clean.

An agent should proactively tell the user that a clear is safe when all of these are true:

- the current logical change is committed;
- the working tree is clean;
- `npm run checkpoint` passes;
- `docs/STATUS.md` names one exact next task;
- no external process, temporary worktree, migration, or credential operation remains active;
- no decision is waiting only in conversation context.

Do not recommend clearing while code is uncommitted, tests are failing, a workflow is active, a schema transition is half-complete, or an unresolved design decision has not been recorded.

## Resuming after a clear

1. Read the required sources in order.
2. Run `git status --short --branch` and `git log -5 --oneline`.
3. Run the verification command recorded in `docs/STATUS.md`.
4. Confirm that the stated next task still matches the code.
5. Continue from that task without redoing completed milestones.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub at `datashaman/daily-improver`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context root layout with optional `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
