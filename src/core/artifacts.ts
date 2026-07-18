import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { glob } from "node:fs/promises";
import type { CandidateExclusion, HumanTaskRecommendation, ImprovementSpec, RankedCandidate } from "../domain/model.js";
import type { CandidateScoreExplanation } from "../domain/candidate-score.js";

export interface AnalysisArtifact {
  readonly schema: 5;
  readonly repository: string;
  readonly adapter: string;
  readonly generatedAt: string;
  readonly candidates: readonly RankedCandidate[];
  readonly scoreExplanations: readonly CandidateScoreExplanation[];
  readonly candidateExclusions: readonly CandidateExclusion[];
  readonly humanTaskRecommendation?: HumanTaskRecommendation;
}

export interface TestManifest {
  readonly schemaVersion: "test-manifest/v2";
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
  for await (const path of glob([
    "tests/**/*",
    "test/**/*",
    ".ai/runs/**/candidate.json",
    ".ai/runs/**/daily-improvement-decision.json",
    ".ai/runs/**/open-pull-request-limit-decision.json",
    ".ai/runs/**/spec.json",
    ".ai/runs/**/test-plan.json",
    ".ai/runs/**/generated-test-baseline-lifecycle.json",
    ".ai/runs/**/property-test-execution-proof.json",
    ".ai/runs/**/known-mutation-execution-proof.json",
    ".ai/runs/**/test-implementation-inspection.json",
    ".ai/runs/**/adapter-generated-test-quality.json",
    ".ai/runs/**/test-agent-usage.json",
    ".ai/runs/**/test-agent-rationale.json",
  ], { cwd: root, exclude: ["**/node_modules/**"] })) {
    if (!(await stat(join(root, path))).isFile()) continue;
    const content = await readFile(join(root, path));
    files[path] = createHash("sha256").update(content).digest("hex");
  }
  const generatedAt = new Date().toISOString();
  const payload = stablePayload(files, generatedAt);
  return {
    schemaVersion: "test-manifest/v2",
    generatedAt,
    files,
    signature: createHmac("sha256", key).update(payload).digest("hex"),
  };
}

export async function verifyTestManifest(root: string, manifest: TestManifest, key: string): Promise<boolean> {
  return await verifyTestManifestFiles(root, manifest, key, Object.keys(manifest.files));
}

export async function verifyVerifierTestManifest(root: string, manifest: TestManifest, key: string): Promise<boolean> {
  return await verifyTestManifestFiles(root, manifest, key, verifierManifestFilePaths(manifest));
}

export function verifierManifestFilePaths(manifest: TestManifest): readonly string[] {
  return Object.keys(manifest.files).filter((path) => !path.endsWith("-agent-rationale.json"));
}

async function verifyTestManifestFiles(
  root: string,
  manifest: TestManifest,
  key: string,
  paths: readonly string[],
): Promise<boolean> {
  if (!isExactTestManifest(manifest)) return false;
  const expected = createHmac("sha256", key).update(stablePayload(manifest.files, manifest.generatedAt)).digest();
  const actual = Buffer.from(manifest.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  for (const path of paths) {
    const hash = manifest.files[path];
    if (!hash) return false;
    let content: Buffer;
    try { content = await readFile(join(root, path)); }
    catch { return false; }
    if (createHash("sha256").update(content).digest("hex") !== hash) return false;
  }
  return true;
}

export type SpecArtifact = ImprovementSpec;

function stablePayload(files: Readonly<Record<string, string>>, generatedAt: string): string {
  return JSON.stringify({
    schemaVersion: "test-manifest/v2",
    generatedAt,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  });
}

function isExactTestManifest(value: TestManifest): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).sort().join("|") !== "files|generatedAt|schemaVersion|signature"
    || value.schemaVersion !== "test-manifest/v2"
    || typeof value.generatedAt !== "string" || !isFreshTimestamp(value.generatedAt)
    || typeof value.signature !== "string" || !/^[a-f0-9]{64}$/u.test(value.signature)
    || typeof value.files !== "object" || value.files === null || Array.isArray(value.files)) return false;
  const entries = Object.entries(value.files);
  return entries.length > 0 && entries.length <= 10_000 && entries.every(([path, hash]) => (
    path.length > 0 && path.length <= 1_024 && !path.startsWith("/") && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    && /^[a-f0-9]{64}$/u.test(hash)
  ));
}

function isFreshTimestamp(value: string): boolean {
  if (value.length > 64) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return false;
  const age = Date.now() - parsed.getTime();
  return age >= -5 * 60_000 && age <= 24 * 60 * 60_000;
}

export function runDirectory(root: string): string {
  const date = process.env.DAILY_IMPROVER_RUN_DATE ?? new Date().toISOString().slice(0, 10);
  return join(root, ".ai", "runs", date);
}
