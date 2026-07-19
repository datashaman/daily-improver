import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, sep } from "node:path";
import type { CommandRunner } from "../infra/command-runner.js";
import {
  protectedRepositoryChangeHash,
  protectedRepositoryClassifications,
  type ProtectedRepositoryChangePlan,
  type ProtectedRepositoryChangeResult,
  type ProtectedRepositoryClassification,
  type ProtectedRepositoryEntry,
} from "../domain/protected-repository-changes.js";

const maximumPaths = 100_000;
const maximumPathLength = 1_024;
const maximumFileBytes = 512 * 1024 * 1024;
const binaryProbeBytes = 8 * 1024;

const policy = Object.freeze({
  policyId: "repository-protected-change-policy/v1",
  classifications: protectedRepositoryClassifications,
  dependencyBasenames: [
    "Cargo.lock", "Cargo.toml", "Gemfile", "Gemfile.lock", "Pipfile", "Pipfile.lock", "composer.json", "composer.lock",
    "deno.json", "deno.jsonc", "deno.lock", "go.mod", "go.sum", "gradle.lockfile", "package-lock.json", "package.json",
    "packages.lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "poetry.lock", "pom.xml", "pyproject.toml", "requirements.txt",
    "settings.gradle", "settings.gradle.kts", "uv.lock", "yarn.lock",
  ],
  dependencySuffixes: [".csproj", ".fsproj", ".gradle", ".gradle.kts", ".vbproj"],
  migrationSegments: ["migrate", "migration", "migrations"],
  workflowPaths: [
    ".circleci/config.yml", ".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml",
  ],
  workflowPrefixes: [".buildkite/", ".github/actions/", ".github/workflows/"],
  binaryExtensions: [
    ".7z", ".a", ".bin", ".bmp", ".class", ".dll", ".dylib", ".eot", ".exe", ".gif", ".gz", ".ico", ".jar",
    ".jpeg", ".jpg", ".o", ".pdf", ".png", ".so", ".tar", ".ttf", ".war", ".webp", ".woff", ".woff2", ".zip",
  ],
});

const policySha256 = protectedRepositoryChangeHash(JSON.stringify(policy));

export function prepareProtectedRepositoryChangePlan(): ProtectedRepositoryChangePlan {
  return Object.freeze({
    schemaVersion: "protected-repository-change-plan/v1",
    policyId: "repository-protected-change-policy/v1",
    policySha256,
    classifications: protectedRepositoryClassifications,
  });
}

