import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { glob, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvidenceResultStatus } from "../contracts.js";
import { hashEvidenceConfiguration } from "./evidence-provenance.js";

export const phpEvidenceCacheSchemaVersion = "php-evidence-cache/v1" as const;

const cacheArtifactLimitBytes = 1024 * 1024;
const sourceFileLimitBytes = 4 * 1024 * 1024;
const sourceFileCountLimit = 10_000;
const lockWaitMs = 30_000;

export interface PhpEvidenceCachePolicy {
  readonly collector: string;
  readonly policyVersion: string;
  readonly evidenceSchemaVersion: string;
  readonly command: readonly string[];
  readonly versionCommand: readonly string[];
  readonly configurationPaths: readonly string[];
  readonly sourcePatterns: readonly string[];
}

interface CacheableEvidence {
  readonly schemaVersion: string;
  readonly result: {
    readonly status: EvidenceResultStatus;
    readonly outputTruncated?: boolean;
  };
  readonly findings: readonly unknown[];
  readonly candidates: readonly unknown[];
}

interface CacheIdentity {
  readonly policyVersion: string;
  readonly evidenceSchemaVersion: string;
  readonly command: readonly string[];
  readonly toolVersion: string;
  readonly configurationHash: string;
  readonly sourceHash: string;
}

interface CacheEnvelope<T> {
  readonly schemaVersion: typeof phpEvidenceCacheSchemaVersion;
  readonly identity: CacheIdentity;
  readonly payload: T;
}

export interface PhpEvidenceCacheOptions {
  readonly resolveToolVersion?: (root: string, command: readonly string[]) => Promise<string | null>;
  readonly cacheArtifactLimitBytes?: number;
  readonly lockWaitMs?: number;
}

export class PhpEvidenceCache {
  private readonly resolveToolVersion: (root: string, command: readonly string[]) => Promise<string | null>;
  private readonly artifactLimit: number;
  private readonly maximumLockWait: number;

  constructor(options: PhpEvidenceCacheOptions = {}) {
    this.resolveToolVersion = options.resolveToolVersion ?? resolveBoundedToolVersion;
    this.artifactLimit = options.cacheArtifactLimitBytes ?? cacheArtifactLimitBytes;
    this.maximumLockWait = options.lockWaitMs ?? lockWaitMs;
    if (this.artifactLimit <= 0) throw new Error("Evidence cache artifact limit must be positive.");
    if (this.maximumLockWait < 0) throw new Error("Evidence cache lock wait cannot be negative.");
  }

