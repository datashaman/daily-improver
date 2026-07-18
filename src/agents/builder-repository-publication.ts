import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CommandResult, CommandExecutionLimits } from "../infra/command-runner.js";
import type { BuilderCommandExecutor } from "./builder-resource-limits.js";

export interface BuilderRepositoryPublicationIsolation {
  run(
    command: readonly string[],
    cwd: string,
    limits: CommandExecutionLimits,
    environment: Readonly<Record<string, string>>,
    execute: BuilderCommandExecutor,
  ): Promise<CommandResult>;
}

// Publication belongs to the trusted publisher boundary. Builders never need
// either repository mutation commands or pull-request tooling, regardless of
// ecosystem, repository instructions, or the independent network decision.
export const builderRepositoryPublicationExecutables = Object.freeze(["git", "gh"] as const);

export class RepositoryPublicationBuilderIsolation implements BuilderRepositoryPublicationIsolation {
  async run(
    command: readonly string[],
    cwd: string,
    limits: CommandExecutionLimits,
    environment: Readonly<Record<string, string>>,
    execute: BuilderCommandExecutor,
  ): Promise<CommandResult> {
    assertCommandUsesInterceptedPublicationTools(command);
    const shimDirectory = await mkdtemp(join(tmpdir(), "daily-improver-publication-deny-"));
    try {
      for (const executable of builderRepositoryPublicationExecutables) {
        const path = join(shimDirectory, executable);
        await writeFile(
          path,
          "#!/bin/sh\nprintf '%s\\n' 'Builder repository publication tooling is denied by trusted runner policy.' >&2\nexit 126\n",
          { mode: 0o500 },
        );
        await chmod(path, 0o500);
      }
      return await execute(command, cwd, limits, {
        ...environment,
        PATH: `${shimDirectory}:${environment.PATH}`,
      });
    } finally {
      await rm(shimDirectory, { recursive: true, force: true });
    }
  }
}

function assertCommandUsesInterceptedPublicationTools(command: readonly string[]): void {
  const configuredCommand = command.length === 3 && command[0] === "/bin/sh" && command[1] === "-c"
    ? command[2]
    : undefined;
  if (configuredCommand === undefined || configuredCommand.includes("\0")) {
    throw new Error("Builder repository publication denial requires one bounded shell command.");
  }
  if (/(?:^|[;&|()\s])(?:export\s+)?PATH\s*=/u.test(configuredCommand)) {
    throw new Error("Builder command may not replace PATH while repository publication tooling is denied.");
  }
  const executables = new Set<string>(builderRepositoryPublicationExecutables);
  for (const token of configuredCommand.match(/[^\s;&|()]+/gu) ?? []) {
    const unquoted = token.replace(/^["']|["']$/gu, "");
    if (unquoted.includes("/") && executables.has(basename(unquoted))) {
      throw new Error("Builder repository publication tool paths must be resolved through the trusted runner PATH.");
    }
  }
}
