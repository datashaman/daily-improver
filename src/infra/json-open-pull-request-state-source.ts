import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { OpenPullRequestStateSource } from "../contracts.js";
import type { OpenPullRequestState } from "../domain/model.js";

const maxStateBytes = 4_096;
const maxOpenPullRequests = 10_000;
const maxStateAgeMs = 15 * 60 * 1_000;
const repositoryIdPattern = /^[a-f0-9]{64}$/u;
const repositoryScopePattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const stateKeys = ["observedAt", "openPullRequests", "repositoryId", "schemaVersion"] as const;

export class JsonOpenPullRequestStateSource implements OpenPullRequestStateSource {
  constructor(
    private readonly path?: string,
    private readonly repositoryScope?: string,
  ) {}

  async current(decidedAt: string): Promise<OpenPullRequestState> {
    if (!this.path || !this.repositoryScope) {
      throw new Error("Open pull request state and repository scope are required; set DAILY_IMPROVER_OPEN_PR_STATE_PATH and DAILY_IMPROVER_REPOSITORY_SCOPE.");
    }
    if (!repositoryScopePattern.test(this.repositoryScope)) {
      throw new Error("Open pull request repository scope is malformed or unbounded; refusing to continue.");
    }
    const decidedAtMs = timestamp(decidedAt, "Open pull request decision timestamp");
    let value: unknown;
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile() || metadata.size > maxStateBytes) throw new Error("Open pull request state is oversized or not a regular file; refusing to continue.");
      const content = await readFile(this.path);
      if (content.byteLength > maxStateBytes) throw new Error("Open pull request state is oversized; refusing to continue.");
      value = JSON.parse(content.toString("utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Open pull request state is missing; refusing to continue.");
      }
      if (error instanceof SyntaxError) throw new Error("Open pull request state is malformed; refusing to continue.");
      throw error;
    }
    if (!isState(value)) throw new Error("Open pull request state is malformed or unbounded; refusing to continue.");
    const repositoryId = createHash("sha256").update(this.repositoryScope).digest("hex");
    if (value.repositoryId !== repositoryId) {
      throw new Error("Open pull request state belongs to a different repository; refusing to continue.");
    }
    const observedAtMs = timestamp(value.observedAt, "Open pull request observation timestamp");
    if (observedAtMs > decidedAtMs || decidedAtMs - observedAtMs > maxStateAgeMs) {
      throw new Error("Open pull request state is stale or future-dated; refusing to continue.");
    }
    return value;
  }
}

function isState(value: unknown): value is OpenPullRequestState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  return keys.length === stateKeys.length
    && keys.every((key, index) => key === stateKeys[index])
    && candidate.schemaVersion === "open-pull-request-state/v1"
    && typeof candidate.repositoryId === "string"
    && repositoryIdPattern.test(candidate.repositoryId)
    && typeof candidate.observedAt === "string"
    && isTimestamp(candidate.observedAt)
    && Number.isInteger(candidate.openPullRequests)
    && (candidate.openPullRequests as number) >= 0
    && (candidate.openPullRequests as number) <= maxOpenPullRequests;
}

function timestamp(value: string, name: string): number {
  if (!isTimestamp(value)) throw new Error(`${name} is malformed.`);
  return new Date(value).getTime();
}

function isTimestamp(value: string): boolean {
  try { return new Date(value).toISOString() === value; }
  catch { return false; }
}
