import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EvidenceCommand, EvidenceResultStatus, EvidenceRun, EvidenceRunner } from "../src/contracts.js";
import type { CommandCapability } from "../src/domain/model.js";
import {
  collectLaravelDeprecatedApiEvidence,
  collectPhpDeprecatedApiEvidence,
  laravelDeprecationRuleSetVersion,
  phpDeprecationCommand,
  phpDeprecationSchemaVersion,
} from "../src/adapters/php-deprecation.js";
import { evidenceStubMetadata } from "./evidence-stub.js";

const capability: CommandCapability = {
  kind: "deprecation-analysis",
  command: ["composer", "untrusted-script"],
  source: "manifest",
  framework: "phpcompatibility",
};

test("runs trusted version-aware PHPCompatibility and normalizes clean output", async () => {
  const root = await repository({ php: "^8.3" });
  const runner = new StubEvidenceRunner({ stdout: phpcs([]) });
  const evidence = await collectPhpDeprecatedApiEvidence(root, capability, runner);

  assert.deepEqual(runner.command?.command, phpDeprecationCommand("8.3"));
  assert.equal(runner.command?.command.includes("untrusted-script"), false);
  assert.deepEqual(runner.command?.provenance.versionCommand, ["vendor/bin/phpcs", "--version"]);
  assert.deepEqual(runner.command?.provenance.configurationPaths, ["composer.json", "composer.lock"]);
  assert.equal(evidence.schemaVersion, phpDeprecationSchemaVersion);
  assert.equal(evidence.targetVersion, "8.3");
  assert.equal(evidence.targetVersionSource, "composer.json require.php");
  assert.equal(evidence.status, "success");
});

test("preserves bounded PHP file, line, symbol, rule, replacement, and message", async () => {
  const root = await repository({ php: "8.2" });
  const suffix = "must-not-persist";
  const message = `Function 'utf8_encode' is deprecated since PHP 8.2; use mb_convert_encoding instead. ${"x".repeat(600)}${suffix}`;
  const runner = new StubEvidenceRunner({
    exitCode: 1,
    stdout: phpcs([{ message, source: "PHPCompatibility.FunctionUse.RemovedFunctions.utf8_encodeDeprecated", line: 14 }], `${root}/src/Codec.php`),
  });
  const evidence = await collectPhpDeprecatedApiEvidence(root, capability, runner);

  assert.equal(evidence.status, "code-finding");
  assert.deepEqual(
    evidence.findings.map(({ file, line, symbol, rule, replacement }) => ({ file, line, symbol, rule, replacement })),
    [{
      file: "src/Codec.php",
      line: 14,
      symbol: "utf8_encode",
      rule: "PHPCompatibility.FunctionUse.RemovedFunctions.utf8_encodeDeprecated",
      replacement: "mb_convert_encoding instead",
    }],
  );
  assert.equal(evidence.findings[0]?.message.length, 512);
  assert.equal(evidence.candidates[0]?.target, "src/Codec.php");
  assert.equal(JSON.stringify(evidence).includes(suffix), false);
});

test("distinguishes unsupported PHP versions and rule coverage without executing guesses", async () => {
  const unsupportedVersion = await collectPhpDeprecatedApiEvidence(
    await repository({ php: "^9.0" }),
    capability,
    new StubEvidenceRunner({ stdout: phpcs([]) }),
  );
  const unsupportedRules = await collectPhpDeprecatedApiEvidence(
    await repository({ php: "^8.4" }),
    capability,
    new StubEvidenceRunner({ exitCode: 3, stderr: "PHPCompatibility does not support PHP testVersion 8.4" }),
  );

  assert.equal(unsupportedVersion.status, "unsupported-version");
  assert.equal(unsupportedVersion.result, null);
  assert.equal(unsupportedRules.status, "unsupported-rules");
});

test("distinguishes unavailable, configuration, timeout, truncation, and infrastructure failures", async () => {
  const root = await repository({ php: "^8.3" });
  const unavailable = await collectPhpDeprecatedApiEvidence(root, capability, new StubEvidenceRunner({ forcedStatus: "unavailable-tool", exitCode: null }));
  const configuration = await collectPhpDeprecatedApiEvidence(root, capability, new StubEvidenceRunner({ exitCode: 3, stderr: "ERROR: the PHPCompatibility coding standard is not installed" }));
  const timeout = await collectPhpDeprecatedApiEvidence(root, capability, new StubEvidenceRunner({ forcedStatus: "timeout", exitCode: null }));
  const truncated = await collectPhpDeprecatedApiEvidence(root, capability, new StubEvidenceRunner({ outputTruncated: true, stdout: phpcs([]) }));
  const infrastructure = await collectPhpDeprecatedApiEvidence(root, capability, new StubEvidenceRunner({ exitCode: 2, stdout: "not-json" }));

  assert.deepEqual(
    [unavailable.status, configuration.status, timeout.status, truncated.status, infrastructure.status],
    ["unavailable-tool", "configuration-failure", "timeout", "truncated", "infrastructure-failure"],
  );
  assert.deepEqual([unavailable, configuration, timeout, truncated, infrastructure].flatMap((item) => item.findings), []);
});

