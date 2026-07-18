import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { CommandResult, CommandRunner } from "../infra/command-runner.js";

const maximumPathLength = 16_384;
const maximumInjectedVariables = 16;
const allowedInjectedVariables = new Set([
  "DAILY_IMPROVER_GENERATED_TEST_PATHS",
  "DAILY_IMPROVER_TEST_LIFECYCLE_NONCE",
  "DAILY_IMPROVER_TEST_LIFECYCLE_PATH",
  "DAILY_IMPROVER_TEST_LIFECYCLE_PHASE",
]);

export interface VerifierCommandEnvironmentDecision {
  readonly schemaVersion: "verifier-command-environment/v1";
  readonly isolation: "fresh-process-and-storage-per-command";
  readonly shell: "/bin/sh";
  readonly path: string;
  readonly inheritedVariables: readonly [];
}

export function createVerifierCommandEnvironmentDecision(
  environment: Readonly<Record<string, string | undefined>>,
): VerifierCommandEnvironmentDecision {
  return validateVerifierCommandEnvironmentDecision({
    schemaVersion: "verifier-command-environment/v1",
    isolation: "fresh-process-and-storage-per-command",
    shell: "/bin/sh",
    path: environment.PATH,
    inheritedVariables: [],
  });
}

export function validateVerifierCommandEnvironmentDecision(
  value: unknown,
): VerifierCommandEnvironmentDecision {
  if (!isRecord(value)) throw new Error("Verifier command environment decision is unavailable or malformed.");
  assertExactKeys(value, ["inheritedVariables", "isolation", "path", "schemaVersion", "shell"]);
  if (value.schemaVersion !== "verifier-command-environment/v1") {
    throw new Error("Verifier command environment decision uses an unsupported schema.");
  }
  if (value.isolation !== "fresh-process-and-storage-per-command" || value.shell !== "/bin/sh") {
    throw new Error("Verifier command environment isolation is unsupported.");
  }
  if (!Array.isArray(value.inheritedVariables) || value.inheritedVariables.length !== 0) {
    throw new Error("Verifier command environment must not inherit ambient variables.");
  }
  const path = value.path;
  if (typeof path !== "string" || !path || path.length > maximumPathLength || path.includes("\0")) {
    throw new Error("Verifier command environment PATH must be a bounded non-empty value.");
  }
  for (const component of path.split(":")) {
    if (!component || !component.startsWith("/") || component.includes("\0")) {
      throw new Error("Verifier command environment PATH must contain only absolute non-empty components.");
    }
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    isolation: value.isolation,
    shell: value.shell,
    path,
    inheritedVariables: Object.freeze([] as const),
  });
}

export async function runVerifierCommand(
  runner: CommandRunner,
  decision: VerifierCommandEnvironmentDecision,
  command: readonly string[],
  cwd: string,
  timeoutMs = 10 * 60_000,
  injectedVariables: Readonly<Record<string, string>> = {},
): Promise<CommandResult> {
  return await withVerifierCommandEnvironment(runner, decision, cwd, injectedVariables, async (environment) =>
    await runner.runWithExactEnvironment(command, cwd, timeoutMs, environment));
}

export async function assertVerifierCommandEnvironment(
  runner: CommandRunner,
  decision: VerifierCommandEnvironmentDecision,
  cwd: string,
): Promise<void> {
  await withVerifierCommandEnvironment(runner, decision, cwd, {}, async () => undefined);
}

