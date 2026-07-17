import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EvidenceCommand, EvidenceRun, EvidenceRunner } from "../src/contracts.js";
import { evidenceStubMetadata } from "./evidence-stub.js";
import { PhpAdapter } from "../src/adapters/php.js";
import { PhpEvidenceCache } from "../src/infra/php-evidence-cache.js";

const successfulEvidenceRunner: EvidenceRunner = {
  async run(command: EvidenceCommand): Promise<EvidenceRun> {
    return {
      result: {
        ...evidenceStubMetadata(command),
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
      "phpmetrics/phpmetrics": "^3",
      "phpcompatibility/php-compatibility": "^10",
      "sebastian/phpcpd": "^6",
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
  assert.equal(profile.capabilities.get("complexity")?.framework, "phpmetrics");
  assert.equal(profile.capabilities.get("complexity")?.source, "manifest");
  assert.equal(profile.capabilities.get("deprecation-analysis")?.framework, "phpcompatibility");
  assert.equal(profile.capabilities.get("duplicate-code")?.framework, "phpcpd");
  assert.equal(profile.capabilities.get("duplicate-code")?.source, "manifest");
});

test("detects explicitly configured PhpMetrics without trusting a repository script", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await mkdir(join(root, ".ai"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" },
    scripts: { complexity: "repository-owned-complexity-script" },
  }));
  await writeFile(join(root, ".ai", "improver.yml"), `version: 1
schedule: { timezone: UTC, time: "05:00" }
selection: { priorities: [maintainability] }
analysis: { php: { complexity_tool: phpmetrics } }
limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 3, max_cost_usd: 5 }
protected_paths: [tests/**]
verification: { commands: [], mutation_testing: targeted }
pull_request: { draft: true, labels: [ai-improvement] }
`);

  const capability = (await new PhpAdapter(successfulEvidenceRunner).profile(root)).capabilities.get("complexity");

  assert.equal(capability?.source, "configuration");
  assert.equal(capability?.framework, "phpmetrics");
  assert.deepEqual(capability?.command, ["vendor/bin/phpmetrics"]);
});

test("detects explicitly configured PHPCPD without trusting a repository script", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await mkdir(join(root, ".ai"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" },
    scripts: { duplicates: "repository-owned-duplicate-script" },
  }));
  await writeFile(join(root, ".ai", "improver.yml"), `version: 1
schedule: { timezone: UTC, time: "05:00" }
selection: { priorities: [maintainability] }
analysis: { php: { duplicate_code_tool: phpcpd } }
limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 3, max_cost_usd: 5 }
protected_paths: [tests/**]
verification: { commands: [], mutation_testing: targeted }
pull_request: { draft: true, labels: [ai-improvement] }
`);

  const capability = (await new PhpAdapter(successfulEvidenceRunner).profile(root)).capabilities.get("duplicate-code");

  assert.equal(capability?.source, "configuration");
  assert.equal(capability?.framework, "phpcpd");
  assert.deepEqual(capability?.command, ["vendor/bin/phpcpd"]);
});

test("ranks missing test protection as the first PHP baseline candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({ require: { php: "^8.3" } }));
  const adapter = new PhpAdapter(successfulEvidenceRunner);
  const candidates = await adapter.discoverCandidates(await adapter.profile(root));
  assert.equal(candidates[0]?.id, "php-test-baseline");
});

