import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import JSON5 from "json5";
import type { TargetedMutationExecution, TargetedMutationPlan, TargetedMutationResult } from "../domain/targeted-mutation.js";
import { targetedMutationOutputHash } from "../domain/targeted-mutation.js";
import { throwRequiredVerifierUnavailable } from "../domain/required-verifier.js";

const reportLimitBytes = 2 * 1024 * 1024;
const configurationLimitBytes = 512 * 1024;
const configurationArtifact = ".daily-improver/verifier-targeted-infection.json";
const reportArtifact = ".daily-improver/verifier-targeted-infection-report.json";
const configurationNames = ["infection.json5", "infection.json", "infection.json5.dist", "infection.json.dist"] as const;
const inventorySemantics = "php-infection-mutator-location/v1";

export async function preparePhpTargetedMutation(root: string, targets: readonly string[]): Promise<TargetedMutationPlan> {
  const composer = exactRecord(JSON.parse(await readFile(join(root, "composer.json"), "utf8")), "Composer manifest");
  const packages = { ...optionalPackageMap(composer.require), ...optionalPackageMap(composer["require-dev"]) };
  if (typeof packages["infection/infection"] !== "string") {
    throwRequiredVerifierUnavailable("targeted-mutation", "tool", "tool-unavailable", "php:infection");
  }
  await assertContainedExecutable(root, "vendor/bin/infection");
  const exactTargets = [...targets].sort();
  if (exactTargets.length < 1 || exactTargets.some((target) => !/^(?:app|src)\/.+\.php$/u.test(target))) {
    throw new Error("Targeted PHP mutation testing received an unsupported or empty production target set.");
  }
  const selectedConfiguration = await repositoryConfiguration(root);
  const base = selectedConfiguration === undefined ? {} : await readConfiguration(selectedConfiguration);
  const configPath = join(root, configurationArtifact);
  const reportPath = join(root, reportArtifact);
  await ensureContainedArtifactDirectory(root, dirname(configPath));
  await Promise.all([rm(configPath, { force: true }), rm(reportPath, { force: true })]);
  const source = isRecord(base.source)
    ? base.source
    : { directories: [...new Set(exactTargets.map((target) => dirname(target)))] };
  await writeFile(configPath, `${JSON.stringify({ ...base, source, logs: { json: reportPath } }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    schemaVersion: "targeted-mutation-plan/v1",
    adapter: "php",
    tool: "infection",
    mode: "targeted",
    targets: exactTargets,
    command: [
      "vendor/bin/infection",
      `--configuration=${configPath}`,
      `--filter=${exactTargets.join(",")}`,
      "--threads=1",
      "--no-progress",
      "--show-mutations=0",
      "--no-interaction",
    ],
    timeoutMs: 10 * 60_000,
    reportArtifact,
  };
}

export async function inspectPhpTargetedMutation(
  root: string,
  plan: TargetedMutationPlan,
  execution: TargetedMutationExecution,
): Promise<TargetedMutationResult> {
  try {
    if (plan.adapter !== "php" || plan.tool !== "infection" || plan.reportArtifact !== reportArtifact) {
      throw new Error("Targeted PHP mutation plan is unsupported or redirected.");
    }
    if (!Number.isInteger(execution.exitCode) || execution.exitCode < 0) throw new Error("Targeted Infection exit status is malformed.");
    const absoluteReport = await containedRegularFile(root, plan.reportArtifact);
    const metadata = await stat(absoluteReport);
    if (metadata.size < 1 || metadata.size > reportLimitBytes) throw new Error("Targeted Infection report is missing or excessive.");
    const bytes = await readFile(absoluteReport);
    const report = exactRecord(JSON.parse(bytes.toString("utf8")), "Targeted Infection report");
    const stats = exactRecord(report.stats, "Targeted Infection statistics");
    const total = count(stats.totalMutantsCount, "total");
    const killed = count(stats.killedCount, "killed");
    const escaped = count(stats.escapedCount, "escaped");
    const notCovered = count(stats.notCoveredCount, "not-covered");
    const errors = count(stats.errorCount, "error");
    const syntaxErrors = count(stats.syntaxErrorCount, "syntax-error");
    const timeouts = count(stats.timeOutCount, "timeout");
    if (total < 1) throw new Error("Targeted Infection did not execute any mutations.");
    const killedRows = mutationRows(report.killed, "killed");
    const escapedRows = mutationRows(report.escaped, "escaped");
    const uncoveredRows = mutationRows(report.uncovered, "not-covered");
    const errorRows = mutationRows(report.errored, "error");
    const syntaxErrorRows = mutationRows(report.syntaxErrors, "syntax-error");
    const timeoutRows = mutationRows(report.timeouted, "timeout");
    if (killedRows.length !== killed || escapedRows.length !== escaped || uncoveredRows.length !== notCovered
      || errorRows.length !== errors || syntaxErrorRows.length !== syntaxErrors || timeoutRows.length !== timeouts
      || killed + escaped + notCovered + errors + syntaxErrors + timeouts !== total) {
      throw new Error("Targeted Infection statistics do not match its bounded mutation inventory.");
    }
    const inventory: string[] = [];
    for (const row of [...killedRows, ...escapedRows, ...uncoveredRows, ...errorRows, ...syntaxErrorRows, ...timeoutRows]) {
      const mutation = exactRecord(row.value, `Targeted Infection ${row.status} mutation`);
      const mutator = exactRecord(mutation.mutator, `Targeted Infection ${row.status} mutator`);
      const file = mutationFile(root, mutator.originalFilePath);
      if (!plan.targets.includes(file)) throw new Error("Targeted Infection output escaped the exact changed production targets.");
      const mutatorName = mutationIdentity(mutator.mutatorName, "mutator name");
      const originalStartLine = mutationLine(mutator.originalStartLine);
      inventory.push(JSON.stringify([file, originalStartLine, mutatorName]));
    }
    if (errors !== 0 || syntaxErrors !== 0 || timeouts !== 0) throw new Error("Targeted Infection reported an incomplete mutation run.");
    if (killed + escaped + notCovered > total) throw new Error("Targeted Infection statistics are inconsistent.");
    if (execution.exitCode !== 0 && escaped === 0 && notCovered === 0) throw new Error("Targeted Infection command failed without a bounded mutation outcome.");
    return {
      schemaVersion: "targeted-mutation-result/v2",
      adapter: "php",
      tool: "infection",
      mode: "targeted",
      targets: plan.targets,
      outcome: "completed",
      inventorySemantics,
      inventorySha256: targetedMutationOutputHash(JSON.stringify([inventorySemantics, ...inventory.sort()])),
      mutants: { total, killed, escaped, notCovered },
      durationMs: execution.durationMs,
      stdoutSha256: targetedMutationOutputHash(execution.stdout),
      stderrSha256: targetedMutationOutputHash(execution.stderr),
      reportSha256: targetedMutationOutputHash(bytes),
    };
  } finally {
    await cleanupArtifacts(root);
  }
}

async function ensureContainedArtifactDirectory(root: string, directory: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Targeted Infection artifact directory is unsafe.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { mode: 0o700 });
  }
  const canonical = await realpath(directory);
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error("Targeted Infection artifact directory escapes the verifier checkout.");
}

async function cleanupArtifacts(root: string): Promise<void> {
  const directory = dirname(join(root, configurationArtifact));
  try { await ensureContainedArtifactDirectory(root, directory); }
  catch { return; }
  await Promise.all([
    rm(join(root, configurationArtifact), { force: true }),
    rm(join(root, reportArtifact), { force: true }),
  ]);
}

function mutationRows(value: unknown, status: string): readonly { readonly status: string; readonly value: unknown }[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error(`Targeted Infection ${status} mutation inventory is malformed or excessive.`);
  return value.map((row) => ({ status, value: row }));
}

function mutationFile(root: string, value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0")) throw new Error("Targeted Infection mutation path is malformed.");
  const normalized = value.replaceAll("\\", "/");
  if (!normalized.startsWith("/")) {
    if (normalized.startsWith("../") || normalized.split("/").includes("..")) throw new Error("Targeted Infection output escaped its targets.");
    return normalized.replace(/^\.\//u, "");
  }
  const relativePath = relative(root, normalized).replaceAll("\\", "/");
  if (!relativePath || relativePath.startsWith("../")) throw new Error("Targeted Infection output escaped its targets.");
  return relativePath;
}

async function repositoryConfiguration(root: string): Promise<string | undefined> {
  for (const name of configurationNames) {
    try {
      const path = await containedRegularFile(root, name);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

async function readConfiguration(path: string): Promise<Readonly<Record<string, unknown>>> {
  const metadata = await stat(path);
  if (metadata.size > configurationLimitBytes) throw new Error("Targeted Infection configuration is excessive.");
  const parsed = JSON5.parse(await readFile(path, "utf8")) as unknown;
  return exactRecord(parsed, "Targeted Infection configuration");
}

async function assertContainedExecutable(root: string, path: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  let canonical: string;
  try {
    canonical = await realpath(join(root, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throwRequiredVerifierUnavailable("targeted-mutation", "tool", "tool-unavailable", "php:infection");
    }
    throw error;
  }
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("Targeted Infection executable escapes the repository.");
  }
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error("Targeted Infection executable is not a regular file.");
  try {
    await access(canonical, constants.X_OK);
  } catch {
    throwRequiredVerifierUnavailable("targeted-mutation", "tool", "tool-unavailable", "php:infection");
  }
}

async function containedRegularFile(root: string, path: string): Promise<string> {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Targeted Infection artifact path is malformed or escaped.");
  }
  const canonicalRoot = await realpath(root);
  const lexical = join(canonicalRoot, path);
  const metadata = await lstat(lexical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Targeted Infection artifact is not a regular file.");
  const canonical = await realpath(lexical);
  if (relative(canonicalRoot, canonical).startsWith("..") || (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`))) {
    throw new Error("Targeted Infection artifact escapes the verifier checkout.");
  }
  return canonical;
}

function optionalPackageMap(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const record = exactRecord(value, "Composer package map");
  for (const version of Object.values(record)) if (typeof version !== "string") throw new Error("Composer package version is malformed.");
  return record as Readonly<Record<string, string>>;
}

function count(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100_000) throw new Error(`Targeted Infection ${name} count is malformed or excessive.`);
  return value as number;
}

function mutationIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._\\/-]{0,255}$/u.test(value)) {
    throw new Error(`Targeted Infection ${name} is malformed.`);
  }
  return value;
}

function mutationLine(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10_000_000) {
    throw new Error("Targeted Infection mutation line is malformed.");
  }
  return value as number;
}

function exactRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${name} is malformed.`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
