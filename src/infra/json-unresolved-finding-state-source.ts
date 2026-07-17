import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { UnresolvedFindingStateSource } from "../contracts.js";
import type { UnresolvedFindingState } from "../domain/model.js";

const maxStateBytes = 80_000;
const maxFindingIds = 1_000;
const maxStateAgeMs = 15 * 60 * 1_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const repositoryScopePattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const stateKeys = ["findingIds", "observedAt", "repositoryId", "schemaVersion"] as const;

export class JsonUnresolvedFindingStateSource implements UnresolvedFindingStateSource {
  constructor(
    private readonly path?: string,
    private readonly repositoryScope?: string,
  ) {}

  async current(decidedAt: string): Promise<UnresolvedFindingState> {
    if (!this.path || !this.repositoryScope) {
      throw new Error("Unresolved finding state and repository scope are required; set DAILY_IMPROVER_UNRESOLVED_FINDING_STATE_PATH and DAILY_IMPROVER_REPOSITORY_SCOPE.");
    }
    if (!repositoryScopePattern.test(this.repositoryScope)) {
      throw new Error("Unresolved finding repository scope is malformed or unbounded; refusing to continue.");
    }
    const decidedAtMs = timestamp(decidedAt, "Unresolved finding decision timestamp");
    let value: unknown;
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile() || metadata.size > maxStateBytes) throw new Error("Unresolved finding state is oversized or not a regular file; refusing to continue.");
      const content = await readFile(this.path);
      if (content.byteLength > maxStateBytes) throw new Error("Unresolved finding state is oversized; refusing to continue.");
      value = JSON.parse(content.toString("utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Unresolved finding state is missing; refusing to continue.");
      if (error instanceof SyntaxError) throw new Error("Unresolved finding state is malformed; refusing to continue.");
      throw error;
    }
    if (!isState(value)) throw new Error("Unresolved finding state is malformed or unbounded; refusing to continue.");
    const repositoryId = createHash("sha256").update(this.repositoryScope).digest("hex");
    if (value.repositoryId !== repositoryId) throw new Error("Unresolved finding state belongs to a different repository; refusing to continue.");
    const observedAtMs = timestamp(value.observedAt, "Unresolved finding observation timestamp");
    if (observedAtMs > decidedAtMs || decidedAtMs - observedAtMs > maxStateAgeMs) {
      throw new Error("Unresolved finding state is stale or future-dated; refusing to continue.");
    }
    return value;
  }
}

function isState(value: unknown): value is UnresolvedFindingState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== stateKeys.length || !keys.every((key, index) => key === stateKeys[index])) return false;
  if (candidate.schemaVersion !== "unresolved-finding-state/v1"
    || typeof candidate.repositoryId !== "string"
    || !sha256Pattern.test(candidate.repositoryId)
    || typeof candidate.observedAt !== "string"
    || !isTimestamp(candidate.observedAt)
    || !Array.isArray(candidate.findingIds)
    || candidate.findingIds.length > maxFindingIds
    || !candidate.findingIds.every((id) => typeof id === "string" && sha256Pattern.test(id))) return false;
  return new Set(candidate.findingIds).size === candidate.findingIds.length;
}

function timestamp(value: string, name: string): number {
  if (!isTimestamp(value)) throw new Error(`${name} is malformed.`);
  return new Date(value).getTime();
}

function isTimestamp(value: string): boolean {
  try { return new Date(value).toISOString() === value; }
  catch { return false; }
}