test("collects versioned Laravel validation and error-handling findings as adapter candidates", async () => {
  const root = join(process.cwd(), "test", "fixtures", "php-validation-errors");
  const adapter = new PhpAdapter(successfulEvidenceRunner);
  const candidates = await adapter.discoverCandidates(await adapter.profile(root));

  assert.equal(candidates.some((candidate) => candidate.id.startsWith("missing-validation:") && candidate.target?.endsWith("AccountController.php")), true);
  assert.equal(candidates.filter((candidate) => candidate.id.startsWith("error-handling:")).length, 2);
  assert.equal(JSON.stringify(candidates).includes("gateway->lookup"), false);
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
          ...evidenceStubMetadata(command),
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
  const adapter = new PhpAdapter(runner, new PhpEvidenceCache({
    resolveToolVersion: async () => "2.1.0",
  }));

  await adapter.discoverCandidates(await adapter.profile(root));
  await adapter.discoverCandidates(await adapter.profile(root));

  assert.deepEqual(commands.find((command) => command.identity === "phpstan.analyse")?.command, [
    "vendor/bin/phpstan",
    "analyse",
    "--error-format=json",
    "--no-progress",
    "--no-interaction",
  ]);
  assert.equal(commands.some((command) => command.command.includes("repository-owned-analysis-script")), false);
  assert.equal(commands.filter((command) => command.identity === "phpstan.analyse").length, 1);
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
      if (command.identity === "phpunit.performance") {
        const outputPath = command.command[command.command.indexOf("--log-junit") + 1];
        assert.ok(outputPath);
        await writeFile(outputPath, "<testsuites><testsuite><testcase name=\"fast\" file=\"tests/FastTest.php\" time=\"0.001\" /></testsuite></testsuites>");
      }
      const stdout = command.identity === "composer.audit"
        ? JSON.stringify({ advisories: [], abandoned: [] })
        : "";
      const status = command.classify({ exitCode: 0, stdout, stderr: "", outputTruncated: false });
      return {
        result: {
          ...evidenceStubMetadata(command),
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
  const performanceCommand = commands.find((command) => command.identity === "phpunit.performance");
  assert.equal(performanceCommand?.command[0], "vendor/bin/phpunit");
  assert.equal(performanceCommand?.command.includes("repository-owned-coverage-script"), false);
});

test("collects slow PHPUnit timings as ranked adapter candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" },
    "require-dev": { "phpunit/phpunit": "^12" },
  }));
  const runner: EvidenceRunner = {
    async run(command: EvidenceCommand): Promise<EvidenceRun> {
      if (command.identity === "phpunit.coverage") {
        const outputPath = command.command[command.command.indexOf("--coverage-clover") + 1];
        assert.ok(outputPath);
        await writeFile(outputPath, "<coverage><project></project></coverage>");
      }
      if (command.identity === "phpunit.performance") {
        const outputPath = command.command[command.command.indexOf("--log-junit") + 1];
        assert.ok(outputPath);
        await writeFile(outputPath, `<testsuites><testsuite><testcase name="slow_domain_case" class="DomainTest" file="tests/DomainTest.php" time="1.25" /></testsuite></testsuites>`);
      }
      const stdout = command.identity === "composer.audit" ? JSON.stringify({ advisories: [], abandoned: [] }) : "";
      return {
        result: {
          ...evidenceStubMetadata(command),
          commandIdentity: command.identity,
          command: command.command,
          status: command.classify({ exitCode: 0, stdout, stderr: "", outputTruncated: false }),
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

  const candidates = await adapter.discoverCandidates(await adapter.profile(root));

  assert.equal(candidates.some((candidate) => candidate.id.startsWith("slow-test:") && candidate.kind === "performance"), true);
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
          ...evidenceStubMetadata(command),
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

test("executes PhpMetrics selected from the detected manifest capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "Service.php"), "<?php\nfinal class Service {}\n");
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" },
    "require-dev": { "phpmetrics/phpmetrics": "^3" },
    scripts: { complexity: "repository-owned-complexity-script" },
  }));
  const commands: EvidenceCommand[] = [];
  const runner: EvidenceRunner = {
    async run(command: EvidenceCommand): Promise<EvidenceRun> {
      commands.push(command);
      if (command.identity === "phpmetrics.complexity") {
        const reportArgument = command.command.find((argument) => argument.startsWith("--report-json="));
        assert.ok(reportArgument);
        await writeFile(reportArgument.slice("--report-json=".length), JSON.stringify({
          Service: { name: "Service", ccn: 2, ccnMethodMax: 2, mi: 95 },
        }));
      }
      const stdout = command.identity === "composer.audit"
        ? JSON.stringify({ advisories: [], abandoned: [] })
        : "";
      const status = command.classify({ exitCode: 0, stdout, stderr: "", outputTruncated: false });
      return {
        result: {
          ...evidenceStubMetadata(command),
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

  const complexityCommand = commands.find((command) => command.identity === "phpmetrics.complexity");
  assert.equal(complexityCommand?.command[0], "vendor/bin/phpmetrics");
  assert.equal(complexityCommand?.command.includes("repository-owned-complexity-script"), false);
  assert.equal(complexityCommand?.command.at(-1), "app/Domain,src");
});

test("executes and caches PHPCPD findings selected from the manifest capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-php-"));
  await mkdir(join(root, "app", "Services"), { recursive: true });
  await mkdir(join(root, "src", "Allocation"), { recursive: true });
  await writeFile(join(root, "app", "Services", "First.php"), "<?php\nfinal class First {}\n");
  await writeFile(join(root, "src", "Allocation", "Second.php"), "<?php\nfinal class Second {}\n");
  await writeFile(join(root, "composer.json"), JSON.stringify({
    require: { php: "^8.3" },
    "require-dev": { "sebastian/phpcpd": "^6" },
    scripts: { duplicates: "repository-owned-duplicate-script" },
  }));
  const commands: EvidenceCommand[] = [];
  const runner: EvidenceRunner = {
    async run(command: EvidenceCommand): Promise<EvidenceRun> {
      commands.push(command);
      if (command.identity === "phpcpd.duplicate-code") {
        const reportPath = command.command[command.command.indexOf("--log-pmd") + 1];
        assert.ok(reportPath);
        await writeFile(reportPath, `<pmd-cpd><duplication lines="6" tokens="30"><file path="${root}/app/Services/First.php" line="2"/><file path="${root}/src/Allocation/Second.php" line="2"/><codefragment>secret source</codefragment></duplication></pmd-cpd>`);
      }
      const stdout = command.identity === "composer.audit" ? JSON.stringify({ advisories: [], abandoned: [] }) : "";
      const exitCode = command.identity === "phpcpd.duplicate-code" ? 1 : 0;
      return {
        result: {
          ...evidenceStubMetadata(command),
          commandIdentity: command.identity,
          command: command.command,
          status: command.classify({ exitCode, stdout, stderr: "", outputTruncated: false }),
          durationMs: 1,
          exitCode,
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
  const adapter = new PhpAdapter(runner, new PhpEvidenceCache({ resolveToolVersion: async () => "6.0.3" }));

  const first = await adapter.discoverCandidates(await adapter.profile(root));
  const second = await adapter.discoverCandidates(await adapter.profile(root));

  const duplicateCommands = commands.filter((command) => command.identity === "phpcpd.duplicate-code");
  assert.equal(duplicateCommands.length, 1);
  assert.equal(duplicateCommands[0]?.command[0], "vendor/bin/phpcpd");
  assert.equal(duplicateCommands[0]?.command.includes("repository-owned-duplicate-script"), false);
  assert.equal(first.some((candidate) => candidate.id.startsWith("duplicate-code:") && candidate.target === "app/Services/First.php"), true);
  assert.equal(second.some((candidate) => candidate.id.startsWith("duplicate-code:")), true);
  assert.equal(JSON.stringify(first).includes("secret source"), false);
});
