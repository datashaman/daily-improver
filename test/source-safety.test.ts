import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SourceSafetyInspector } from "../src/core/source-safety.js";
import { CommandRunner } from "../src/infra/command-runner.js";

test("semantic verification rejects new static-analysis suppression", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-source-safety-"));
  const file = join(root, "Service.php");
  const runner = new CommandRunner();
  await runner.run(["git", "init", "-b", "main"], root);
  await runner.run(["git", "config", "user.email", "improver@example.test"], root);
  await runner.run(["git", "config", "user.name", "Daily Improver Test"], root);
  await writeFile(file, "<?php\nfinal class Service {}\n");
  await runner.run(["git", "add", "."], root);
  await runner.run(["git", "commit", "-m", "baseline"], root);
  await writeFile(file, "<?php\n/** @phpstan-ignore-next-line */\nfinal class Service {}\n");
  const report = await new SourceSafetyInspector(runner).inspect(root, "HEAD", []);
  assert.equal(report.allowed, false);
  assert.match(report.violations[0] ?? "", /static-analysis suppression/);
});
