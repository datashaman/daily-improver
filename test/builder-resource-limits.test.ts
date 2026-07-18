import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CommandAgentProvider, createCommandAgentRuntimeEnvironment } from "../src/agents/command-agent-provider.js";
import {
  PlatformBuilderResourceIsolation,
  validateBuilderResourceLimits,
} from "../src/agents/builder-resource-limits.js";
import type { BuilderResourceLimits } from "../src/agents/builder-resource-limits.js";
import type { AgentContext } from "../src/agents/agent-provider.js";
import type { ImprovementSpec } from "../src/domain/model.js";

const networkAllowed = { schemaVersion: "builder-network-policy/v1", outbound: "allow" } as const;
const installationAllowed = {
  schemaVersion: "builder-dependency-installation-policy/v1",
  installation: "allow",
} as const;

test("requires exact bounded trusted runner resource decisions before builder execution", async () => {
  assert.throws(() => validateBuilderResourceLimits(undefined), /exact trusted runner-owned value/);
  for (const malformed of [
    { ...limits(), schemaVersion: "builder-resource-limits/v2" },
    { ...limits(), outputBytes: 1_023 },
    { ...limits(), memoryBytes: Number.NaN },
    { ...limits(), cpuTimeMs: 2_001, wallClockMs: 2_000 },
    { ...limits(), repositoryOverride: true },
  ]) {
    assert.throws(() => validateBuilderResourceLimits(malformed as BuilderResourceLimits), /Builder/);
  }
  await assert.rejects(
    new PlatformBuilderResourceIsolation("win32").run(
      ["/bin/sh", "-c", "true"], "/tmp", limits(), { PATH: "/usr/bin:/bin" }, async () => {
        throw new Error("builder must not run");
      },
    ),
    /unavailable on this runner platform/,
  );
});

test("classifies CPU exhaustion across builder child processes", async () => {
  const command = `${process.execPath} -e "require('node:child_process').spawn('/bin/sh',['-c','while :; do :; done'],{stdio:'ignore'});setInterval(()=>{},1000)"`;
  await assert.rejects(runBuilder(command, { cpuTimeMs: 100, wallClockMs: 3_000 }), /exhausted its cpu resource limit/);
});

test("classifies aggregate builder memory exhaustion", async () => {
  const command = `${process.execPath} -e "const held=[];setInterval(()=>held.push(Buffer.alloc(8*1024*1024,1)),10)"`;
  await assert.rejects(
    runBuilder(command, { memoryBytes: 32 * 1024 * 1024, wallClockMs: 3_000, cpuTimeMs: 2_000 }),
    /exhausted its memory resource limit/,
  );
});

test("classifies builder disk exhaustion", async () => {
  await assert.rejects(
    runBuilder("dd if=/dev/zero of=src/fill.bin bs=2048 count=2", { diskBytes: 1_024 }),
    /exhausted its disk resource limit/,
  );
});

test("bounds retained builder output and classifies exhaustion", async () => {
  const error = await assert.rejects(
    runBuilder(`${process.execPath} -e "process.stdout.write('sensitive-output-'.repeat(10000))"`, { outputBytes: 1_024 }),
    /exhausted its output resource limit/,
  );
  assert.doesNotMatch(String(error), /sensitive-output/);
});

test("classifies wall-clock exhaustion and kills the complete builder process group", async () => {
  const root = await fixtureRoot();
  const escapedSentinel = join(root, "src", "late-child-write");
  const command = `(sleep 1; printf survived > ${escapedSentinel}) & sleep 10`;
  await assert.rejects(runBuilder(command, { wallClockMs: 100, cpuTimeMs: 100 }, root), /exhausted its wall-clock resource limit/);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await assert.rejects(access(escapedSentinel), /ENOENT/);
});

async function runBuilder(
  command: string,
  overrides: Partial<BuilderResourceLimits>,
  suppliedRoot?: string,
): Promise<void> {
  const root = suppliedRoot ?? await fixtureRoot();
  const specPath = join(root, ".ai", "spec.json");
  const provider = new CommandAgentProvider({
    testCommand: "true",
    buildCommand: command,
    runtimeEnvironment: createCommandAgentRuntimeEnvironment(process.env),
    builderNetworkPolicy: networkAllowed,
    builderDependencyInstallationPolicy: installationAllowed,
    builderResourceLimits: limits(overrides),
  });
  await provider.build(fixtureContext(root, specPath));
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-builder-resources-"));
  const specPath = join(root, ".ai", "spec.json");
  await mkdir(dirname(specPath), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(specPath, "{}\n");
  return root;
}

function limits(overrides: Partial<BuilderResourceLimits> = {}): BuilderResourceLimits {
  return {
    schemaVersion: "builder-resource-limits/v1",
    cpuTimeMs: 1_000,
    memoryBytes: 256 * 1024 * 1024,
    diskBytes: 16 * 1024 * 1024,
    outputBytes: 64 * 1024,
    wallClockMs: 2_000,
    ...overrides,
  };
}

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
  id: "spec-builder-resources",
  improvementIntent: { schemaVersion: "improvement-intent/v1", intent: "maintainability", baselineProof: "maintainability-quality" },
  title: "Bound builder resources",
  objective: "Stop resource exhaustion.",
  currentBehaviour: "Builder execution is unbounded.",
  proposedImprovement: "Enforce runner-owned resource limits.",
  allowedFiles: ["src/result.ts"],
  behavioursToPreserve: ["Builder isolation remains active."],
  acceptanceCriteria: ["Every resource is bounded."],
  propertyInvariants: [],
  exclusions: ["Test-agent limits."],
  verification: [],
  constraints: { maxFiles: 1, maxChangedLines: 20, maxCostUsd: 1 },
  evidence: ["Resource exhaustion proofs."],
};