async function withVerifierCommandEnvironment<T>(
  runner: CommandRunner,
  decision: VerifierCommandEnvironmentDecision,
  cwd: string,
  injectedVariables: Readonly<Record<string, string>>,
  execute: (environment: Readonly<Record<string, string>>) => Promise<T>,
): Promise<T> {
  const validated = validateVerifierCommandEnvironmentDecision(decision);
  const injected = validateInjectedVariables(cwd, injectedVariables);
  const boundary = await mkdtemp(join("/tmp", "daily-improver-verifier-command-"));
  try {
    const directories = {
      home: join(boundary, "home"),
      temporary: join(boundary, "tmp"),
      cache: join(boundary, "cache"),
      configuration: join(boundary, "config"),
      data: join(boundary, "data"),
    };
    await Promise.all(Object.values(directories).map(async (path) => await mkdir(path, { mode: 0o700 })));
    await assertFreshStorage(boundary, Object.values(directories));
    const environment = {
      PATH: validated.path,
      HOME: directories.home,
      TMPDIR: directories.temporary,
      TMP: directories.temporary,
      TEMP: directories.temporary,
      XDG_CACHE_HOME: directories.cache,
      XDG_CONFIG_HOME: directories.configuration,
      XDG_DATA_HOME: directories.data,
      DAILY_IMPROVER_VERIFIER_ENVIRONMENT: validated.schemaVersion,
      ...injected,
    };
    await proveExactEnvironment(runner, cwd, environment);
    await assertFreshStorage(boundary, Object.values(directories));
    return await execute(environment);
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
}

async function proveExactEnvironment(
  runner: CommandRunner,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  let result: CommandResult;
  try {
    result = await runner.runWithExactEnvironment(["/usr/bin/env", "-0"], cwd, 10_000, environment);
  } catch {
    throw new Error("Verifier command environment isolation is unavailable.");
  }
  if (result.exitCode !== 0 || !sameEnvironment(parseEnvironment(result.stdout), environment)) {
    throw new Error("Verifier command environment isolation was ineffective.");
  }
}

function parseEnvironment(output: string): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const item of output.split("\0")) {
    if (!item) continue;
    const separator = item.indexOf("=");
    if (separator < 1) throw new Error("Verifier environment probe returned malformed output.");
    const name = item.slice(0, separator);
    if (entries.some(([existing]) => existing === name)) throw new Error("Verifier environment probe returned duplicate variables.");
    entries.push([name, item.slice(separator + 1)]);
  }
  return Object.fromEntries(entries);
}

function sameEnvironment(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const actualNames = Object.keys(actual).sort();
  const expectedNames = Object.keys(expected).sort();
  return actualNames.length === expectedNames.length
    && actualNames.every((name, index) => name === expectedNames[index] && actual[name] === expected[name]);
}

async function assertFreshStorage(boundary: string, directories: readonly string[]): Promise<void> {
  const boundaryMetadata = await lstat(boundary);
  if (!boundaryMetadata.isDirectory() || boundaryMetadata.isSymbolicLink() || (boundaryMetadata.mode & 0o077) !== 0) {
    throw new Error("Verifier command storage boundary is not runner-owned.");
  }
  const canonicalBoundary = await realpath(boundary);
  for (const directory of directories) {
    const metadata = await lstat(directory);
    const canonical = await realpath(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (canonical !== canonicalBoundary && !canonical.startsWith(`${canonicalBoundary}${sep}`))
      || (await readdir(directory)).length !== 0) {
      throw new Error("Verifier command storage isolation was ineffective.");
    }
  }
}

function validateInjectedVariables(
  cwd: string,
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(value);
  if (entries.length > maximumInjectedVariables) throw new Error("Verifier command variables are excessive.");
  const result: Record<string, string> = {};
  for (const [name, variable] of entries) {
    if (!allowedInjectedVariables.has(name) || typeof variable !== "string" || variable.length > maximumPathLength || variable.includes("\0")) {
      throw new Error("Verifier command variable is malformed or unsupported.");
    }
    if (name === "DAILY_IMPROVER_TEST_LIFECYCLE_PATH") assertContainedPath(cwd, variable);
    result[name] = variable;
  }
  return result;
}

function assertContainedPath(root: string, path: string): void {
  if (!path.startsWith("/")) throw new Error("Verifier command artifact path must be absolute.");
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedPath === normalizedRoot || !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("Verifier command artifact path escapes the fresh checkout.");
  }
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Verifier command environment decision is extended or incomplete.");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
