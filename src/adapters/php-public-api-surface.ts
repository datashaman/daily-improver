import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { PublicApiSurfaceExecution, PublicApiSurfacePlan, PublicApiSurfaceResult } from "../domain/public-api-surface.js";
import { publicApiSurfaceHash } from "../domain/public-api-surface.js";
import { readJson } from "./shared.js";
import { throwRequiredVerifierUnavailable } from "../domain/required-verifier.js";

const symbolIdentitySemantics = "phpprobe-public-symbol-id-fingerprint/v1";
const tool = "phpprobe";

interface ComposerManifest {
  readonly require?: Readonly<Record<string, string>>;
  readonly "require-dev"?: Readonly<Record<string, string>>;
  readonly autoload?: {
    readonly "psr-4"?: Readonly<Record<string, string | readonly string[]>>;
  };
}

export async function preparePhpPublicApiSurface(root: string): Promise<PublicApiSurfacePlan> {
  const manifest = await readJson<ComposerManifest>(root, "composer.json");
  const packages = { ...manifest.require, ...manifest["require-dev"] };
  if (!packages["infocyph/phpprobe"]) {
    throwRequiredVerifierUnavailable("public-api-surface", "tool", "tool-unavailable", "php:phpprobe");
  }
  try {
    await containedRegularFile(root, "vendor/bin/phpprobe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throwRequiredVerifierUnavailable("public-api-surface", "tool", "tool-unavailable", "php:phpprobe");
    }
    throw error;
  }
  const targetPaths = await composerAutoloadPaths(root, manifest);
  return {
    schemaVersion: "public-api-surface-plan/v1",
    adapter: "php",
    tool,
    configurationSha256: await configurationIdentity(root, manifest, targetPaths),
    targetScope: "composer-autoload",
    targetPaths,
    command: ["vendor/bin/phpprobe", "api", "--public-only", "--format=json", "--preset=standard", ...targetPaths],
    timeoutMs: 120_000,
  };
}

export async function inspectPhpPublicApiSurface(
  root: string,
  plan: PublicApiSurfacePlan,
  execution: PublicApiSurfaceExecution,
): Promise<PublicApiSurfaceResult> {
  if (plan.adapter !== "php" || plan.tool !== tool || plan.targetScope !== "composer-autoload") {
    throw new Error("Verifier public-API plan was redirected to an unsupported adapter, tool, or target scope.");
  }
  const manifest = await readJson<ComposerManifest>(root, "composer.json");
  const targetPaths = await composerAutoloadPaths(root, manifest);
  if (JSON.stringify(targetPaths) !== JSON.stringify(plan.targetPaths)
    || plan.configurationSha256 !== await configurationIdentity(root, manifest, targetPaths)) {
    throw new Error("Verifier public-API configuration or target scope changed before inspection.");
  }
  if (execution.resourceExhausted) throw new Error("Verifier public-API analysis exhausted a bounded resource.");
  if (Buffer.byteLength(execution.stdout) > 2 * 1024 * 1024 || Buffer.byteLength(execution.stderr) > 512 * 1024) {
    throw new Error("Verifier public-API output is excessive.");
  }
  if (execution.exitCode !== 0) throw new Error("Verifier public-API tool was unavailable or failed.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(execution.stdout);
  } catch {
    throw new Error("Verifier public-API output is malformed.");
  }
  const output = record(parsed, "output");
  const snapshot = record(output.snapshot, "snapshot");
  if (snapshot.version !== 1 || !Array.isArray(snapshot.symbols)) throw new Error("Verifier public-API output uses unsupported snapshot semantics.");
  if (snapshot.symbols.length > 20_000) throw new Error("Verifier public-API symbols are excessive.");
  const symbols = snapshot.symbols.map((value) => {
    const symbol = record(value, "symbol");
    if (typeof symbol.id !== "string" || !symbol.id || symbol.id.length > 1_024
      || typeof symbol.kind !== "string" || !/^[a-z][a-z-]{0,31}$/u.test(symbol.kind)
      || typeof symbol.fingerprint !== "string" || !symbol.fingerprint || symbol.fingerprint.length > 1_024) {
      throw new Error("Verifier public-API symbol is malformed.");
    }
    return {
      identitySha256: publicApiSurfaceHash(JSON.stringify([symbolIdentitySemantics, symbol.kind, symbol.id])),
      signatureSha256: publicApiSurfaceHash(JSON.stringify([symbolIdentitySemantics, symbol.fingerprint])),
    };
  }).sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  if (new Set(symbols.map((symbol) => symbol.identitySha256)).size !== symbols.length) {
    throw new Error("Verifier public-API output contains duplicate symbol identities.");
  }
  return {
    schemaVersion: "public-api-surface-result/v1",
    adapter: "php",
    tool,
    configurationSha256: plan.configurationSha256,
    targetScope: "composer-autoload",
    targetPaths: plan.targetPaths,
    outcome: "completed",
    symbolIdentitySemantics,
    symbols,
    durationMs: execution.durationMs,
    stdoutSha256: publicApiSurfaceHash(execution.stdout),
    stderrSha256: publicApiSurfaceHash(execution.stderr),
  };
}

