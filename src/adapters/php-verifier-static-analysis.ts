import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { StaticAnalysisExecution, StaticAnalysisPlan, StaticAnalysisResult } from "../domain/static-analysis-findings.js";
import { staticAnalysisHash } from "../domain/static-analysis-findings.js";
import { readJson } from "./shared.js";
import {
  parsePhpStaticAnalysisOutput,
  phpStaticAnalysisCommand,
  phpStaticAnalysisConfigurationPaths,
  type StaticAnalysisTool,
} from "./php-static-analysis.js";

const findingIdentitySemantics = "php-static-analysis-path-rule-message/v1";

interface ComposerManifest {
  readonly require?: Readonly<Record<string, string>>;
  readonly "require-dev"?: Readonly<Record<string, string>>;
}

export async function preparePhpVerifierStaticAnalysis(root: string): Promise<StaticAnalysisPlan> {
  const manifest = await readJson<ComposerManifest>(root, "composer.json");
  const packages = { ...manifest.require, ...manifest["require-dev"] };
  const tool: StaticAnalysisTool | undefined = packages["phpstan/phpstan"] || packages["larastan/larastan"] || packages["nunomaduro/larastan"]
    ? "phpstan"
    : packages["vimeo/psalm"] ? "psalm" : undefined;
  if (!tool) throw new Error("Verifier static analysis is unavailable because PHPStan or Psalm is not manifest-declared.");
  const executable = await containedRegularFile(root, `vendor/bin/${tool}`);
  if (!executable) throw new Error("Verifier static-analysis tool is unavailable.");
  return {
    schemaVersion: "static-analysis-plan/v1",
    adapter: "php",
    tool,
    configurationSha256: await configurationIdentity(root, tool),
    targetScope: "repository-configured",
    command: phpStaticAnalysisCommand(tool),
    timeoutMs: 120_000,
  };
}

export async function inspectPhpVerifierStaticAnalysis(
  root: string,
  plan: StaticAnalysisPlan,
  execution: StaticAnalysisExecution,
): Promise<StaticAnalysisResult> {
  if (plan.adapter !== "php" || (plan.tool !== "phpstan" && plan.tool !== "psalm")) throw new Error("Verifier static-analysis plan was redirected to an unsupported adapter or tool.");
  const tool = plan.tool;
  if (plan.configurationSha256 !== await configurationIdentity(root, tool)) throw new Error("Verifier static-analysis configuration changed before inspection.");
  if (execution.resourceExhausted) throw new Error("Verifier static analysis exhausted a bounded resource.");
  if (Buffer.byteLength(execution.stdout) > 512 * 1024 || Buffer.byteLength(execution.stderr) > 512 * 1024) {
    throw new Error("Verifier static-analysis output is excessive.");
  }
  let parsed;
  try {
    parsed = parsePhpStaticAnalysisOutput(tool, root, execution.stdout);
  } catch {
    throw new Error("Verifier static-analysis output is malformed.");
  }
  const supportedExit = tool === "phpstan" ? execution.exitCode === 0 || execution.exitCode === 1 : execution.exitCode === 0 || execution.exitCode === 2;
  if (!supportedExit || parsed.globalErrors.length > 0 || (execution.exitCode !== 0 && parsed.findings.length === 0)) {
    throw new Error("Verifier static analysis was unavailable or failed outside supported findings semantics.");
  }
  if (parsed.findings.length > 10_000) throw new Error("Verifier static-analysis findings are excessive.");
  const findingIdentities = [...new Set(parsed.findings.map((finding) => staticAnalysisHash(JSON.stringify([
    findingIdentitySemantics,
    finding.tool,
    finding.file,
    finding.rule,
    finding.message,
  ]))))].sort();
  return {
    schemaVersion: "static-analysis-result/v1",
    adapter: "php",
    tool,
    configurationSha256: plan.configurationSha256,
    targetScope: "repository-configured",
    outcome: "completed",
    findingIdentitySemantics,
    findingIdentities,
    durationMs: execution.durationMs,
    stdoutSha256: staticAnalysisHash(execution.stdout),
    stderrSha256: staticAnalysisHash(execution.stderr),
  };
}

async function configurationIdentity(root: string, tool: StaticAnalysisTool): Promise<string> {
  const entries: { readonly path: string; readonly status: "absent" | "hashed"; readonly sha256?: string }[] = [];
  for (const path of phpStaticAnalysisConfigurationPaths(tool)) {
    try {
      const absolute = await containedRegularFile(root, path);
      if (!absolute) throw new Error("Verifier static-analysis configuration is unavailable.");
      const metadata = await lstat(absolute);
      if (metadata.size > 256 * 1024) throw new Error("Verifier static-analysis configuration is excessive.");
      entries.push({ path, status: "hashed", sha256: staticAnalysisHash(await readFile(absolute)) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries.push({ path, status: "absent" });
    }
  }
  return staticAnalysisHash(JSON.stringify(["php-verifier-static-analysis-configuration/v1", tool, entries]));
}

async function containedRegularFile(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const lexical = join(canonicalRoot, path);
  const metadata = await lstat(lexical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Verifier static-analysis input is not a regular file: ${path}`);
  const canonical = await realpath(lexical);
  if (canonical !== lexical || (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`))) {
    throw new Error(`Verifier static-analysis input escaped the checkout: ${path}`);
  }
  return canonical;
}
