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
selection: { priorities: [correctness] }
limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 3, max_cost_usd: 4 }
protected_paths: [tests/Property/**]
verification: { commands: [vendor/bin/phpunit], mutation_testing: targeted }
pull_request: { draft: true, labels: [ai-improvement] }
`);
  const config = await loadConfig(root);
  assert.equal(config.schedule.timezone, "Africa/Johannesburg");
  assert.equal(config.limits.max_diff_lines, 250);
  assert.deepEqual(config.verification.commands, ["vendor/bin/phpunit"]);
});
