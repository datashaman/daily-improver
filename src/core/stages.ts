import { loadConfig } from "../config.js";
import type { ImprovementSpec } from "../domain/model.js";
import { relative } from "node:path";
import { CommandRunner } from "../infra/command-runner.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { createTestManifest, readArtifact, runDirectory, verifyTestManifest, writeArtifact, type AnalysisArtifact, type TestManifest } from "./artifacts.js";
import { DiffGuard } from "./diff-guard.js";
import { SourceSafetyInspector } from "./source-safety.js";
import { rankCandidates } from "./ranking.js";
import { createSpec } from "./specification.js";

export class PipelineStages {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly runner = new CommandRunner(),
  ) {}

  async resolveAdapter(root: string) {
    return await this.registry.resolve(root);
  }

  async analyse(root: string): Promise<AnalysisArtifact> {
    const adapter = await this.registry.resolve(root);
    const profile = await adapter.profile(root);
    const artifact: AnalysisArtifact = {
      schema: 1,
      repository: root,
      adapter: adapter.id,
      generatedAt: new Date().toISOString(),
      candidates: rankCandidates(await adapter.discoverCandidates(profile)),
    };
    await writeArtifact(root, "candidate.json", artifact);
    return artifact;
  }

  async specify(root: string): Promise<ImprovementSpec> {
    const analysis = await readArtifact<AnalysisArtifact>(root, "candidate.json");
    const selected = analysis.candidates[0];
    if (!selected) throw new Error("Analysis produced no candidate to specify.");
    const adapter = await this.registry.resolve(root);
    const profile = await adapter.profile(root);
    const config = await loadConfig(root);
    const spec = createSpec(selected, profile, {
      maxFiles: config.limits.max_changed_files,
      maxChangedLines: config.limits.max_diff_lines,
      maxCostUsd: config.limits.max_cost_usd,
    });
    await writeArtifact(root, "spec.json", spec);
    return spec;
  }

  async protectTests(root: string): Promise<TestManifest> {
    const key = requiredSecret("DAILY_IMPROVER_MANIFEST_KEY");
    const manifest = await createTestManifest(root, key);
    await writeArtifact(root, "test-manifest.json", manifest);
    return manifest;
  }

  async build(root: string): Promise<{ command: string; exitCode: number }> {
    const command = process.env.DAILY_IMPROVER_BUILDER_COMMAND;
    if (!command) throw new Error("Builder provider is not configured. Set DAILY_IMPROVER_BUILDER_COMMAND in the isolated builder job.");
    const result = await this.runner.run(["/bin/sh", "-lc", command], root);
    if (result.exitCode !== 0) throw new Error(`Builder failed: ${result.stderr || result.stdout}`);
    return { command, exitCode: result.exitCode };
  }

  async verify(root: string, base = process.env.DAILY_IMPROVER_BASE_REF ?? "origin/main", manifestKey?: string) {
    const key = manifestKey ?? requiredSecret("DAILY_IMPROVER_MANIFEST_KEY");
    const config = await loadConfig(root);
    const spec = await readArtifact<ImprovementSpec>(root, "spec.json");
    const manifest = await readArtifact<TestManifest>(root, "test-manifest.json");
    if (!(await verifyTestManifest(root, manifest, key))) throw new Error("Protected test manifest is invalid or a protected test changed.");
    const trustedPaths = new Set(Object.keys(manifest.files));
    trustedPaths.add(relative(root, `${runDirectory(root)}/test-manifest.json`));
    const diff = await new DiffGuard(this.runner).inspect(root, base, spec, config.protected_paths, trustedPaths);
    const sourceSafety = await new SourceSafetyInspector(this.runner).inspect(root, base, Object.keys(manifest.files));
    const checks = [];
    for (const command of config.verification.commands) {
      const result = await this.runner.run(["/bin/sh", "-lc", command], root);
      checks.push({ command, exitCode: result.exitCode, durationMs: result.durationMs });
      if (result.exitCode !== 0) break;
    }
    const passed = diff.allowed && sourceSafety.allowed && checks.every((check) => check.exitCode === 0);
    const report = { passed, base, diff, sourceSafety, checks, verifiedAt: new Date().toISOString() };
    await writeArtifact(root, "verification.json", report);
    if (!passed) throw new Error(`Verification failed: ${[...diff.violations, ...sourceSafety.violations, ...checks.filter((c) => c.exitCode !== 0).map((c) => `Command failed: ${c.command}`)].join("; ")}`);
    return report;
  }

  async publicationRequest(root: string): Promise<{ title: string; body: string; draft: boolean; labels: readonly string[] }> {
    const config = await loadConfig(root);
    const spec = await readArtifact<ImprovementSpec>(root, "spec.json");
    const verification = await readArtifact<{ passed: boolean; checks: readonly { command: string; exitCode: number }[] }>(root, "verification.json");
    const testPlan = await optionalArtifact<{ baseline?: string; propertyInvariants?: readonly string[] }>(root, "test-plan.json");
    if (!verification.passed) throw new Error("Cannot publish an unverified improvement.");
    const request = {
      title: spec.title,
      body: `## Improvement\n${spec.objective}\n\n## Evidence\n${spec.evidence.map((item) => `- ${item}`).join("\n")}\n\n## Verification\n${testPlan?.baseline === "failed-as-expected" ? "- Regression/property test failed against main and passed after the change.\n- The targeted surviving behavior is now detected.\n" : ""}${verification.checks.map((check) => `- ${check.command}: passed`).join("\n")}\n\n## Risk\nBounded to ${spec.constraints.maxFiles} files and ${spec.constraints.maxChangedLines} changed lines.`,
      draft: config.pull_request.draft,
      labels: config.pull_request.labels,
    };
    await writeArtifact(root, "publication-request.json", request);
    return request;
  }
}

async function optionalArtifact<T>(root: string, name: string): Promise<T | undefined> {
  try { return await readArtifact<T>(root, name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for this isolated stage.`);
  return value;
}