async function composerAutoloadPaths(root: string, manifest: ComposerManifest): Promise<readonly string[]> {
  const mappings = manifest.autoload?.["psr-4"];
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    throw new Error("Verifier public-API target scope is unavailable because Composer PSR-4 autoload paths are not declared.");
  }
  const paths: unknown[] = [];
  for (const value of Object.values(mappings)) {
    if (typeof value === "string") paths.push(value);
    else if (Array.isArray(value)) paths.push(...value);
    else throw new Error("Verifier public-API Composer autoload mapping is malformed.");
  }
  if (paths.length < 1 || paths.length > 64) throw new Error("Verifier public-API target paths are missing or excessive.");
  const normalized: string[] = [];
  for (const rawPath of paths) {
    if (typeof rawPath !== "string") throw new Error("Verifier public-API target path is malformed.");
    const path = rawPath.replace(/\/$/u, "");
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Verifier public-API target path escaped the checkout.");
    }
    await containedDirectory(root, path);
    normalized.push(path);
  }
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) throw new Error("Verifier public-API target paths contain duplicates.");
  return Object.freeze(unique);
}

async function configurationIdentity(root: string, manifest: ComposerManifest, targetPaths: readonly string[]): Promise<string> {
  const packages = { ...manifest.require, ...manifest["require-dev"] };
  const configPath = "phpprobe.json";
  let config: readonly [string, string?];
  try {
    const absolute = await containedRegularFile(root, configPath);
    const metadata = await lstat(absolute);
    if (metadata.size > 256 * 1024) throw new Error("Verifier public-API configuration is excessive.");
    config = ["hashed", publicApiSurfaceHash(await readFile(absolute))];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    config = ["absent"];
  }
  return publicApiSurfaceHash(JSON.stringify([
    "php-verifier-public-api-configuration/v1",
    tool,
    packages["infocyph/phpprobe"],
    targetPaths,
    config,
    "public-only",
    "standard",
  ]));
}

async function containedRegularFile(root: string, path: string): Promise<string> {
  const absolute = await containedPath(root, path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Verifier public-API input is not a regular file: ${path}`);
  return absolute;
}

async function containedDirectory(root: string, path: string): Promise<string> {
  const absolute = await containedPath(root, path);
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Verifier public-API target is not a directory: ${path}`);
  return absolute;
}

async function containedPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const lexical = join(canonicalRoot, path);
  const canonical = await realpath(lexical);
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error(`Verifier public-API input escaped the checkout: ${path}`);
  return lexical;
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Verifier public-API ${name} is malformed.`);
  return value as Readonly<Record<string, unknown>>;
}
