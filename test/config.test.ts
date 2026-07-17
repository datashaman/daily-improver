import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("loads the repository-owned versioned product configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-config-"));
  await mkdir(join(root, ".ai"));
  await writeFile(join(root, ".ai", "improver.yml"), `version: 1
schedule: { timezone: Africa/Johannesburg, time: "05:00" }
selection: { priorities: [property-testing] }
analysis:
  php:
    complexity_tool: phpmetrics
    duplicate_code_tool: phpcpd
    slow_test_threshold_ms: 750
    slow_query: { mechanism: laravel-listener, threshold_ms: 125 }
limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 3, max_cost_usd: 4 }
protected_paths: [tests/Property/**]
verification: { commands: [vendor/bin/phpunit], mutation_testing: targeted }
pull_request: { draft: true, labels: [ai-improvement] }
`);
  const config = await loadConfig(root);
  assert.equal(config.schedule.timezone, "Africa/Johannesburg");
  assert.equal(config.limits.max_diff_lines, 250);
  assert.deepEqual(config.verification.commands, ["vendor/bin/phpunit"]);
  assert.equal(config.analysis.php.complexity_tool, "phpmetrics");
  assert.equal(config.analysis.php.duplicate_code_tool, "phpcpd");
  assert.equal(config.analysis.php.slow_test_threshold_ms, 750);
  assert.deepEqual(config.analysis.php.slow_query, { mechanism: "laravel-listener", threshold_ms: 125 });
  assert.deepEqual(config.selection.priorities, ["property-testing"]);
});

test("rejects unsupported and duplicate candidate priorities", async () => {
  for (const priorities of ["[correctness]", "[static-analysis, static-analysis]"]) {
    const root = await mkdtemp(join(tmpdir(), "daily-improver-config-"));
    await mkdir(join(root, ".ai"));
    await writeFile(join(root, ".ai", "improver.yml"), `version: 1
schedule: { timezone: UTC, time: "05:00" }
selection: { priorities: ${priorities} }
limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 3, max_cost_usd: 4 }
protected_paths: []
verification: { commands: [], mutation_testing: targeted }
pull_request: { draft: true, labels: [] }
`);

    await assert.rejects(loadConfig(root), /selection\.priorities contains (unsupported|duplicate) candidate kind/);
  }
});

test("rejects unbounded PHP performance configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-config-"));
  await mkdir(join(root, ".ai"));
  await writeFile(join(root, ".ai", "improver.yml"), `version: 1
schedule: { timezone: UTC, time: "05:00" }
selection: { priorities: [] }
analysis: { php: { slow_test_threshold_ms: 600001, slow_query: { mechanism: shell-command } } }
limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 3, max_cost_usd: 4 }
protected_paths: []
verification: { commands: [], mutation_testing: targeted }
pull_request: { draft: true, labels: [] }
`);

  await assert.rejects(loadConfig(root), /slow_test_threshold_ms must be at most 600000/);
});

test("rejects repository-owned slow-query commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-config-"));
  await mkdir(join(root, ".ai"));
  await writeFile(join(root, ".ai", "improver.yml"), `version: 1
schedule: { timezone: UTC, time: "05:00" }
selection: { priorities: [] }
analysis: { php: { slow_query: { mechanism: shell-command } } }
limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 3, max_cost_usd: 4 }
protected_paths: []
verification: { commands: [], mutation_testing: targeted }
pull_request: { draft: true, labels: [] }
`);

  await assert.rejects(loadConfig(root), /slow_query.mechanism must be off or laravel-listener/);
});

test("rejects unsupported duplicate-code tool configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-config-"));
  await mkdir(join(root, ".ai"));
  await writeFile(join(root, ".ai", "improver.yml"), `version: 1
schedule: { timezone: UTC, time: "05:00" }
selection: { priorities: [] }
analysis: { php: { duplicate_code_tool: repository-script } }
limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 3, max_cost_usd: 4 }
protected_paths: []
verification: { commands: [], mutation_testing: targeted }
pull_request: { draft: true, labels: [] }
`);

  await assert.rejects(loadConfig(root), /duplicate_code_tool must be auto, phpcpd, or off/);
});

test("rejects an unbounded open pull request limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-config-"));
  await mkdir(join(root, ".ai"));
  await writeFile(join(root, ".ai", "improver.yml"), `version: 1
schedule: { timezone: UTC, time: "05:00" }
selection: { priorities: [] }
limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 1001, max_cost_usd: 4 }
protected_paths: []
verification: { commands: [], mutation_testing: targeted }
pull_request: { draft: true, labels: [] }
`);

  await assert.rejects(loadConfig(root), /max_open_prs must be at most 1000/);
});
