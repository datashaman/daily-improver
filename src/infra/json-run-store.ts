import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunStore } from "../contracts.js";
import type { ImprovementRun } from "../domain/model.js";

export class JsonRunStore implements RunStore {
  constructor(private readonly stateDirectory: string) {}

  async save(run: ImprovementRun): Promise<void> {
    const file = this.file(run.repository);
    await mkdir(dirname(file), { recursive: true });
    const runs = [...(await this.list(run.repository)), run];
    await writeFile(file, `${JSON.stringify(runs, null, 2)}\n`, "utf8");
  }

  async list(repository: string): Promise<readonly ImprovementRun[]> {
    try {
      return JSON.parse(await readFile(this.file(repository), "utf8")) as ImprovementRun[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private file(repository: string): string {
    const key = Buffer.from(repository).toString("base64url");
    return join(this.stateDirectory, "runs", `${key}.json`);
  }
}
