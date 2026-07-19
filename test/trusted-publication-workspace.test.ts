import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TrustedPublicationWorkspace } from "../src/core/trusted-publication-workspace.js";
import type { VerifierExecutionInputs } from "../src/core/verifier-execution-inputs.js";
import { CommandRunner } from "../src/infra/command-runner.js";
import { createTestManifest } from "../src/core/artifacts.js";
import { signArtifact } from "../src/core/artifact-authentication.js";
import { createVerificationReport, verificationEvidenceSchemaVersions, verificationReportSchemaVersion } from "../src/domain/verification-report.js";

test("publishes only identity-bound verified production and sealed artifact states", async () => {
  const fixture = await createFixture();
  const workspace = await new TrustedPublicationWorkspace(join(fixture.sandbox, "publication"), fixture.runner, fixture.key).create(
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
    await writePublisherArtifacts(workspace.path, fixture.runRoot, fixture.key);
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

test("rejects tampered manifests, verifier outputs, lifecycle decisions, and publisher inputs", async () => {
  const manifest = await createFixture();
  await writeFile(join(manifest.verified, manifest.runRoot, "test-manifest.json"), "{}\n");
  await assert.rejects(
    new TrustedPublicationWorkspace(join(manifest.sandbox, "publication"), manifest.runner, manifest.key).create(
      manifest.repository, manifest.verified, manifest.inputs, manifest.report, manifest.lifecyclePath,
    ),
    /manifest|identity changed/,
  );

  const report = await createFixture();
  await writeFile(join(report.verified, report.runRoot, "verification.json"), '{"schemaVersion":"verification-report/v2","passed":false}\n');
  await assert.rejects(
    new TrustedPublicationWorkspace(join(report.sandbox, "publication"), report.runner, report.key).create(
      report.repository, report.verified, report.inputs, report.report, report.lifecyclePath,
    ),
    /identity changed/,
  );

  const lifecycle = await createFixture();
  await writeFile(join(lifecycle.verified, lifecycle.lifecyclePath), '{"schemaVersion":"generated-test-lifecycle-decision/v1","outcome":"rejected"}\n');
  await assert.rejects(
    new TrustedPublicationWorkspace(join(lifecycle.sandbox, "publication"), lifecycle.runner, lifecycle.key).create(
      lifecycle.repository, lifecycle.verified, lifecycle.inputs, lifecycle.report, lifecycle.lifecyclePath,
    ),
    /identity changed/,
  );

  const publication = await createFixture();
  const workspace = await new TrustedPublicationWorkspace(join(publication.sandbox, "publication"), publication.runner, publication.key).create(
    publication.repository, publication.verified, publication.inputs, publication.report, publication.lifecyclePath,
  );
  try {
    await writePublisherArtifacts(workspace.path, publication.runRoot, publication.key);
    await writeFile(join(workspace.path, publication.runRoot, "publication-request.json"), '{"schemaVersion":"publication-request/v1","draft":false}\n');
    await assert.rejects(
      workspace.commitToBranch(publication.repository, "ai/daily/tampered-input", "fix: tampered input"),
      /identity changed/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("rejects additional and identity-mismatched verified inputs before publication staging", async () => {
  const additional = await createFixture();
  await writeFile(join(additional.verified, "builder-only.txt"), "unverified\n");
  await assert.rejects(
    new TrustedPublicationWorkspace(join(additional.sandbox, "publication"), additional.runner, additional.key).create(
      additional.repository, additional.verified, additional.inputs, additional.report, additional.lifecyclePath,
    ),
    /additional or unverified path/,
  );

  const changed = await createFixture();
  await writeFile(join(changed.verified, "tests", "generated.php"), "<?php assert(false);\n");
  await assert.rejects(
    new TrustedPublicationWorkspace(join(changed.sandbox, "publication"), changed.runner, changed.key).create(
      changed.repository, changed.verified, changed.inputs, changed.report, changed.lifecyclePath,
    ),
    /manifest authentication failed/,
  );

  const patchTampering = await createFixture();
  const workspace = await new TrustedPublicationWorkspace(join(patchTampering.sandbox, "publication"), patchTampering.runner, patchTampering.key).create(
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
    new TrustedPublicationWorkspace(join(missing.sandbox, "publication"), missing.runner, missing.key).create(
      missing.repository, missing.verified, missingInputs, missing.report, missing.lifecyclePath,
    ),
    /manifest authentication failed/,
  );

  const linked = await createFixture();
  await writeFile(join(linked.verified, "src", "value.php"), "<?php return 1;\n");
  await symlink("value.php", join(linked.verified, "src", "linked.php"));
  const linkedInputs = {
    ...linked.inputs,
    specification: { ...linked.inputs.specification, allowedFiles: ["src/linked.php"] },
  };
  await assert.rejects(
    new TrustedPublicationWorkspace(join(linked.sandbox, "publication"), linked.runner, linked.key).create(
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
    new TrustedPublicationWorkspace(join(traversing.sandbox, "publication"), traversing.runner, traversing.key).create(
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
  const key = "ephemeral-publication-artifact-key";
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
  const manifest = await createTestManifest(verified, key);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(verified, runRoot, "test-manifest.json"), manifestBytes);
  const report = createVerificationReport(
    { expectedBaseSha, verifierInputsSha256: "c".repeat(64), mutationMode: "off", commands: [] },
    verificationEvidenceSchemaVersions("off").map((schemaVersion) => ({ schemaVersion, value: { schemaVersion } })),
    [],
    "2026-07-18T10:30:00.000Z",
  );
  await writeFile(join(verified, runRoot, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  await signArtifact(verified, `${runRoot}/verification.json`, verificationReportSchemaVersion, key);
  const lifecyclePath = `${runRoot}/generated-test-verification-lifecycle.json`;
  await writeFile(join(verified, lifecyclePath), "{\"schemaVersion\":\"generated-test-lifecycle-decision/v1\"}\n");
  await signArtifact(verified, lifecyclePath, "generated-test-lifecycle-decision/v1", key);
  await git(runner, verified, ["add", "-N", "--all"]);
  const inputs: VerifierExecutionInputs = {
    schemaVersion: "verifier-execution-inputs/v4",
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
    specificationSha256: "b".repeat(64), configurationSha256: "absent", commands: [], mutationMode: "off", protectedPaths: ["tests/**"],
    repositoryLimits: { maxChangedFiles: 1, maxDiffLines: 10 },
    commandEnvironment: {
      schemaVersion: "verifier-command-environment/v1",
      isolation: "fresh-process-and-storage-per-command",
      shell: "/bin/sh",
      path: "/usr/bin:/bin",
      inheritedVariables: [],
    }, outputArtifact: `${runRoot}/verification.json`,
    trustedArtifacts: [`${runRoot}/build-agent-usage.json`, `${runRoot}/build-agent-rationale.json`],
    manifest, manifestArtifactSha256: sha256(manifestBytes), integritySha256: report.verifierInputsSha256,
  };
  return { sandbox, repository, verified, runner, runRoot, lifecyclePath, inputs, report, key };
}

async function git(runner: CommandRunner, root: string, args: readonly string[]): Promise<void> {
  const result = await runner.run(["git", ...args], root);
  assert.equal(result.exitCode, 0, result.stderr);
}

async function writePublisherArtifacts(root: string, runRoot: string, key: string): Promise<void> {
  await writeFile(join(root, runRoot, "daily-improvement-decision.json"), "{\"schemaVersion\":\"daily-improvement-decision/v1\",\"outcome\":\"completed\"}\n");
  await writeFile(join(root, runRoot, "publication-authorization.json"), "{\"schemaVersion\":\"publication-authorization/v1\",\"outcome\":\"authorized\"}\n");
  await writeFile(join(root, runRoot, "publication-request.json"), "{\"schemaVersion\":\"publication-request/v1\",\"draft\":true}\n");
  await signArtifact(root, `${runRoot}/daily-improvement-decision.json`, "daily-improvement-decision/v1", key);
  await signArtifact(root, `${runRoot}/publication-authorization.json`, "publication-authorization/v1", key);
  await signArtifact(root, `${runRoot}/publication-request.json`, "publication-request/v1", key);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
