import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TrustedPublicationWorkspace } from "../src/core/trusted-publication-workspace.js";
import type { VerifierExecutionInputs } from "../src/core/verifier-execution-inputs.js";
import { CommandRunner } from "../src/infra/command-runner.js";

test("publishes only identity-bound verified production and sealed artifact states", async () => {
  const fixture = await createFixture();
  const workspace = await new TrustedPublicationWorkspace(join(fixture.sandbox, "publication"), fixture.runner).create(
    fixture.repository,
    fixture.verified,
    fixture.inputs,
    fixture.report,
    fixture.lifecyclePath,
  );
  try {
    assert.equal(await readFile(join(workspace.path, "src", "value.php"), "utf8"), "<?php return 2;\n");
    assert.equal(await readFile(join(workspace.path, "tests", "generated.php"), "utf8"), "<?php assert(true);\n");
    await assert.rejects(readFile(join(workspace.path, "builder-only.txt")), /ENOENT/);
    await assert.rejects(readFile(join(workspace.path, ".daily-improver", "cache.json")), /ENOENT/);
    await assert.rejects(readFile(join(workspace.path, fixture.runRoot, "build-agent-rationale.json")), /ENOENT/);
    await git(fixture.runner, workspace.path, ["config", "user.email", "improver@example.test"]);
    await git(fixture.runner, workspace.path, ["config", "user.name", "Daily Improver Test"]);
    await writeFile(join(workspace.path, fixture.runRoot, "daily-improvement-decision.json"), "{\"outcome\":\"completed\"}\n");
    await writeFile(join(workspace.path, fixture.runRoot, "publication-authorization.json"), "{\"outcome\":\"authorized\"}\n");
    await writeFile(join(workspace.path, fixture.runRoot, "publication-request.json"), "{\"draft\":true}\n");
    const commit = await workspace.commitToBranch(fixture.repository, "ai/daily/trusted", "fix: trusted value");
    const branchCommit = (await fixture.runner.run(["git", "rev-parse", "ai/daily/trusted"], fixture.repository)).stdout.trim();
    assert.equal(branchCommit, commit);
    const paths = await fixture.runner.run(["git", "ls-tree", "-r", "--name-only", "ai/daily/trusted"], fixture.repository);
    assert.match(paths.stdout, /src\/value\.php/);
    assert.match(paths.stdout, /tests\/generated\.php/);
    assert.match(paths.stdout, /verified-publication-patch\.json/);
    assert.doesNotMatch(paths.stdout, /builder-only|build-agent-rationale|\.daily-improver/);
  } finally {
    await workspace.cleanup();
  }
});

test("rejects additional and identity-mismatched verified inputs before publication staging", async () => {
  const additional = await createFixture();
  await writeFile(join(additional.verified, "builder-only.txt"), "unverified\n");
  await assert.rejects(
    new TrustedPublicationWorkspace(join(additional.sandbox, "publication"), additional.runner).create(
      additional.repository, additional.verified, additional.inputs, additional.report, additional.lifecyclePath,
    ),
    /additional or unverified path/,
  );

  const changed = await createFixture();
  await writeFile(join(changed.verified, "tests", "generated.php"), "<?php assert(false);\n");
  await assert.rejects(
    new TrustedPublicationWorkspace(join(changed.sandbox, "publication"), changed.runner).create(
      changed.repository, changed.verified, changed.inputs, changed.report, changed.lifecyclePath,
    ),
    /identity changed/,
  );

  const patchTampering = await createFixture();
  const workspace = await new TrustedPublicationWorkspace(join(patchTampering.sandbox, "publication"), patchTampering.runner).create(
    patchTampering.repository, patchTampering.verified, patchTampering.inputs, patchTampering.report, patchTampering.lifecyclePath,
  );
  try {
    await writeFile(join(workspace.path, patchTampering.runRoot, "verified-publication-patch.json"), "{}\n");
    await assert.rejects(
      workspace.commitToBranch(patchTampering.repository, "ai/daily/tampered", "fix: tampered"),
      /identity changed/,
    );
    const branch = await patchTampering.runner.run(["git", "rev-parse", "--verify", "refs/heads/ai/daily/tampered"], patchTampering.repository);
    assert.notEqual(branch.exitCode, 0);
  } finally {
    await workspace.cleanup();
  }
});