  async collect<T extends CacheableEvidence>(
    root: string,
    policy: PhpEvidenceCachePolicy,
    collect: () => Promise<T>,
  ): Promise<T> {
    const identity = await this.identity(root, policy);
    if (!identity) return collect();

    const key = sha256(JSON.stringify(identity)).slice("sha256:".length);
    const directory = join(root, ".daily-improver", "cache", "php-evidence", safeCollector(policy.collector));
    const path = join(directory, `${key}.json`);
    const cached = await this.read<T>(path, identity);
    if (cached) return cached;

    await mkdir(directory, { recursive: true });
    const lockPath = `${path}.lock`;
    const acquired = await this.acquireLock(lockPath, path, identity);
    if (!acquired) return await this.read<T>(path, identity) ?? collect();

    try {
      const concurrent = await this.read<T>(path, identity);
      if (concurrent) return concurrent;
      const evidence = await collect();
      if (!isReusableEvidence(evidence)) return evidence;
      await this.write(path, { schemaVersion: phpEvidenceCacheSchemaVersion, identity, payload: evidence });
      return evidence;
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async identity(root: string, policy: PhpEvidenceCachePolicy): Promise<CacheIdentity | null> {
    const [toolVersion, configuration, sourceHash] = await Promise.all([
      this.resolveToolVersion(root, policy.versionCommand),
      hashEvidenceConfiguration(root, {
        versionCommand: policy.versionCommand,
        configurationPaths: policy.configurationPaths,
        maxConfigurationFileBytes: 256 * 1024,
      }),
      hashSources(root, policy.sourcePatterns),
    ]);
    if (!toolVersion || configuration.failed || !configuration.hash || !sourceHash) return null;
    return {
      policyVersion: policy.policyVersion,
      evidenceSchemaVersion: policy.evidenceSchemaVersion,
      command: policy.command,
      toolVersion,
      configurationHash: configuration.hash,
      sourceHash,
    };
  }

  private async read<T extends CacheableEvidence>(path: string, identity: CacheIdentity): Promise<T | null> {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > this.artifactLimit) return null;
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isEnvelope(parsed) || JSON.stringify(parsed.identity) !== JSON.stringify(identity)) return null;
      if (parsed.payload.schemaVersion !== identity.evidenceSchemaVersion) return null;
      if (!isReusableEvidence(parsed.payload)) return null;
      return parsed.payload as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  private async acquireLock<T extends CacheableEvidence>(
    lockPath: string,
    cachePath: string,
    identity: CacheIdentity,
  ): Promise<boolean> {
    const started = Date.now();
    while (true) {
      try {
        await mkdir(lockPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.read<T>(cachePath, identity)) return false;
        if (Date.now() - started >= this.maximumLockWait) return false;
        await delay(10);
      }
    }
  }

  private async write<T extends CacheableEvidence>(path: string, envelope: CacheEnvelope<T>): Promise<void> {
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized) > this.artifactLimit) return;
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function hashSources(root: string, patterns: readonly string[]): Promise<string | null> {
  const paths = new Set<string>();
  for await (const path of glob(patterns, { cwd: root, exclude: ["vendor/**", ".daily-improver/cache/**"] })) {
    paths.add(path.replaceAll("\\", "/"));
    if (paths.size > sourceFileCountLimit) return null;
  }
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    try {
      const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > sourceFileLimitBytes) return null;
        hash.update(`${path}\0${metadata.size}\0`);
        let bytes = 0;
        for await (const chunk of handle.createReadStream()) {
          bytes += chunk.length;
          if (bytes > sourceFileLimitBytes) return null;
          hash.update(chunk);
        }
        hash.update("\0");
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

async function resolveBoundedToolVersion(root: string, command: readonly string[]): Promise<string | null> {
  const [program, ...args] = command;
  if (!program) return null;
  return await new Promise((resolve) => {
    const child = spawn(program, args, { cwd: root, env: process.env, shell: false });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = (value: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const capture = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes <= 16 * 1024) chunks.push(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      if (code !== 0 || bytes > 16 * 1024) return finish(null);
      const output = Buffer.concat(chunks).toString("utf8");
      const versions = [...output.matchAll(/(?:^|[^0-9])v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z.+-])/gm)];
      const version = versions.at(-1)?.[1];
      finish(version && version.length <= 64 ? version : null);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, 10_000);
  });
}

function isEnvelope(value: unknown): value is CacheEnvelope<CacheableEvidence> {
  if (!isRecord(value) || value.schemaVersion !== phpEvidenceCacheSchemaVersion) return false;
  if (!isRecord(value.identity) || !isRecord(value.payload) || !isRecord(value.payload.result)) return false;
  return typeof value.payload.schemaVersion === "string"
    && typeof value.payload.result.status === "string"
    && Array.isArray(value.payload.findings)
    && Array.isArray(value.payload.candidates);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCacheableStatus(status: string): status is "success" | "code-finding" {
  return status === "success" || status === "code-finding";
}

function isReusableEvidence(evidence: CacheableEvidence): boolean {
  return isCacheableStatus(evidence.result.status) && evidence.result.outputTruncated !== true;
}

function safeCollector(value: string): string {
  if (!/^[a-z0-9-]+$/.test(value)) throw new Error("Evidence cache collector identity is invalid.");
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
