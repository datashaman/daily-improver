import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

const maximumArtifactBytes = 1_048_576;
const maximumPathLength = 1_024;
const maximumKeyBytes = 4_096;
const maximumLifetimeMs = 24 * 60 * 60_000;
const futureToleranceMs = 5 * 60_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface ArtifactAuthentication {
  readonly schemaVersion: "artifact-authentication/v1";
  readonly artifactPath: string;
  readonly artifactSchemaVersion: string;
  readonly sha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: string;
}

export function artifactAuthenticationPath(artifactPath: string): string {
  assertRepositoryPath(artifactPath);
  return `${artifactPath}.signature.json`;
}

export async function signArtifact(
  root: string,
  artifactPath: string,
  artifactSchemaVersion: string,
  key: string,
  now = new Date(),
): Promise<ArtifactAuthentication> {
  assertKey(key);
  assertSchemaVersion(artifactSchemaVersion);
  assertTimestamp(now, "Artifact authentication issue time");
  const content = await readArtifactBytes(root, artifactPath);
  assertArtifactSchema(content, artifactSchemaVersion);
  const unsigned = {
    schemaVersion: "artifact-authentication/v1" as const,
    artifactPath,
    artifactSchemaVersion,
    sha256: sha256(content),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + maximumLifetimeMs).toISOString(),
  };
  const authentication: ArtifactAuthentication = {
    ...unsigned,
    signature: createHmac("sha256", key).update(JSON.stringify(unsigned)).digest("hex"),
  };
  await atomicWrite(root, artifactAuthenticationPath(artifactPath), Buffer.from(`${JSON.stringify(authentication, null, 2)}\n`));
  return authentication;
}

export async function verifyArtifact(
  root: string,
  artifactPath: string,
  artifactSchemaVersion: string,
  key: string,
  now = new Date(),
): Promise<Buffer> {
  assertKey(key);
  assertSchemaVersion(artifactSchemaVersion);
  assertTimestamp(now, "Artifact authentication verification time");
  const authenticationBytes = await readArtifactBytes(root, artifactAuthenticationPath(artifactPath));
  let value: unknown;
  try { value = JSON.parse(authenticationBytes.toString("utf8")); }
  catch { throw new Error(`Artifact authentication is malformed: ${artifactPath}`); }
  const authentication = assertAuthentication(value);
  if (authentication.artifactPath !== artifactPath || authentication.artifactSchemaVersion !== artifactSchemaVersion) {
    throw new Error(`Artifact authentication does not address the required artifact contract: ${artifactPath}`);
  }
  const issuedAt = parseTimestamp(authentication.issuedAt, "Artifact authentication issue time");
  const expiresAt = parseTimestamp(authentication.expiresAt, "Artifact authentication expiry time");
  if (expiresAt.getTime() <= issuedAt.getTime() || expiresAt.getTime() - issuedAt.getTime() > maximumLifetimeMs) {
    throw new Error(`Artifact authentication lifetime is malformed: ${artifactPath}`);
  }
  if (issuedAt.getTime() > now.getTime() + futureToleranceMs || expiresAt.getTime() < now.getTime()) {
    throw new Error(`Artifact authentication is stale: ${artifactPath}`);
  }
  const { signature, ...unsigned } = authentication;
  const expected = createHmac("sha256", key).update(JSON.stringify(unsigned)).digest();
  const actual = Buffer.from(signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(`Artifact authentication signature is invalid: ${artifactPath}`);
  }
  const content = await readArtifactBytes(root, artifactPath);
  assertArtifactSchema(content, artifactSchemaVersion);
  if (sha256(content) !== authentication.sha256) throw new Error(`Authenticated artifact identity changed: ${artifactPath}`);
  return content;
}

function assertAuthentication(value: unknown): ArtifactAuthentication {
  if (!isRecord(value) || !exactKeys(value, [
    "artifactPath", "artifactSchemaVersion", "expiresAt", "issuedAt", "schemaVersion", "sha256", "signature",
  ]) || value.schemaVersion !== "artifact-authentication/v1") {
    throw new Error("Artifact authentication must use the exact artifact-authentication/v1 contract.");
  }
  assertRepositoryPath(value.artifactPath);
  assertSchemaVersion(value.artifactSchemaVersion);
  if (typeof value.sha256 !== "string" || !sha256Pattern.test(value.sha256)
    || typeof value.signature !== "string" || !sha256Pattern.test(value.signature)
    || typeof value.issuedAt !== "string" || typeof value.expiresAt !== "string") {
    throw new Error("Artifact authentication contains malformed identities.");
  }
  return value as unknown as ArtifactAuthentication;
}

function assertArtifactSchema(content: Buffer, expected: string): void {
  let value: unknown;
  try { value = JSON.parse(content.toString("utf8")); }
  catch { throw new Error(`Authenticated artifact is not valid JSON for ${expected}.`); }
  if (!isRecord(value) || value.schemaVersion !== expected) {
    throw new Error(`Authenticated artifact must use ${expected}.`);
  }
}

async function readArtifactBytes(root: string, path: string): Promise<Buffer> {
  assertRepositoryPath(path);
  const canonicalRoot = await realpath(root);
  const lexical = join(canonicalRoot, path);
  let metadata;
  try { metadata = await lstat(lexical); }
  catch { throw new Error(`Authenticated artifact is missing, non-regular, or oversized: ${path}`); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumArtifactBytes) {
    throw new Error(`Authenticated artifact is missing, non-regular, or oversized: ${path}`);
  }
  const canonical = await realpath(lexical);
  if (canonical !== lexical || !(canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}${sep}`))) {
    throw new Error(`Authenticated artifact escapes its repository: ${path}`);
  }
  const content = await readFile(lexical);
  if (content.length !== metadata.size) throw new Error(`Authenticated artifact changed while reading: ${path}`);
  return content;
}

async function atomicWrite(root: string, path: string, content: Buffer): Promise<void> {
  assertRepositoryPath(path);
  const canonicalRoot = await realpath(root);
  const destination = join(canonicalRoot, path);
  const parent = dirname(destination);
  const canonicalParent = await realpath(parent);
  if (!(canonicalParent === canonicalRoot || canonicalParent.startsWith(`${canonicalRoot}${sep}`)) || canonicalParent !== parent) {
    throw new Error(`Artifact authentication destination is unsafe: ${path}`);
  }
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.artifact-authentication-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function assertRepositoryPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > maximumPathLength || value.startsWith("/")
    || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Artifact authentication path is malformed.");
  }
}

function assertSchemaVersion(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 128 || !/^[a-z][a-z0-9-]*\/v[1-9][0-9]*$/u.test(value)) {
    throw new Error("Artifact schema version is malformed.");
  }
}

function assertKey(key: string): void {
  const bytes = Buffer.byteLength(key);
  if (bytes < 8 || bytes > maximumKeyBytes || key.includes("\0")) throw new Error("Runner-owned artifact authentication key is malformed.");
}

function assertTimestamp(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime()) || value.toISOString().length > 64) throw new Error(`${label} is malformed.`);
}

function parseTimestamp(value: string, label: string): Date {
  if (value.length > 64) throw new Error(`${label} is malformed.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${label} is malformed.`);
  return parsed;
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}
