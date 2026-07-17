import { cp } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AgentContext, AgentProvider, BuilderExecution, TestAgentExecution } from "../agents/agent-provider.js";
import { loadConfig } from "../config.js";
import { CommandRunner } from "../infra/command-runner.js";
import { GitWorkspaceManager } from "../infra/git-workspace.js";
import { createTestManifest, runDirectory, writeArtifact } from "./artifacts.js";
import type { PipelineStages } from "./stages.js";

export interface LocalRunResult {
  readonly branch: string;
  readonly candidate: string;
  readonly baselineTestFailed: boolean;
  readonly verificationPassed: boolean;
  readonly publication: { readonly title: string; readonly body: string; readonly draft: boolean; readonly labels: readonly string[] };
}

export class LocalImprovementRunner {
  constructor(
    private readonly stages: PipelineStages,
    private readonly agents: AgentProvider,
    private readonly workspaceBase: string,
    private readonly manifestKey: string,
    private readonly runner = new CommandRunner(),
  ) {}

  async run(repository: string): Promise<LocalRunResult> {
    const analysis = await this.stages.analyse(repository);
    const spec = await this.stages.specify(repository);
    const date = process.env.DAILY_IMPROVER_RUN_DATE ?? new Date().toISOString().slice(0, 10);
    const slug = slugify(spec.title).slice(0, 42);
    const branch = `ai/daily/${date}-${slug}`;
    const isolated = await new GitWorkspaceManager(this.workspaceBase, this.runner).create(repository, `${date}-${slug}`, branch);
    try {
      await cp(runDirectory(repository), runDirectory(isolated.path), { recursive: true });
      const specPath = join(runDirectory(isolated.path), "spec.json");
      const adapter = await this.stagesAdapter(isolated.path);
      const profile = await adapter.profile(isolated.path);
      const config = await loadConfig(isolated.path);
      const test = profile.capabilities.get("test");
      if (!test) throw new Error("A test capability is required for autonomous correctness work.");
      const allowedTestPaths = config.protected_paths.filter((path) => path === "tests" || path === "test" || path.startsWith("tests/") || path.startsWith("test/"));
      if (allowedTestPaths.length === 0) throw new Error("At least one protected test path is required for model-generated tests.");
      const commands = spec.verification.flatMap((kind) => {
        const capability = profile.capabilities.get(kind);
        return capability ? [{ purpose: kind, argv: capability.command }] : [];
      });
      const baseContext: AgentContext = {
        repository: isolated.path,
        spec,
        specPath,
        inputs: {
          repository: { language: profile.language, frameworks: profile.frameworks },
          allowedTestPaths,
          protectedFiles: [],
          commands,
          testConventions: ["Add focused regression or property tests using the repository test harness."],
          builderConventions: ["Implement only the approved specification and preserve existing public interfaces."],
        },
      };
      const testExecution = await this.agents.generateTests(baseContext);
      await persistExecution(isolated.path, "test", testExecution);

      const baseline = await this.runner.run(test.command, isolated.path);
      if (baseline.exitCode === 0) throw new Error("Generated regression test did not fail against main behavior.");
      await writeArtifact(isolated.path, "test-plan.json", {
        schema: 1,
        baseline: "failed-as-expected",
        command: test.command,
        propertyInvariants: spec.propertyInvariants,
      });
      const manifest = await createTestManifest(isolated.path, this.manifestKey);
      await writeArtifact(isolated.path, "test-manifest.json", manifest);

      const builderContext: AgentContext = {
        ...baseContext,
        inputs: {
          ...baseContext.inputs,
          protectedFiles: [...new Set([...config.protected_paths, ...Object.keys(manifest.files)])],
        },
      };
      const builderExecution = await this.agents.build(builderContext);
      const trustedBuilderArtifacts = await persistExecution(isolated.path, "build", builderExecution);
      await this.runner.run(["git", "add", "-N", "."], isolated.path);
      const verification = await this.stages.verify(isolated.path, "HEAD", this.manifestKey, trustedBuilderArtifacts);
      const publication = await this.stages.publicationRequest(isolated.path);
      await this.runner.run(["git", "add", "."], isolated.path);
      const commit = await this.runner.run(["git", "commit", "-m", `fix: ${spec.title}`], isolated.path);
      if (commit.exitCode !== 0) throw new Error(`Unable to commit verified improvement: ${commit.stderr.trim()}`);
      return {
        branch: isolated.branch,
        candidate: analysis.candidates[0]?.id ?? "unknown",
        baselineTestFailed: true,
        verificationPassed: verification.passed,
        publication,
      };
    } finally {
      await isolated.cleanup();
    }
  }

  private async stagesAdapter(root: string) {
    return await this.stages.resolveAdapter(root);
  }
}

async function persistExecution(
  root: string,
  stage: "test" | "build",
  execution: TestAgentExecution | BuilderExecution | void,
): Promise<readonly string[]> {
  if (!execution) return [];
  const usagePath = await writeArtifact(root, `${stage}-agent-usage.json`, {
    schemaVersion: execution.budgetDecision ? "agent-usage/v2" : "agent-usage/v1",
    stage,
    ...execution.usage,
    ...(execution.budgetDecision ? { budgetDecision: execution.budgetDecision } : {}),
  });
  const rationalePath = await writeArtifact(root, `${stage}-agent-rationale.json`, {
    schemaVersion: "agent-rationale/v1",
    trust: "untrusted-model-output",
    stage,
    ...execution.rationale,
  });
  return [relative(root, usagePath), relative(root, rationalePath)];
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