export async function inspectProtectedRepositoryChanges(
  root: string,
  plan: ProtectedRepositoryChangePlan,
  runner: CommandRunner,
): Promise<ProtectedRepositoryChangeResult> {
  if (plan.policyId !== policy.policyId || plan.policySha256 !== policySha256
    || JSON.stringify(plan.classifications) !== JSON.stringify(policy.classifications)) {
    throw new Error("Protected repository-change inspection was redirected or uses an unsupported policy.");
  }
  const listed = await runner.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], root);
  if (listed.exitCode !== 0 || Buffer.byteLength(listed.stdout) > 16 * 1024 * 1024) {
    throw new Error("Protected repository-change path inventory is unavailable or excessive.");
  }
  const paths = listed.stdout.split("\0").filter(Boolean);
  if (paths.length > maximumPaths) throw new Error("Protected repository-change path inventory is excessive.");
  const uniquePaths = [...new Set(paths)].sort();
  if (uniquePaths.length !== paths.length) throw new Error("Protected repository-change path inventory contains duplicates.");
  const canonicalRoot = await realpath(root);
  const entries: ProtectedRepositoryEntry[] = [];
  for (const path of uniquePaths) {
    assertRepositoryPath(path);
    const candidate = join(canonicalRoot, path);
    let metadata;
    try { metadata = await lstat(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const parent = await realpath(dirname(candidate));
    if (parent !== dirname(candidate) || (parent !== canonicalRoot && !parent.startsWith(`${canonicalRoot}${sep}`))) {
      throw new Error("Protected repository-change path escapes through a symbolic parent.");
    }
    const pathClassification = classifyPath(path);
    let classification = pathClassification ?? (hasBinaryExtension(path) ? "generated-binary" : undefined);
    let contentIdentitySha256: string;
    let entryType: ProtectedRepositoryEntry["entryType"];
    let sizeBytes: number;
    if (metadata.isSymbolicLink()) {
      entryType = "symbolic-link";
      const target = await readlink(candidate);
      const after = await lstat(candidate);
      if (!after.isSymbolicLink() || after.dev !== metadata.dev || after.ino !== metadata.ino) {
        throw new Error("Protected repository-change symbolic link changed during inspection.");
      }
      contentIdentitySha256 = protectedRepositoryChangeHash(target);
      sizeBytes = Buffer.byteLength(target);
    } else if (metadata.isFile()) {
      if (metadata.size > maximumFileBytes) throw new Error("Protected repository-change file is excessive.");
      const canonical = await realpath(candidate);
      if (canonical !== candidate) throw new Error("Protected repository-change file escapes through a symbolic link.");
      entryType = "regular-file";
      sizeBytes = metadata.size;
      const inspected = await inspectRegularFile(candidate, metadata.size, metadata.dev, metadata.ino);
      contentIdentitySha256 = inspected.sha256;
      classification ??= inspected.binary ? "generated-binary" : undefined;
    } else {
      entryType = "other";
      sizeBytes = metadata.size;
      contentIdentitySha256 = protectedRepositoryChangeHash(JSON.stringify([metadata.mode, metadata.size]));
    }
    if (!classification) continue;
    entries.push(Object.freeze({
      classification,
      pathIdentitySha256: protectedRepositoryChangeHash(path),
      contentIdentitySha256,
      entryType,
      sizeBytes,
    }));
  }
  entries.sort((left, right) => left.classification.localeCompare(right.classification)
    || left.pathIdentitySha256.localeCompare(right.pathIdentitySha256));
  if (entries.length > maximumPaths) throw new Error("Protected repository-change inventory is excessive.");
  const identitySemantics = "repository-relative-path-and-content/v1" as const;
  return Object.freeze({
    schemaVersion: "protected-repository-change-result/v1",
    policyId: plan.policyId,
    policySha256: plan.policySha256,
    classifications: plan.classifications,
    identitySemantics,
    entries: Object.freeze(entries),
    inventorySha256: protectedRepositoryChangeHash(JSON.stringify([identitySemantics, plan.classifications, entries])),
  });
}

function classifyPath(path: string): ProtectedRepositoryClassification | undefined {
  const name = basename(path);
  if (policy.dependencyBasenames.includes(name as typeof policy.dependencyBasenames[number])
    || /^requirements(?:-[A-Za-z0-9._-]+)?\.txt$/u.test(name)
    || policy.dependencySuffixes.some((suffix) => name.endsWith(suffix))) return "dependency";
  const segments = path.split("/").map((part) => part.toLowerCase());
  if (segments.some((segment) => policy.migrationSegments.includes(segment as typeof policy.migrationSegments[number]))) return "migration";
  if (policy.workflowPaths.includes(path as typeof policy.workflowPaths[number])
    || policy.workflowPrefixes.some((prefix) => path.startsWith(prefix))) return "workflow";
  return undefined;
}

function hasBinaryExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return policy.binaryExtensions.some((extension) => lower.endsWith(extension));
}

async function inspectRegularFile(
  path: string,
  expectedSize: number,
  expectedDevice: number,
  expectedInode: number,
): Promise<{ readonly sha256: string; readonly binary: boolean }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expectedSize || before.dev !== expectedDevice || before.ino !== expectedInode) {
      throw new Error("Protected repository-change file changed before inspection.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let binary = false;
    while (position < expectedSize) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - position), position);
      if (bytesRead === 0) throw new Error("Protected repository-change file changed during inspection.");
      const chunk = buffer.subarray(0, bytesRead);
      if (position < binaryProbeBytes && chunk.subarray(0, binaryProbeBytes - position).includes(0)) binary = true;
      hash.update(chunk);
      position += bytesRead;
    }
    const after = await handle.stat();
    if (!after.isFile() || after.size !== expectedSize || after.dev !== expectedDevice || after.ino !== expectedInode) {
      throw new Error("Protected repository-change file changed during inspection.");
    }
    return { sha256: hash.digest("hex"), binary };
  } finally {
    await handle.close();
  }
}

function assertRepositoryPath(path: string): void {
  if (path.length < 1 || path.length > maximumPathLength || path.startsWith("/") || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Protected repository-change path is escaped or malformed.");
  }
}
