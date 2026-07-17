import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  assert.equal(profile.capabilities.get("coverage")?.source, "manifest");
  assert.equal(profile.capabilities.get("coverage")?.framework, "pest");
  assert.equal(profile.capabilities.get("mutation-testing")?.framework, "infection");
});

test("ranks missing test protection as the first PHP baseline candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({ require: { php: "^8.3" } }));
  const adapter = new PhpAdapter(successfulEvidenceRunner);
  const candidates = await adapter.discoverCandidates(await adapter.profile(root));
  assert.equal(candidates[0]?.id, "php-test-baseline");
});

test("executes static analysis selected from the detected manifest capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" },
    "require-dev": { "phpstan/phpstan": "^2" },
    scripts: { analyse: "phpstan analyse --error-format=table" },
  }));
  const commands: EvidenceCommand[] = [];
  const runner: EvidenceRunner = {
    async run(command: EvidenceCommand): Promise<EvidenceRun> {
      commands.push(command);
      const stdout = command.identity === "composer.audit"
        ? JSON.stringify({ advisories: [], abandoned: [] })
        : command.identity === "phpstan.analyse"
          ? JSON.stringify({ files: {}, errors: [] })
          : "";
      const status = command.classify({ exitCode: 0, stdout, stderr: "", outputTruncated: false });
      return {
        result: {
          commandIdentity: command.identity,
          command: command.command,
          status,
          durationMs: 1,
          exitCode: 0,
          stdoutHash: "sha256:output",
          stderrHash: "sha256:empty",
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: 0,
          outputLimitBytes: command.maxOutputBytes,
          outputTruncated: false,
        },
        output: { stdout, stderr: "" },
      };
    },
  };
  const adapter = new PhpAdapter(runner);

  await adapter.discoverCandidates(await adapter.profile(root));

  assert.deepEqual(commands.find((command) => command.identity === "phpstan.analyse")?.command, [
    "vendor/bin/phpstan",
    "analyse",
    "--error-format=json",
    "--no-progress",
    "--no-interaction",
  ]);
  assert.equal(commands.some((command) => command.command.includes("repository-owned-analysis-script")), false);
});

test("executes coverage selected from the detected manifest capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" },
    "require-dev": { "phpunit/phpunit": "^12" },
    scripts: { test: "repository-owned-coverage-script" },
  }));
  const commands: EvidenceCommand[] = [];
  const runner: EvidenceRunner = {
    async run(command: EvidenceCommand): Promise<EvidenceRun> {
      commands.push(command);
      if (command.identity === "phpunit.coverage") {
        const outputPath = command.command[command.command.indexOf("--coverage-clover") + 1];
        assert.ok(outputPath);
        await writeFile(outputPath, "<coverage><project></project></coverage>");
      }
      const stdout = command.identity === "composer.audit"
        ? JSON.stringify({ advisories: [], abandoned: [] })
        : "";
      const status = command.classify({ exitCode: 0, stdout, stderr: "", outputTruncated: false });
      return {
        result: {
          commandIdentity: command.identity,
          command: command.command,
          status,
          durationMs: 1,
          exitCode: 0,
          stdoutHash: "sha256:output",
          stderrHash: "sha256:empty",
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: 0,
          outputLimitBytes: command.maxOutputBytes,
          outputTruncated: false,
        },
        output: { stdout, stderr: "" },
      };
    },
  };

  const adapter = new PhpAdapter(runner);
  await adapter.discoverCandidates(await adapter.profile(root));

  const coverageCommand = commands.find((command) => command.identity === "phpunit.coverage");
  assert.equal(coverageCommand?.command[0], "vendor/bin/phpunit");
  assert.equal(coverageCommand?.command.includes("repository-owned-coverage-script"), false);
});

test("executes targeted Infection selected from the detected manifest capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" },
    "require-dev": { "infection/infection": "^0.30" },
    scripts: { mutation: "repository-owned-mutation-script" },
  }));
  await writeFile(join(root, "infection.json5"), JSON.stringify({ source: { directories: ["src"] } }));
  const commands: EvidenceCommand[] = [];
  const runner: EvidenceRunner = {
    async run(command: EvidenceCommand): Promise<EvidenceRun> {
      commands.push(command);
      if (command.identity === "infection.mutation") {
        const configArgument = command.command.find((argument) => argument.startsWith("--configuration="));
        assert.ok(configArgument);
        const config = JSON.parse(await readFile(configArgument.slice("--configuration=".length), "utf8")) as {
          readonly logs: { readonly json: string };
        };
        await writeFile(config.logs.json, JSON.stringify({
          stats: { errorCount: 0, syntaxErrorCount: 0, timeOutCount: 0 },
          escaped: [],
          uncovered: [],
        }));
      }
      const stdout = command.identity === "composer.audit"
        ? JSON.stringify({ advisories: [], abandoned: [] })
        : "";
      const status = command.classify({ exitCode: 0, stdout, stderr: "", outputTruncated: false });
      return {
        result: {
          commandIdentity: command.identity,
          command: command.command,
          status,
          durationMs: 1,
          exitCode: 0,
          stdoutHash: "sha256:output",
          stderrHash: "sha256:empty",
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: 0,
          outputLimitBytes: command.maxOutputBytes,
          outputTruncated: false,
        },
        output: { stdout, stderr: "" },
      };
    },
  };

  const adapter = new PhpAdapter(runner);
  await adapter.discoverCandidates(await adapter.profile(root));

  const mutationCommand = commands.find((command) => command.identity === "infection.mutation");
  assert.equal(mutationCommand?.command[0], "vendor/bin/infection");
  assert.equal(mutationCommand?.command.includes("--filter=app/Domain,src"), true);
  assert.equal(mutationCommand?.command.includes("repository-owned-mutation-script"), false);
});
