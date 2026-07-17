import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { CommandRunner } from "./command-runner.js";

export interface IsolatedWorkspace {
  readonly path: string;
  readonly branch: string;
  cleanup(): Promise<void>;
}

export class GitWorkspaceManager {
  constructor(
    private readonly baseDirectory: string,
    private readonly runner = new CommandRunner(),
  ) {}

  async create(repository: string, runId: string, branchName?: string): Promise<IsolatedWorkspace> {
    const safeId = runId.replace(/[^a-zA-Z0-9-]/g, "-");
    const branch = branchName ?? `daily-improver/${safeId}`;
    const path = join(this.baseDirectory, `${basename(repository)}-${safeId}`);
    await mkdir(this.baseDirectory, { recursive: true });
    const result = await this.runner.run(["git", "worktree", "add", "-b", branch, path, "HEAD"], repository);
    if (result.exitCode !== 0) throw new Error(`Unable to create isolated worktree: ${result.stderr.trim()}`);
    return {
      path,
      branch,
      cleanup: async () => {
        await this.runner.run(["git", "worktree", "remove", "--force", path], repository);
        await rm(path, { recursive: true, force: true });
      },
    };
  }
}
