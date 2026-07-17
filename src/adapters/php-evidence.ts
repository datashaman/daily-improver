import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ImprovementCandidate } from "../domain/model.js";

interface MutationRecord {
  readonly status?: string;
  readonly file?: string;
  readonly line?: number;
  readonly mutator?: string;
  readonly description?: string;
  readonly invariant?: string;
}

interface InfectionReport {
  readonly mutations?: readonly MutationRecord[];
}

export async function collectPhpEvidence(
  root: string,
  options: {
    readonly includePreparedCoverage?: boolean;
    readonly includePreparedMutation?: boolean;
    readonly includePreparedComplexity?: boolean;
  } = {},
): Promise<readonly ImprovementCandidate[]> {
  const includePreparedCoverage = options.includePreparedCoverage ?? true;
  const includePreparedMutation = options.includePreparedMutation ?? true;
  const includePreparedComplexity = options.includePreparedComplexity ?? true;
  const [mutations, coverage, complexity, todos] = await Promise.all([
    includePreparedMutation ? mutationCandidates(root) : Promise.resolve([]),
    includePreparedCoverage ? coverageCandidates(root) : Promise.resolve([]),
    includePreparedComplexity ? complexityCandidates(root) : Promise.resolve([]),
    todoCandidates(root),
  ]);
  return [...mutations, ...coverage, ...complexity, ...todos];
}

async function mutationCandidates(root: string): Promise<ImprovementCandidate[]> {
  const report = await optionalJson<InfectionReport>(join(root, ".ai", "evidence", "infection.json"));
  return (report?.mutations ?? [])
    .filter((mutation) => mutation.status === "escaped" || mutation.status === "not-covered")
    .filter((mutation): mutation is MutationRecord & { file: string } => Boolean(mutation.file))
    .map((mutation) => ({
      id: `mutation-${fingerprint(`${mutation.file}:${mutation.line ?? 0}:${mutation.mutator ?? "unknown"}`)}`,
      kind: "test-protection" as const,
      title: `Kill surviving mutation in ${mutation.file}`,
      rationale: mutation.description ?? `A ${mutation.mutator ?? "behavioral"} mutation survived existing tests.`,
      confidence: mutation.status === "escaped" ? 0.98 : 0.88,
      impact: 0.96,
      effort: 0.35,
      risk: 0.18,
      evidence: [`Infection ${mutation.status} mutation at ${mutation.file}:${mutation.line ?? "unknown"}`, mutation.mutator ?? "Unknown mutator"],
      suggestedFiles: [mutation.file, "tests/Property"],
      target: mutation.file,
      estimatedDiffLines: 80,
      propertyInvariants: mutation.invariant ? [mutation.invariant] : [],
      deduplication: {
        schemaVersion: "candidate-deduplication/v1" as const,
        subsystem: mutation.file,
        defect: `mutation:${mutation.line ?? 0}:${mutation.mutator ?? "unknown"}`,
        reproducibility: 0.85,
        provenance: ["Prepared Infection report"],
      },
    }));
}

async function coverageCandidates(root: string): Promise<ImprovementCandidate[]> {
  const path = join(root, ".ai", "evidence", "clover.xml");
  let xml: string;
  try { xml = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const candidates: ImprovementCandidate[] = [];
  for (const match of xml.matchAll(/<file\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g)) {
    const rawFile = decodeXml(match[1] ?? "");
    const body = match[2] ?? "";
    const metrics = [...body.matchAll(/<metrics\s+([^>]+)\/?\s*>/g)].at(-1)?.[1] ?? "";
    const statements = Number(attribute(metrics, "statements") ?? 0);
    const covered = Number(attribute(metrics, "coveredstatements") ?? 0);
    if (statements < 5 || covered / statements >= 0.5) continue;
    const file = rawFile.startsWith(root) ? relative(root, rawFile) : rawFile;
    if (!/^(?:app\/Domain|src)\//.test(file)) continue;
    const percentage = Math.round((covered / statements) * 100);
    candidates.push({
      id: `coverage-${fingerprint(file)}`,
      kind: "test-protection",
      title: `Protect low-coverage domain behavior in ${file}`,
      rationale: `${file} has ${percentage}% statement coverage (${covered}/${statements}).`,
      confidence: 0.86,
      impact: 0.7,
      effort: 0.45,
      risk: 0.16,
      evidence: [`Clover statement coverage: ${percentage}%`],
      suggestedFiles: [file, "tests/Property"],
      target: file,
      estimatedDiffLines: 70,
      deduplication: {
        schemaVersion: "candidate-deduplication/v1",
        subsystem: file,
        defect: "statement-coverage-gap",
        reproducibility: 0.8,
        provenance: ["Prepared Clover report"],
      },
    });
  }
  return candidates;
}

interface ComplexityReport {
  readonly files?: readonly {
    readonly file?: string;
    readonly cyclomaticComplexity?: number;
    readonly maintainabilityIndex?: number;
  }[];
}

async function complexityCandidates(root: string): Promise<ImprovementCandidate[]> {
  const report = await optionalJson<ComplexityReport>(join(root, ".ai", "evidence", "complexity.json"));
  return (report?.files ?? [])
    .filter((finding): finding is Required<typeof finding> => Boolean(finding.file) && (finding.cyclomaticComplexity ?? 0) >= 15)
    .map((finding) => ({
      id: `complexity-${fingerprint(finding.file)}`,
      kind: "maintainability" as const,
      title: `Reduce verified complexity in ${finding.file}`,
      rationale: `${finding.file} has cyclomatic complexity ${finding.cyclomaticComplexity}.`,
      confidence: 0.82,
      impact: 0.58,
      effort: 0.62,
      risk: 0.32,
      evidence: [
        `Cyclomatic complexity: ${finding.cyclomaticComplexity}`,
        `Maintainability index: ${finding.maintainabilityIndex}`,
      ],
      suggestedFiles: [finding.file, "tests"],
      target: finding.file,
      estimatedDiffLines: 120,
    }));
}

async function todoCandidates(root: string): Promise<ImprovementCandidate[]> {
  const candidates: ImprovementCandidate[] = [];
  for await (const file of glob(["app/**/*.php", "src/**/*.php"], { cwd: root })) {
    const lines = (await readFile(join(root, file), "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (!/\b(?:TODO|FIXME)\b/i.test(line)) return;
      candidates.push({
        id: `todo-${fingerprint(`${file}:${index + 1}:${line.trim()}`)}`,
        kind: "maintainability",
        title: `Investigate explicit TODO in ${file}`,
        rationale: line.trim(),
        confidence: 0.7,
        impact: 0.35,
        effort: 0.45,
        risk: 0.25,
        evidence: [`TODO at ${file}:${index + 1}`],
        suggestedFiles: [file, "tests"],
        target: file,
        estimatedDiffLines: 60,
      });
    });
  }
  return candidates;
}

async function optionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid evidence file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]+)"`).exec(attributes)?.[1];
}

function decodeXml(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}