test("normalizes version-aware Laravel rules with explicit upgrade-guide provenance", async () => {
  const root = join(process.cwd(), "test", "fixtures", "php-deprecated-apis");
  const evidence = await collectLaravelDeprecatedApiEvidence(root);

  assert.equal(evidence.status, "code-finding");
  assert.equal(evidence.targetVersion, "12.0");
  assert.equal(evidence.targetVersionSource, "composer.json require.laravel/framework");
  assert.equal(evidence.ruleSetVersion, laravelDeprecationRuleSetVersion);
  assert.deepEqual(evidence.findings.map(({ file, line, symbol, replacement }) => ({ file, line, symbol, replacement })), [
    { file: "app/LegacyQueue.php", line: 5, symbol: "Bus::dispatchNow", replacement: "Bus::dispatchSync" },
    { file: "app/LegacyQueue.php", line: 6, symbol: "dispatch_now()", replacement: "dispatch_sync()" },
  ]);
  assert.equal(evidence.findings.every((finding) => finding.ruleProvenance.startsWith("https://laravel.com/docs/10.x/upgrade")), true);
});

test("applies Laravel rules only after their explicit framework version", async () => {
  const root = await repository({ php: "^8.1", laravel: "^9.0", source: "<?php\nBus::dispatchNow($job);\n" });
  const evidence = await collectLaravelDeprecatedApiEvidence(root);
  assert.equal(evidence.status, "success");
  assert.deepEqual(evidence.findings, []);
});

test("does not treat Laravel API names in comments or strings as evidence", async () => {
  const root = await repository({
    php: "^8.2",
    laravel: "^12.0",
    source: `<?php
// Bus::dispatchNow($job);
$example = 'dispatch_now($job)';
/* Redirect::home(); */
`,
  });
  const evidence = await collectLaravelDeprecatedApiEvidence(root);
  assert.equal(evidence.status, "success");
  assert.deepEqual(evidence.findings, []);
});

test("distinguishes unsupported Laravel versions, rule sets, and malformed configuration", async () => {
  const unsupportedVersion = await collectLaravelDeprecatedApiEvidence(await repository({ php: "^8.3", laravel: "^14.0" }));
  const unsupportedRules = await collectLaravelDeprecatedApiEvidence(
    await repository({ php: "^8.3", laravel: "^12.0" }),
    "laravel-deprecation-rules/v999",
  );
  const malformed = await mkdtemp(join(tmpdir(), "daily-improver-deprecated-"));
  await writeFile(join(malformed, "composer.json"), "{malformed");
  const configuration = await collectLaravelDeprecatedApiEvidence(malformed);

  assert.deepEqual(
    [unsupportedVersion.status, unsupportedRules.status, configuration.status],
    ["unsupported-version", "unsupported-rules", "configuration-failure"],
  );
});

interface RepositoryOptions {
  readonly php: string;
  readonly laravel?: string;
  readonly source?: string;
}

async function repository(options: RepositoryOptions): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-deprecated-"));
  const require: Record<string, string> = { php: options.php };
  if (options.laravel) require["laravel/framework"] = options.laravel;
  await writeFile(join(root, "composer.json"), JSON.stringify({ require }));
  if (options.source) {
    await mkdir(join(root, "app"));
    await writeFile(join(root, "app", "Legacy.php"), options.source);
  }
  return root;
}

function phpcs(messages: readonly Record<string, unknown>[], file = "src/Clean.php"): string {
  return JSON.stringify({
    totals: { errors: messages.length, warnings: 0, fixable: 0 },
    files: { [file]: { errors: messages.length, warnings: 0, messages } },
  });
}

interface StubOptions {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputTruncated?: boolean;
  readonly forcedStatus?: EvidenceResultStatus;
}

class StubEvidenceRunner implements EvidenceRunner {
  command?: EvidenceCommand;

  constructor(private readonly options: StubOptions) {}

  async run(command: EvidenceCommand): Promise<EvidenceRun> {
    this.command = command;
    const exitCode = this.options.exitCode === undefined ? 0 : this.options.exitCode;
    const stdout = this.options.stdout ?? "";
    const stderr = this.options.stderr ?? "";
    const outputTruncated = this.options.outputTruncated ?? false;
    const status = this.options.forcedStatus ?? command.classify({ exitCode: exitCode ?? 1, stdout, stderr, outputTruncated });
    return {
      result: {
        ...evidenceStubMetadata(command),
        commandIdentity: command.identity,
        command: command.command,
        status,
        durationMs: 10,
        exitCode,
        stdoutHash: "sha256:stdout",
        stderrHash: "sha256:stderr",
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        outputLimitBytes: command.maxOutputBytes,
        outputTruncated,
      },
      output: { stdout, stderr },
    };
  }
}
