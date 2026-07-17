import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DailyImprovementStore } from "../contracts.js";
import type { DailyImprovementDecision } from "../domain/model.js";

const utcDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const repositoryIdPattern = /^[a-f0-9]{64}$/u;
const claimIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const decisionKeys = ["claimId", "decidedAt", "outcome", "repositoryId", "schemaVersion", "utcDate"] as const;
const maxDecisionBytes = 4_096;

export class JsonDailyImprovementStore implements DailyImprovementStore {
  constructor(private readonly stateDirectory: string) {}

  async claim(repository: string, utcDate: string, decidedAt: string): Promise<DailyImprovementDecision> {
    validateDate(utcDate);
    validateTimestamp(decidedAt);
    const repositoryId = createHash("sha256").update(await realpath(repository)).digest("hex");
    const decision: DailyImprovementDecision = {
      schemaVersion: "daily-improvement-decision/v1",
      repositoryId,
      utcDate,
      claimId: randomUUID(),
      outcome: "claimed",
      decidedAt,
    };
    const file = this.file(repositoryId, utcDate);
    await mkdir(dirname(file), { recursive: true });
    try {
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(decision, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return decision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.read(file, repositoryId, utcDate);
      return {
        ...existing,
        outcome: existing.outcome === "completed" ? "blocked-completed" : "blocked-active",
        decidedAt,
      };
    }
  }

  async complete(decision: DailyImprovementDecision, decidedAt: string): Promise<DailyImprovementDecision> {
    validateTimestamp(decidedAt);
    return await this.transition(decision, "completed", decidedAt);
  }

  async release(decision: DailyImprovementDecision, decidedAt: string): Promise<DailyImprovementDecision> {
    validateTimestamp(decidedAt);
    const file = this.file(decision.repositoryId, decision.utcDate);
    return await this.withLock(file, async () => {
      const existing = await this.read(file, decision.repositoryId, decision.utcDate);
      assertActiveClaim(existing, decision);
      await rm(file);
      return { ...decision, outcome: "released", decidedAt };
    });
  }

  private async transition(
    decision: DailyImprovementDecision,
    outcome: "completed",
    decidedAt: string,
  ): Promise<DailyImprovementDecision> {
    const file = this.file(decision.repositoryId, decision.utcDate);
    return await this.withLock(file, async () => {
      const existing = await this.read(file, decision.repositoryId, decision.utcDate);
      assertActiveClaim(existing, decision);
      const completed: DailyImprovementDecision = { ...decision, outcome, decidedAt };
      const temporary = `${file}.${decision.claimId}.tmp`;
      await writeFile(temporary, `${JSON.stringify(completed, null, 2)}\n`, "utf8");
      await rename(temporary, file);
      return completed;
    });
  }

  private async withLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const lock = `${file}.lock`;
    let handle;
    try {
      handle = await open(lock, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Daily improvement state is already being updated; refusing to continue.");
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await rm(lock, { force: true });
    }
  }

  private async read(file: string, repositoryId: string, utcDate: string): Promise<DailyImprovementDecision> {
    if ((await stat(file)).size > maxDecisionBytes) {
      throw new Error("Persisted daily improvement state is oversized; refusing to continue.");
    }
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isDecision(value) || value.repositoryId !== repositoryId || value.utcDate !== utcDate) {
      throw new Error("Persisted daily improvement state is malformed; refusing to continue.");
    }
    return value;
  }

  private file(repositoryId: string, utcDate: string): string {
    if (!repositoryIdPattern.test(repositoryId)) throw new Error("Daily improvement repository identity is malformed.");
    validateDate(utcDate);
    return join(this.stateDirectory, "daily-improvements", repositoryId, `${utcDate}.json`);
  }
}

function assertActiveClaim(existing: DailyImprovementDecision, decision: DailyImprovementDecision): void {
  if (existing.outcome !== "claimed" || decision.outcome !== "claimed" || existing.claimId !== decision.claimId) {
    throw new Error("Daily improvement claim is no longer active; refusing to continue.");
  }
}

function validateDate(value: string): void {
  if (!utcDatePattern.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("Daily improvement UTC date is malformed.");
  }
}

function isDecision(value: unknown): value is DailyImprovementDecision {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  return keys.length === decisionKeys.length
    && keys.every((key, index) => key === decisionKeys[index])
    && candidate.schemaVersion === "daily-improvement-decision/v1"
    && typeof candidate.repositoryId === "string"
    && repositoryIdPattern.test(candidate.repositoryId)
    && typeof candidate.utcDate === "string"
    && utcDatePattern.test(candidate.utcDate)
    && typeof candidate.claimId === "string"
    && claimIdPattern.test(candidate.claimId)
    && (candidate.outcome === "claimed" || candidate.outcome === "completed")
    && typeof candidate.decidedAt === "string"
    && isIsoTimestamp(candidate.decidedAt);
}

function isIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateTimestamp(value: string): void {
  if (!isIsoTimestamp(value)) throw new Error("Daily improvement decision timestamp is malformed.");
}
