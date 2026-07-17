import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analysePhpSource,
  collectPhpValidationErrorEvidence,
  phpValidationErrorRuleSetVersion,
  phpValidationErrorSchemaVersion,
} from "../src/adapters/php-validation-error-handling.js";

test("normalizes bounded missing-validation and error-handling findings from versioned rules", async () => {
  const root = join(process.cwd(), "test", "fixtures", "php-validation-errors");
  const evidence = await collectPhpValidationErrorEvidence(root);

  assert.equal(evidence.schemaVersion, phpValidationErrorSchemaVersion);
  assert.equal(evidence.status, "code-finding");
  assert.equal(evidence.provenance.mechanism, "versioned-adapter-rules");
  assert.equal(evidence.provenance.ruleSetVersion, phpValidationErrorRuleSetVersion);
  assert.deepEqual(evidence.provenance.sourcePatterns, ["app/**/*.php", "src/**/*.php"]);
  assert.equal(evidence.provenance.configuration.path, "composer.json");
  assert.match(evidence.provenance.configuration.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(evidence.provenance.configuration.bytes > 0);
  assert.deepEqual(evidence.findings.map(({ kind, file, line, rule }) => ({ kind, file, line, rule })), [
    {
      kind: "missing-validation",
      file: "app/Http/Controllers/AccountController.php",
      line: 7,
      rule: "laravel-request-all-mass-assignment",
    },
    {
      kind: "error-handling",
      file: "app/Http/Controllers/AccountController.php",
      line: 14,
      rule: "php-broad-catch-default-return",
    },
    {
      kind: "error-handling",
      file: "app/Http/Controllers/AccountController.php",
      line: 23,
      rule: "php-empty-catch",
    },
  ]);
  assert.equal(evidence.findings.every((finding) => finding.ruleProvenance === phpValidationErrorRuleSetVersion), true);
  assert.equal(evidence.candidates.every((candidate) => candidate.target === "app/Http/Controllers/AccountController.php"), true);
  assert.equal(JSON.stringify(evidence).includes("gateway->lookup"), false);
});

test("ignores safe validation, reported catches, comments, and strings", async () => {
  const root = await repository(`<?php
final class SafeController {
  public function store($request) { return Account::create($request->validated()); }
  public function lookup() {
    try { return $this->gateway->lookup(); }
    catch (\\Throwable $error) { report($error); return null; }
  }
  // Account::create($request->all());
  private string $example = 'catch (\\Throwable $error) {}';
  private string $template = <<<PHP
    Account::create($request->all());
    catch (\\Throwable $error) {}
  PHP;
}
`);
  const evidence = await collectPhpValidationErrorEvidence(root);
  assert.equal(evidence.status, "clean");
  assert.deepEqual(evidence.findings, []);
});

test("distinguishes unsupported, configuration, malformed, truncated, and infrastructure inputs", async () => {
  const unsupportedFramework = await mkdtemp(join(tmpdir(), "daily-improver-validation-"));
  await writeFile(join(unsupportedFramework, "composer.json"), JSON.stringify({ require: { php: "^8.3" } }));
  const noSources = await mkdtemp(join(tmpdir(), "daily-improver-validation-"));
  await writeFile(join(noSources, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^12.0" } }));
  const malformedConfig = await mkdtemp(join(tmpdir(), "daily-improver-validation-"));
  await writeFile(join(malformedConfig, "composer.json"), "{malformed");
  const malformedSource = await repository("<?php final class Broken {");
  const oversized = await repository(`<?php\n${" ".repeat(2 * 1024 * 1024 + 1)}`);
  const infrastructure = await repository("<?php final class Fine {}\n");
  const failingAccess = {
    paths: async function* (): AsyncIterable<string> { yield "app/Controller.php"; },
    metadata: async () => { throw new Error("disk failed"); },
    read: async () => "",
  };

  const results = await Promise.all([
    collectPhpValidationErrorEvidence(unsupportedFramework),
    collectPhpValidationErrorEvidence(noSources),
    collectPhpValidationErrorEvidence(malformedConfig),
    collectPhpValidationErrorEvidence(malformedSource),
    collectPhpValidationErrorEvidence(oversized),
    collectPhpValidationErrorEvidence(infrastructure, failingAccess),
  ]);
  assert.deepEqual(results.map((item) => item.status), [
    "unsupported-input",
    "unsupported-input",
    "configuration-failure",
    "malformed-input",
    "truncated",
    "infrastructure-failure",
  ]);
  assert.deepEqual(results.flatMap((item) => item.findings), []);
});

test("source analyser preserves line identity without retaining raw excerpts", () => {
  const suffix = "must-not-persist";
  const findings = analysePhpSource("app/Unsafe.php", `<?php
// ${suffix}
Account::update($request->all());
`);
  assert.equal(findings[0]?.line, 3);
  assert.equal(JSON.stringify(findings).includes(suffix), false);
});

async function repository(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-validation-"));
  await mkdir(join(root, "app"));
  await writeFile(join(root, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^12.0" } }));
  await writeFile(join(root, "app", "Controller.php"), source);
  return root;
}
