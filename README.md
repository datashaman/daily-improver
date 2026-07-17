# Daily Improver

A language-neutral continuous codebase improvement system that opens one independently verified draft PR every day.

PHP/Laravel is the initial vertical, not the product boundary. The TypeScript core selects adapters from repository signals and works through test, lint, static-analysis, mutation, coverage, property-testing, and formatting capabilities.

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

The first adapter consumes machine-readable evidence under `.ai/evidence/`:

- `infection.json`: escaped/not-covered mutations with file, line, mutator, description, and optional invariant.
- `phpstan.json`: PHPStan JSON output grouped by file.
- `clover.xml`: PHPUnit/Pest Clover coverage; domain files below 50% become test-protection candidates.
- `complexity.json`: per-file cyclomatic complexity and maintainability index from the configured complexity tool.
- `TODO` and `FIXME` markers in `app/**/*.php` and `src/**/*.php` as low-priority maintainability evidence.

The end-to-end fixture proves the intended contract: a generated property test fails against the morning baseline, a bounded builder change makes it pass, protected artifacts remain unchanged, semantic safety checks pass, and the verified commit is retained on an `ai/daily/<date>-<description>` branch.

See [`docs/architecture.md`](docs/architecture.md) for delivery and trust boundaries.
