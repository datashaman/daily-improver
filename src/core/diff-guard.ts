import { minimatch } from "minimatch";
import type { ImprovementSpec } from "../domain/model.js";
import { CommandRunner } from "../infra/command-runner.js";

export interface DiffInspection {
  readonly allowed: boolean;
  readonly files: readonly string[];
  readonly changedLines: number;
  readonly violations: readonly string[];
}

export class DiffGuard {
  constructor(private readonly runner = new CommandRunner()) {}

  async inspect(root: string, base: string, spec: ImprovementSpec, protectedPaths: readonly string[], trustedPaths: ReadonlySet<string> = new Set()): Promise<DiffInspection> {
    const result = await this.runner.run(["git", "diff", "--numstat", base], root);
    if (result.exitCode !== 0) throw new Error(`Unable to inspect diff: ${result.stderr.trim()}`);
    const entries = result.stdout.trim() ? result.stdout.trim().split("\n").map(parseNumstat) : [];
    const files = entries.map((entry) => entry.file);
    const boundedEntries = entries.filter((entry) => !entry.file.startsWith(".ai/runs/"));
    const changedLines = boundedEntries.reduce((sum, entry) => sum + entry.added + entry.deleted, 0);
    const violations: string[] = [];
    for (const file of files) {
      if (protectedPaths.some((pattern) => minimatch(file, pattern)) && !trustedPaths.has(file)) violations.push(`Untrusted change to protected path: ${file}`);
      if (!trustedPaths.has(file) && !spec.allowedFiles.some((pattern) => matchesAllowlist(file, pattern))) violations.push(`File is outside spec allowlist: ${file}`);
    }
    if (boundedEntries.length > spec.constraints.maxFiles) violations.push(`Changed ${boundedEntries.length} product files; maximum is ${spec.constraints.maxFiles}.`);
    if (changedLines > spec.constraints.maxChangedLines) violations.push(`Changed ${changedLines} lines; maximum is ${spec.constraints.maxChangedLines}.`);
    return { allowed: violations.length === 0, files, changedLines, violations };
  }
}

function parseNumstat(line: string): { added: number; deleted: number; file: string } {
  const [added = "0", deleted = "0", file = ""] = line.split("\t");
  return { added: added === "-" ? 0 : Number(added), deleted: deleted === "-" ? 0 : Number(deleted), file };
}

function matchesAllowlist(file: string, pattern: string): boolean {
  return file === pattern || file.startsWith(`${pattern.replace(/\/$/, "")}/`) || minimatch(file, pattern);
}
