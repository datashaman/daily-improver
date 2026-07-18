import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CommandAgentProvider,
  createCommandAgentRuntimeEnvironment,
} from "../src/agents/command-agent-provider.js";
import type { BuilderNetworkIsolation } from "../src/agents/builder-network-isolation.js";
import { builderPackageManagerExecutablesByEcosystem } from "../src/agents/builder-dependency-installation.js";
import { CommandRunner } from "../src/infra/command-runner.js";
import type { CommandAgentRuntimeEnvironment } from "../src/agents/command-agent-provider.js";
import type { AgentContext } from "../src/agents/agent-provider.js";
import type { ImprovementSpec } from "../src/domain/model.js";

test("command-backed stages receive only runner runtime and exact stage inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-command-agent-"));
  const specPath = join(root, ".ai", "runs", "2026-07-18", "spec.json");
  await mkdir(dirname(specPath), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(specPath, "{}\n");

  const sentinelEnvironment = {
    PATH: process.env.PATH,
    DAILY_IMPROVER_TEST_AGENT_CREDENTIAL: "test-stage-sentinel",
    DAILY_IMPROVER_ANALYSIS_AGENT_CREDENTIAL: "analysis-stage-sentinel",
    DAILY_IMPROVER_MANIFEST_KEY: "manifest-sentinel",
    DAILY_IMPROVER_REPOSITORY_SCOPE: "control-plane-sentinel",
    GITHUB_TOKEN: "github-sentinel",
    OPENAI_API_KEY: "unrelated-model-sentinel",
  };
  const networkIsolation = new RecordingNetworkIsolation();
  const provider = new CommandAgentProvider({
    testCommand: "env > tests/test-agent.env",
    buildCommand: "env > src/build-agent.env",
    runtimeEnvironment: createCommandAgentRuntimeEnvironment(sentinelEnvironment),
  }, new CommandRunner(), networkIsolation);
  const context = fixtureContext(root, specPath);

  await provider.generateTests(context);
  await provider.build(context);
  assert.equal(networkIsolation.invocations, 1);

  const testEnvironment = await readFile(join(root, "tests", "test-agent.env"), "utf8");
  const buildEnvironment = await readFile(join(root, "src", "build-agent.env"), "utf8");
  assert.match(testEnvironment, /^DAILY_IMPROVER_AGENT_STAGE=test$/m);
  assert.match(buildEnvironment, /^DAILY_IMPROVER_AGENT_STAGE=build$/m);
  for (const environment of [testEnvironment, buildEnvironment]) {
    assert.match(environment, new RegExp(`^DAILY_IMPROVER_SPEC_PATH=${escapeRegExp(specPath)}$`, "m"));
    assert.match(environment, /^PATH=\//m);
    assert.doesNotMatch(environment, /test-stage-sentinel|analysis-stage-sentinel|manifest-sentinel/);
    assert.doesNotMatch(environment, /control-plane-sentinel|github-sentinel|unrelated-model-sentinel/);
  }
});

test("builder networking defaults to denial and requires an exact trusted runner approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-command-network-policy-"));
  const specPath = join(root, ".ai", "spec.json");
  await mkdir(dirname(specPath), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(specPath, "{}\n");
  const rejectingIsolation: BuilderNetworkIsolation = {
    async run() { throw new Error("network isolation invoked"); },
  };
  const runtimeEnvironment = createCommandAgentRuntimeEnvironment(process.env);

  const denied = new CommandAgentProvider({ testCommand: "true", buildCommand: "true", runtimeEnvironment }, new CommandRunner(), rejectingIsolation);
  await assert.rejects(denied.build(fixtureContext(root, specPath)), /network isolation invoked/);

  const approved = new CommandAgentProvider({
    testCommand: "true",
    buildCommand: "printf approved > src/build-agent.env",
    runtimeEnvironment,
    builderNetworkPolicy: { schemaVersion: "builder-network-policy/v1", outbound: "allow" },
  }, new CommandRunner(), rejectingIsolation);
  await approved.build(fixtureContext(root, specPath));
  assert.equal(await readFile(join(root, "src/build-agent.env"), "utf8"), "approved");

  const malformed = new CommandAgentProvider({
    testCommand: "true",
    buildCommand: "true",
    runtimeEnvironment,
    builderNetworkPolicy: { schemaVersion: "builder-network-policy/v1", outbound: "allow", repositoryOverride: true } as never,
  });
  await assert.rejects(malformed.build(fixtureContext(root, specPath)), /exact trusted runner-owned value/);
});

