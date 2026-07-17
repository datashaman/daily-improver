import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandRunner } from "../infra/command-runner.js";

export interface SourceSafetyReport {
  readonly allowed: boolean;
  readonly violations: readonly string[];
}

export class SourceSafetyInspector {
  constructor(private readonly runner = new CommandRunner()) {}

  async inspect(root: string, base: string, protectedTestFiles: readonly string[]): Promise<SourceSafetyReport> {
    const patch = await this.runner.run(["git", "diff", "--unified=0", base], root);
    if (patch.exitCode !== 0) throw new Error(`Unable to inspect source patch: ${patch.stderr.trim()}`);
    const additions: string[] = [];
    const productionAdditions: string[] = [];
    let currentFile = "";
    for (const line of patch.stdout.split("\n")) {
      if (line.startsWith("+++ b/")) { currentFile = line.slice(6); continue; }
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      additions.push(line.slice(1));
      if (/^(?:app|src)\/.*\.php$/.test(currentFile)) productionAdditions.push(line.slice(1));
    }
    const violations: string[] = [];
    if (additions.some((line) => /@phpstan-ignore|@psalm-suppress|ignoreErrors/.test(line))) {
      violations.push("Patch introduces a static-analysis suppression.");
    }
    if (/catch\s*\(\s*\\?(?:Throwable|Exception)\b[^)]*\)\s*\{\s*\}/s.test(productionAdditions.join("\n"))) {
      violations.push("Patch introduces broad exception swallowing.");
    }
    if (productionAdditions.some((line) => /^\s*public\s+function\s+/.test(line))) {
      violations.push("Patch adds a public method; explicit human approval is required for API changes.");
    }
    for (const file of protectedTestFiles.filter((path) => /(?:^|\/)Property\//.test(path))) {
      const source = await readFile(join(root, file), "utf8");
      const hasIteration = /\b(?:for|foreach|dataset|with)\s*\(/.test(source) || /->with\s*\(/.test(source);
      const hasAssertion = /(?:assert|expect|throw new)/i.test(source);
      if (!hasIteration || !hasAssertion || source.split("\n").length < 8) {
        violations.push(`Property test is too trivial: ${file}`);
      }
    }
    return { allowed: violations.length === 0, violations };
  }
}
