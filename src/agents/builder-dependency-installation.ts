import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CommandResult } from "../infra/command-runner.js";
import type { CommandExecutionLimits } from "../infra/command-runner.js";
import type { BuilderCommandExecutor } from "./builder-resource-limits.js";

export interface BuilderDependencyInstallationPolicy {
  readonly schemaVersion: "builder-dependency-installation-policy/v1";
  readonly installation: "deny" | "allow";
}

export interface BuilderDependencyInstallationIsolation {
  run(
    command: readonly string[],
    cwd: string,
    limits: CommandExecutionLimits,
    environment: Readonly<Record<string, string>>,
    execute: BuilderCommandExecutor,
  ): Promise<CommandResult>;
}

export function validateBuilderDependencyInstallationPolicy(
  value: BuilderDependencyInstallationPolicy | undefined,
): BuilderDependencyInstallationPolicy {
  if (value === undefined) {
    return { schemaVersion: "builder-dependency-installation-policy/v1", installation: "deny" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2
    || value.schemaVersion !== "builder-dependency-installation-policy/v1"
    || (value.installation !== "deny" && value.installation !== "allow")) {
    throw new Error("Builder dependency installation policy must be an exact trusted runner-owned value.");
  }
  return Object.freeze({ schemaVersion: value.schemaVersion, installation: value.installation });
}

// This registry belongs to the command execution boundary rather than the
// language-neutral orchestration core. Denying every invocation is deliberate:
// package-manager scripts and aliases can install indirectly, so subcommand
// allowlisting would not fail closed.
export const builderPackageManagerExecutablesByEcosystem = Object.freeze({
  php: ["composer", "composer.phar", "pear", "pecl"],
  javascript: ["npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "corepack"],
  python: ["pip", "pip3", "pipx", "poetry", "uv"],
  ruby: ["gem", "bundle", "bundler"],
  rust: ["cargo"],
  go: ["go"],
  jvm: ["mvn", "mvnw", "gradle", "gradlew"],
  dotnet: ["dotnet", "nuget"],
} as const);

export const builderPackageManagerExecutables = Object.freeze(
  Object.values(builderPackageManagerExecutablesByEcosystem).flat(),
);

export class PackageManagerBuilderDependencyIsolation implements BuilderDependencyInstallationIsolation {
  async run(
    command: readonly string[],
    cwd: string,
    limits: CommandExecutionLimits,
    environment: Readonly<Record<string, string>>,
    execute: BuilderCommandExecutor,
  ): Promise<CommandResult> {
    assertCommandUsesInterceptedPackageManagers(command);
    const shimDirectory = await mkdtemp(join(tmpdir(), "daily-improver-package-manager-deny-"));
    try {
      for (const executable of builderPackageManagerExecutables) {
        const path = join(shimDirectory, executable);
        await writeFile(path, "#!/bin/sh\nprintf '%s\\n' 'Builder dependency installation is denied by trusted runner policy.' >&2\nexit 126\n", { mode: 0o500 });
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

function assertCommandUsesInterceptedPackageManagers(command: readonly string[]): void {
  const configuredCommand = command.length === 3 && command[0] === "/bin/sh" && command[1] === "-c"
    ? command[2]
    : undefined;
  if (configuredCommand === undefined || configuredCommand.includes("\0")) {
    throw new Error("Builder dependency installation denial requires one bounded shell command.");
  }
  if (/(?:^|[;&|()\s])(?:export\s+)?PATH\s*=/u.test(configuredCommand)) {
    throw new Error("Builder command may not replace PATH while dependency installation is denied.");
  }
  const managers = new Set<string>(builderPackageManagerExecutables);
  for (const token of configuredCommand.match(/[^\s;&|()]+/gu) ?? []) {
    const unquoted = token.replace(/^["']|["']$/gu, "");
    if (unquoted.includes("/") && managers.has(basename(unquoted))) {
      throw new Error("Builder package-manager paths must be resolved through the trusted runner PATH.");
    }
  }
}