test("builder dependency installation defaults to denial and requires exact trusted approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-command-dependency-policy-"));
  const bin = join(root, "runner-bin");
  const specPath = join(root, ".ai", "spec.json");
  await mkdir(bin, { recursive: true });
  await mkdir(dirname(specPath), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(specPath, "{}\n");
  const fakeNpm = join(bin, "npm");
  await writeFile(fakeNpm, "#!/bin/sh\nprintf executed > src/package-manager-executed\n", { mode: 0o700 });
  await chmod(fakeNpm, 0o700);
  const runtimeEnvironment = createCommandAgentRuntimeEnvironment({ PATH: `${bin}:${process.env.PATH}` });
  const networkAllowed = { schemaVersion: "builder-network-policy/v1", outbound: "allow" } as const;
  assert.deepEqual(Object.keys(builderPackageManagerExecutablesByEcosystem), [
    "php", "javascript", "python", "ruby", "rust", "go", "jvm", "dotnet",
  ]);
  for (const executable of ["composer", "npm", "pnpm", "yarn", "pip", "poetry", "uv", "bundle", "cargo", "go", "mvn", "gradle", "dotnet"]) {
    assert.ok(Object.values(builderPackageManagerExecutablesByEcosystem).flat().includes(executable as never), executable);
  }

  for (const command of ["npm install", "sh .ai/indirect-install.sh"]) {
    await writeFile(join(root, ".ai", "indirect-install.sh"), "npm install\n");
    const denied = new CommandAgentProvider({
      testCommand: "true",
      buildCommand: command,
      runtimeEnvironment,
      builderNetworkPolicy: networkAllowed,
    });
    await assert.rejects(denied.build(fixtureContext(root, specPath)), /dependency installation is denied/);
    await assert.rejects(readFile(join(root, "src", "package-manager-executed")), /ENOENT/);
  }

  const absolute = new CommandAgentProvider({
    testCommand: "true",
    buildCommand: `${fakeNpm} install`,
    runtimeEnvironment,
    builderNetworkPolicy: networkAllowed,
  });
  await assert.rejects(absolute.build(fixtureContext(root, specPath)), /resolved through the trusted runner PATH/);
  await assert.rejects(readFile(join(root, "src", "package-manager-executed")), /ENOENT/);

  const pathBypass = new CommandAgentProvider({
    testCommand: "true",
    buildCommand: `PATH=${bin} npm install`,
    runtimeEnvironment,
    builderNetworkPolicy: networkAllowed,
  });
  await assert.rejects(pathBypass.build(fixtureContext(root, specPath)), /may not replace PATH/);

  const ordinary = new CommandAgentProvider({
    testCommand: "true",
    buildCommand: "printf ordinary > src/build-agent.env",
    runtimeEnvironment,
    builderNetworkPolicy: networkAllowed,
  });
  await ordinary.build(fixtureContext(root, specPath));
  assert.equal(await readFile(join(root, "src", "build-agent.env"), "utf8"), "ordinary");

  const approved = new CommandAgentProvider({
    testCommand: "true",
    buildCommand: "npm install",
    runtimeEnvironment,
    builderNetworkPolicy: networkAllowed,
    builderDependencyInstallationPolicy: {
      schemaVersion: "builder-dependency-installation-policy/v1",
      installation: "allow",
    },
  });
  await approved.build(fixtureContext(root, specPath));
  assert.equal(await readFile(join(root, "src", "package-manager-executed"), "utf8"), "executed");

  const malformed = new CommandAgentProvider({
    testCommand: "true",
    buildCommand: "printf unsafe > src/build-agent.env",
    runtimeEnvironment,
    builderNetworkPolicy: networkAllowed,
    builderDependencyInstallationPolicy: {
      schemaVersion: "builder-dependency-installation-policy/v1",
      installation: "allow",
      repositoryOverride: true,
    } as never,
  });
  await assert.rejects(malformed.build(fixtureContext(root, specPath)), /exact trusted runner-owned value/);
});

test("command-backed agents fail closed without an exact safe runtime", async () => {
  assert.throws(() => createCommandAgentRuntimeEnvironment({}), /safe absolute PATH/);
  assert.throws(() => createCommandAgentRuntimeEnvironment({ PATH: "bin:/usr/bin" }), /safe absolute PATH/);

  const root = await mkdtemp(join(tmpdir(), "daily-improver-command-agent-invalid-"));
  const provider = new CommandAgentProvider({
    testCommand: "true",
    buildCommand: "true",
    runtimeEnvironment: { PATH: process.env.PATH ?? "/usr/bin", EXTRA: "unsafe" } as CommandAgentRuntimeEnvironment,
  });
  await assert.rejects(provider.build(fixtureContext(root, join(root, "..", "spec.json"))), /exact runner-owned runtime environment/);
});

function fixtureContext(root: string, specPath: string): AgentContext {
  return {
    repository: root,
    specPath,
    spec: fixtureSpec,
    inputs: {
      repository: { language: "typescript", frameworks: [] },
      allowedTestPaths: ["tests"],
      protectedFiles: ["tests/**"],
      commands: [],
      testConventions: [],
      builderConventions: [],
    },
  };
}

const fixtureSpec: ImprovementSpec = {
  id: "spec-command-environment",
  improvementIntent: { schemaVersion: "improvement-intent/v1", intent: "maintainability", baselineProof: "maintainability-quality" },
  title: "Constrain command environment",
  objective: "Keep stage credentials isolated.",
  currentBehaviour: "Command agents inherit unrelated credentials.",
  proposedImprovement: "Construct an exact command environment.",
  allowedFiles: ["src/build-agent.env"],
  behavioursToPreserve: ["Commands remain executable."],
  acceptanceCriteria: ["Unrelated credentials are absent."],
  propertyInvariants: [],
  exclusions: ["Structured provider changes."],
  verification: [],
  constraints: { maxFiles: 1, maxChangedLines: 20, maxCostUsd: 1 },
  evidence: ["Environment sentinel proof."],
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

class RecordingNetworkIsolation implements BuilderNetworkIsolation {
  invocations = 0;
  private readonly runner = new CommandRunner();

  async run(
    command: readonly string[],
    cwd: string,
    timeoutMs: number,
    environment: Readonly<Record<string, string>>,
  ) {
    this.invocations += 1;
    return await this.runner.runWithExactEnvironment(command, cwd, timeoutMs, environment);
  }
}
