import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { glob } from "node:fs/promises";
import type { ImprovementSpec, RankedCandidate } from "../domain/model.js";

export interface AnalysisArtifact {
  readonly schema: 1;
  readonly repository: string;
  readonly adapter: string;
  readonly generatedAt: string;
  readonly candidates: readonly RankedCandidate[];
}

export interface TestManifest {
  readonly schema: 1;
  readonly generatedAt: string;
  readonly files: Readonly<Record<string, string>>;
  readonly signature: string;
}

export async function writeArtifact(root: string, name: string, value: unknown): Promise<string> {
  const path = join(runDirectory(root), name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

export async function readArtifact<T>(root: string, name: string): Promise<T> {
  return JSON.parse(await readFile(join(runDirectory(root), name), "utf8")) as T;
}

export async function createTestManifest(root: string, key: string): Promise<TestManifest> {
  const files: Record<string, string> = {};
  for await (const path of glob(["tests/**/*", "test/**/*", ".ai/runs/**/candidate.json", ".ai/runs/**/spec.json", ".ai/runs/**/test-plan.json"], { cwd: root, exclude: ["**/node_modules/**"] })) {
    if (!(await stat(join(root, path))).isFile()) continue;
    const content = await readFile(join(root, path));
    files[path] = createHash("sha256").update(content).digest("hex");
  }
  const generatedAt = new Date().toISOString();
  const payload = stablePayload(files, generatedAt);
  return { schema: 1, generatedAt, files, signature: createHmac("sha256", key).update(payload).digest("hex") };
}

export async function verifyTestManifest(root: string, manifest: TestManifest, key: string): Promise<boolean> {
  const expected = createHmac("sha256", key).update(stablePayload(manifest.files, manifest.generatedAt)).digest();
  const actual = Buffer.from(manifest.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  for (const [path, hash] of Object.entries(manifest.files)) {
    const content = await readFile(join(root, path));
    if (createHash("sha256").update(content).digest("hex") !== hash) return false;
  }
  return true;
}

export type SpecArtifact = ImprovementSpec;

function stablePayload(files: Readonly<Record<string, string>>, generatedAt: string): string {
  return JSON.stringify({ generatedAt, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) });
}

export function runDirectory(root: string): string {
  const date = process.env.DAILY_IMPROVER_RUN_DATE ?? new Date().toISOString().slice(0, 10);
  return join(root, ".ai", "runs", date);
}
