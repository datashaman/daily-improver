import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export interface ImproverConfig {
  readonly version: 1;
  readonly schedule: { readonly timezone: string; readonly time: string };
  readonly selection: { readonly priorities: readonly string[] };
  readonly analysis: {
    readonly php: { readonly complexity_tool: "auto" | "phpmetrics" | "off" };
  };
  readonly limits: {
    readonly max_changed_files: number;
    readonly max_diff_lines: number;
    readonly max_open_prs: number;
    readonly max_cost_usd: number;
  };
  readonly protected_paths: readonly string[];
  readonly verification: {
    readonly commands: readonly string[];
    readonly mutation_testing: "off" | "targeted" | "full";
  };
  readonly pull_request: { readonly draft: boolean; readonly labels: readonly string[] };
}

export const defaultConfig: ImproverConfig = {
  version: 1,
  schedule: { timezone: "UTC", time: "05:00" },
  selection: { priorities: ["correctness", "static-analysis", "maintainability"] },
  analysis: { php: { complexity_tool: "auto" } },
  limits: { max_changed_files: 5, max_diff_lines: 250, max_open_prs: 3, max_cost_usd: 5 },
  protected_paths: [".github/**", "infrastructure/**", "database/migrations/**", "tests/Property/**"],
  verification: { commands: [], mutation_testing: "targeted" },
  pull_request: { draft: true, labels: ["ai-improvement"] },
};

export async function loadConfig(root: string): Promise<ImproverConfig> {
  let value: unknown;
  try {
    value = parse(await readFile(join(root, ".ai", "improver.yml"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig;
    throw error;
  }
  if (!isRecord(value) || value.version !== 1) throw new Error(".ai/improver.yml must use version: 1");
  const schedule = record(value.schedule, "schedule");
  const limits = record(value.limits, "limits");
  const selection = record(value.selection, "selection");
  const analysis = value.analysis === undefined ? undefined : record(value.analysis, "analysis");
  const phpAnalysis = analysis?.php === undefined ? undefined : record(analysis.php, "analysis.php");
  const verification = record(value.verification, "verification");
  const pullRequest = record(value.pull_request, "pull_request");
  return {
    version: 1,
    schedule: { timezone: string(schedule.timezone, "schedule.timezone"), time: time(schedule.time) },
    selection: { priorities: strings(selection.priorities, "selection.priorities") },
    analysis: {
      php: {
        complexity_tool: complexityTool(phpAnalysis?.complexity_tool),
      },
    },
    limits: {
      max_changed_files: positive(limits.max_changed_files, "limits.max_changed_files"),
      max_diff_lines: positive(limits.max_diff_lines, "limits.max_diff_lines"),
      max_open_prs: positive(limits.max_open_prs, "limits.max_open_prs"),
      max_cost_usd: typeof limits.max_cost_usd === "number" ? limits.max_cost_usd : defaultConfig.limits.max_cost_usd,
    },
    protected_paths: strings(value.protected_paths, "protected_paths"),
    verification: {
      commands: strings(verification.commands, "verification.commands"),
      mutation_testing: mutationMode(verification.mutation_testing),
    },
    pull_request: { draft: Boolean(pullRequest.draft), labels: strings(pullRequest.labels, "pull_request.labels") },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function record(value: unknown, name: string): Record<string, unknown> { if (!isRecord(value)) throw new Error(`${name} must be a mapping`); return value; }
function string(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`); return value; }
function strings(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name} must be a string list`); return value as string[]; }
function positive(value: unknown, name: string): number { if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`); return value as number; }
function time(value: unknown): string { const result = string(value, "schedule.time"); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) throw new Error("schedule.time must be HH:MM"); return result; }
function mutationMode(value: unknown): "off" | "targeted" | "full" { if (value !== "off" && value !== "targeted" && value !== "full") throw new Error("verification.mutation_testing must be off, targeted, or full"); return value; }
function complexityTool(value: unknown): "auto" | "phpmetrics" | "off" { if (value === undefined) return "auto"; if (value !== "auto" && value !== "phpmetrics" && value !== "off") throw new Error("analysis.php.complexity_tool must be auto, phpmetrics, or off"); return value; }
