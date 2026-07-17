import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EvidenceCommand, EvidenceRun, EvidenceRunner } from "../src/contracts.js";
import { PhpAdapter } from "../src/adapters/php.js";

const successfulEvidenceRunner: EvidenceRunner = {
  async run(command: EvidenceCommand): Promise<EvidenceRun> {
    return {
      result: {
        commandIdentity: command.identity,
        command: command.command,
        status: "success",
        durationMs: 1,
        exitCode: 0,
        stdoutHash: "sha256:empty",
        stderrHash: "sha256:empty",
        stdoutBytes: 0,
        stderrBytes: 0,
        outputLimitBytes: command.maxOutputBytes,
        outputTruncated: false,
      },
      output: { stdout: "", stderr: "" },
    };
  },
};

test("detects a Laravel project and maps tools to capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { "laravel/framework": "^12" },
    "require-dev": {
      "pestphp/pest": "^4",
      "larastan/larastan": "^3",
      "laravel/pint": "^1",
      "infection/infection": "^0.30",
    },
  }));
  await writeFile(join(root, "phpunit.xml"), "<phpunit />");

  const profile = await new PhpAdapter(successfulEvidenceRunner).profile(root);
  assert.deepEqual(profile.frameworks, ["laravel"]);
  assert.deepEqual(profile.capabilities.get("test")?.command, ["vendor/bin/pest"]);
  assert.equal(profile.capabilities.get("static-analysis")?.framework, "phpstan");
  assert.equal(profile.capabilities.get("coverage")?.source, "configuration");
});

test("ranks missing test protection as the first PHP baseline candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({ require: { php: "^8.3" } }));
  const adapter = new PhpAdapter(successfulEvidenceRunner);
  const candidates = await adapter.discoverCandidates(await adapter.profile(root));
  assert.equal(candidates[0]?.id, "php-test-baseline");
});
