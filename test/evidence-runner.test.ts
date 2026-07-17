import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BoundedEvidenceRunner } from "../src/infra/bounded-evidence-runner.js";

const runner = new BoundedEvidenceRunner();

test("records bounded metadata for a successful evidence command", async () => {
  const run = await runner.run(command([process.execPath, "-e", "process.stdout.write('valid')"]));

  assert.equal(run.result.status, "success");
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.result.stdoutHash, sha256("valid"));
  assert.equal(run.result.stdoutBytes, 5);
  assert.equal(run.result.schemaVersion, "evidence-command-result/v2");
  assert.equal(run.result.provenance.toolVersion, "1.2.3");
  assert.match(run.result.provenance.configurationHash ?? "", /^sha256:/);
  assert.equal(run.output.stdout, "valid");
  assert.equal("stdout" in run.result, false);
});

test("terminates evidence commands at their explicit timeout", async () => {
  const run = await runner.run(command(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 50 },
  ));

  assert.equal(run.result.status, "timeout");
  assert.ok(run.result.durationMs < 1_000);
});

test("classifies a missing evidence executable as unavailable", async () => {
  const run = await runner.run(command(["daily-improver-command-that-does-not-exist"]));

  assert.equal(run.result.status, "unavailable-tool");
  assert.equal(run.result.exitCode, null);
});

test("hashes all output while truncating transient output to the configured limit", async () => {
  const fullOutput = "abcdefghijklmnop";
  const run = await runner.run(command(
    [process.execPath, "-e", `process.stdout.write('${fullOutput}')`],
    { maxOutputBytes: 8 },
  ));

  assert.equal(run.result.status, "success");
  assert.equal(run.result.outputTruncated, true);
  assert.equal(run.result.stdoutBytes, fullOutput.length);
  assert.equal(run.result.stdoutHash, sha256(fullOutput));
  assert.equal(run.output.stdout, "abcdefgh");
});

test("changes the configuration hash when a relevant configuration file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-provenance-"));
  try {
    await writeFile(join(root, "tool.xml"), "first");
    const first = await runner.run(command([process.execPath, "-e", ""], {
      cwd: root,
      configurationPaths: ["tool.xml"],
    }));
    await writeFile(join(root, "tool.xml"), "second");
    const second = await runner.run(command([process.execPath, "-e", ""], {
      cwd: root,
      configurationPaths: ["tool.xml"],
    }));

    assert.equal(first.result.provenance.configurationFiles[0]?.status, "hashed");
    assert.notEqual(first.result.provenance.configurationHash, second.result.provenance.configurationHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records absent configuration distinctly from an empty configuration file", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-provenance-"));
  try {
    const absent = await runner.run(command([process.execPath, "-e", ""], {
      cwd: root,
      configurationPaths: ["tool.xml"],
    }));
    await writeFile(join(root, "tool.xml"), "");
    const empty = await runner.run(command([process.execPath, "-e", ""], {
      cwd: root,
      configurationPaths: ["tool.xml"],
    }));

    assert.equal(absent.result.provenance.configurationFiles[0]?.status, "absent");
    assert.equal(empty.result.provenance.configurationFiles[0]?.status, "hashed");
    assert.notEqual(absent.result.provenance.configurationHash, empty.result.provenance.configurationHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when the trusted version command is unavailable or malformed", async () => {
  const unavailable = await runner.run(command([process.execPath, "-e", ""], {
    versionCommand: ["daily-improver-version-command-that-does-not-exist"],
  }));
  const malformed = await runner.run(command([process.execPath, "-e", ""], {
    versionCommand: [process.execPath, "-e", "process.stdout.write('unknown')"],
  }));

  assert.equal(unavailable.result.status, "unavailable-tool");
  assert.equal(unavailable.result.provenance.status, "unavailable-version-command");
  assert.equal(malformed.result.status, "infrastructure-failure");
  assert.equal(malformed.result.provenance.status, "malformed-version");
  assert.deepEqual(malformed.output, { stdout: "", stderr: "" });
});

test("fails closed for unreadable and oversized configuration inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-provenance-"));
  try {
    await mkdir(join(root, "directory.xml"));
    await writeFile(join(root, "large.xml"), "1234");
    const unreadable = await runner.run(command([process.execPath, "-e", ""], {
      cwd: root,
      configurationPaths: ["directory.xml"],
    }));
    const oversized = await runner.run(command([process.execPath, "-e", ""], {
      cwd: root,
      configurationPaths: ["large.xml"],
      maxConfigurationFileBytes: 3,
    }));

    assert.equal(unreadable.result.provenance.configurationFiles[0]?.status, "unreadable");
    assert.equal(unreadable.result.provenance.configurationHash, null);
    assert.equal(unreadable.result.status, "infrastructure-failure");
    assert.equal(oversized.result.provenance.configurationFiles[0]?.status, "oversized");
    assert.equal(oversized.result.status, "infrastructure-failure");
    assert.deepEqual(oversized.output, { stdout: "", stderr: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function command(
  executable: readonly string[],
  overrides: {
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly cwd?: string;
    readonly versionCommand?: readonly string[];
    readonly configurationPaths?: readonly string[];
    readonly maxConfigurationFileBytes?: number;
  } = {},
) {
  return {
    identity: "test.command",
    command: executable,
    cwd: overrides.cwd ?? tmpdir(),
    timeoutMs: overrides.timeoutMs ?? 5_000,
    maxOutputBytes: overrides.maxOutputBytes ?? 1_024,
    provenance: {
      versionCommand: overrides.versionCommand ?? [
        process.execPath,
        "-e",
        "process.stdout.write('tool version 1.2.3')",
      ],
      configurationPaths: overrides.configurationPaths ?? [],
      maxConfigurationFileBytes: overrides.maxConfigurationFileBytes ?? 1_024,
    },
    classify: ({ exitCode }: { readonly exitCode: number }) => exitCode === 0 ? "success" as const : "code-finding" as const,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
