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

Run artifacts are written to `.ai/runs/<date>/`. The repository interface is [`.ai/improver.yml`](.ai/improver.yml). A setup-PR payload lives in [`templates/setup`](templates/setup), including the four-job Actions workflow.

## Pipeline

1. `analyse` observes tool output and repository signals, ranks evidence-backed candidates, and selects exactly one.
2. `specify` converts the candidate into a bounded contract with an allowlist, invariants, preservation rules, exclusions, and diff/cost limits.
3. `test` seals generated regression, characterization, and property tests in an HMAC manifest.
4. `build` invokes an isolated builder provider using only the approved inputs.
5. `verify` checks test integrity, protected paths, allowlists, diff limits, and repository verification commands from a fresh checkout.
6. `publish` emits a publication request for the GitHub App to turn into a draft PR.

## PHP evidence

The PHP adapter directly runs trusted Composer, static-analysis, and test-coverage commands with timeouts and bounded output capture. Repository scripts and plugins cannot replace these command definitions. It runs `composer validate --no-interaction --no-plugins` and `composer audit --format=json --no-interaction --no-plugins`; validation errors and warnings become normalized candidates, while audit output from legacy Composer releases through Composer 2.10 is normalized by its JSON content rather than version-specific numeric exit codes.

When PHPStan or Psalm is declared in `composer.json`, the adapter selects that manifest capability and invokes `vendor/bin/phpstan analyse --error-format=json --no-progress --no-interaction` or `vendor/bin/psalm --output-format=json --no-progress`. Findings retain a normalized repository-relative file, line, rule/identifier, and bounded message. Malformed output, invalid configuration, unavailable tools, timeouts, truncated output, infrastructure failures, and source findings remain distinct outcomes. Persistable evidence retains the schema version, normalized bounded findings, command identity, duration, exit code, byte counts, and full-output hashes rather than raw command output.

When PHPUnit or Pest is declared in `composer.json`, the adapter invokes the selected executable directly with `--coverage-clover` and a fresh trusted temporary output path. Clover artifacts are hashed, size-limited, removed after normalization, and reduced to bounded low-coverage findings for domain files. Missing coverage drivers, configuration failures, malformed or oversized XML, unavailable tools, timeouts, infrastructure failures, clean coverage, and low-coverage findings remain distinct outcomes. Repository-owned Composer scripts are not invoked.

The adapter also consumes machine-readable evidence under `.ai/evidence/`:

- `infection.json`: escaped/not-covered mutations with file, line, mutator, description, and optional invariant.
- `clover.xml`: fallback prepared PHPUnit/Pest Clover coverage when no manifest-backed runner is detected; domain files below 50% become test-protection candidates.
- `complexity.json`: per-file cyclomatic complexity and maintainability index from the configured complexity tool.
- `TODO` and `FIXME` markers in `app/**/*.php` and `src/**/*.php` as low-priority maintainability evidence.

The end-to-end fixture proves the intended contract: a generated property test fails against the morning baseline, a bounded builder change makes it pass, protected artifacts remain unchanged, semantic safety checks pass, and the verified commit is retained on an `ai/daily/<date>-<description>` branch.

See [`docs/architecture.md`](docs/architecture.md) for delivery and trust boundaries.