test("rejects missing, symlinked, and traversing patch inputs before changing a publication branch", async () => {
  const missing = await createFixture();
  const missingInputs = {
    ...missing.inputs,
    manifest: { ...missing.inputs.manifest, files: { ...missing.inputs.manifest.files, "tests/missing.php": "0".repeat(64) } },
  };
  await assert.rejects(
    new TrustedPublicationWorkspace(join(missing.sandbox, "publication"), missing.runner).create(
      missing.repository, missing.verified, missingInputs, missing.report, missing.lifecyclePath,
    ),
    /ENOENT/,
  );

  const linked = await createFixture();
  await writeFile(join(linked.verified, "src", "value.php"), "<?php return 1;\n");
  await symlink("value.php", join(linked.verified, "src", "linked.php"));
  const linkedInputs = {
    ...linked.inputs,
    specification: { ...linked.inputs.specification, allowedFiles: ["src/linked.php"] },
  };
  await assert.rejects(
    new TrustedPublicationWorkspace(join(linked.sandbox, "publication"), linked.runner).create(
      linked.repository, linked.verified, linkedInputs, linked.report, linked.lifecyclePath,
    ),
    /not a regular file/,
  );

  const traversing = await createFixture();
  const traversingInputs = {
    ...traversing.inputs,
    specification: { ...traversing.inputs.specification, allowedFiles: ["../outside.php"] },
  };
  await assert.rejects(
    new TrustedPublicationWorkspace(join(traversing.sandbox, "publication"), traversing.runner).create(
      traversing.repository, traversing.verified, traversingInputs, traversing.report, traversing.lifecyclePath,
    ),
    /path is malformed/,
  );
});

async function createFixture() {
  const sandbox = await mkdtemp(join(tmpdir(), "daily-improver-publication-workspace-"));
  const repository = join(sandbox, "repository");
  const verified = join(sandbox, "verified");
  const runner = new CommandRunner();
  const runRoot = ".ai/runs/2026-07-18";
  await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(join(repository, "tests"), { recursive: true });
  await writeFile(join(repository, "src", "value.php"), "<?php return 1;\n");
  await writeFile(join(repository, "tests", "baseline.php"), "<?php assert(true);\n");
  await git(runner, repository, ["init", "-b", "main"]);
  await git(runner, repository, ["config", "user.email", "improver@example.test"]);
  await git(runner, repository, ["config", "user.name", "Daily Improver Test"]);
  await git(runner, repository, ["add", "."]);
  await git(runner, repository, ["commit", "-m", "baseline"]);
  const expectedBaseSha = (await runner.run(["git", "rev-parse", "HEAD"], repository)).stdout.trim();
  await cp(repository, verified, { recursive: true });
  await writeFile(join(verified, "src", "value.php"), "<?php return 2;\n");
  await writeFile(join(verified, "tests", "generated.php"), "<?php assert(true);\n");
  await mkdir(join(verified, runRoot), { recursive: true });
  await writeFile(join(verified, runRoot, "spec.json"), "{\"title\":\"trusted\"}\n");
  await writeFile(join(verified, runRoot, "daily-improvement-decision.json"), "{\"outcome\":\"claimed\"}\n");
  const manifestFiles = {
    "tests/generated.php": sha256(await readFile(join(verified, "tests", "generated.php"))),
    [`${runRoot}/spec.json`]: sha256(await readFile(join(verified, runRoot, "spec.json"))),
    [`${runRoot}/daily-improvement-decision.json`]: sha256(await readFile(join(verified, runRoot, "daily-improvement-decision.json"))),
  };
  const manifest = { schema: 1 as const, generatedAt: "2026-07-18T00:00:00.000Z", files: manifestFiles, signature: "a".repeat(64) };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(verified, runRoot, "test-manifest.json"), manifestBytes);
  const report = {
    schemaVersion: "verification-report/v1" as const,
    passed: true,
    expectedBaseSha,
    verifierInputsSha256: "c".repeat(64),
  };
  await writeFile(join(verified, runRoot, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  const lifecyclePath = `${runRoot}/generated-test-verification-lifecycle.json`;
  await writeFile(join(verified, lifecyclePath), "{\"schemaVersion\":\"generated-test-lifecycle-decision/v1\"}\n");
  await git(runner, verified, ["add", "-N", "--all"]);
  const inputs: VerifierExecutionInputs = {
    schemaVersion: "verifier-execution-inputs/v1",
    expectedBaseSha,
    specification: {
      id: "candidate",
      improvementIntent: { schemaVersion: "improvement-intent/v1", intent: "defect", baselineProof: "defect-regression" },
      title: "Trusted value",
      objective: "Correct value.",
      currentBehaviour: "Returns one.",
      proposedImprovement: "Return two.",
      allowedFiles: ["src/value.php"],
      behavioursToPreserve: [], acceptanceCriteria: ["Returns two."], propertyInvariants: [], exclusions: [],
      verification: ["test"], constraints: { maxFiles: 1, maxChangedLines: 10, maxCostUsd: 1 }, evidence: ["fixture"],
    },
    specificationSha256: "b".repeat(64), configurationSha256: "absent", commands: [], protectedPaths: ["tests/**"],
    runtimeEnvironment: { PATH: "/usr/bin:/bin" }, outputArtifact: `${runRoot}/verification.json`,
    trustedArtifacts: [`${runRoot}/build-agent-usage.json`, `${runRoot}/build-agent-rationale.json`],
    manifest, manifestArtifactSha256: sha256(manifestBytes), integritySha256: report.verifierInputsSha256,
  };
  return { sandbox, repository, verified, runner, runRoot, lifecyclePath, inputs, report };
}

async function git(runner: CommandRunner, root: string, args: readonly string[]): Promise<void> {
  const result = await runner.run(["git", ...args], root);
  assert.equal(result.exitCode, 0, result.stderr);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
