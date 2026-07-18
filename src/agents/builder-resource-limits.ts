import type { CommandExecutionLimits, CommandResult } from "../infra/command-runner.js";
import { platform } from "node:os";

export type BuilderResource = "cpu" | "memory" | "disk" | "output" | "wall-clock";

export interface BuilderResourceLimits {
  readonly schemaVersion: "builder-resource-limits/v1";
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
  readonly outputBytes: number;
  readonly wallClockMs: number;
}

export type BuilderCommandExecutor = (
  command: readonly string[],
  cwd: string,
  limits: CommandExecutionLimits,
  environment: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

export interface BuilderResourceIsolation {
  run(
    command: readonly string[],
    cwd: string,
    limits: BuilderResourceLimits,
    environment: Readonly<Record<string, string>>,
    execute: BuilderCommandExecutor,
  ): Promise<CommandResult>;
}

const bounds = Object.freeze({
  cpuTimeMs: [100, 60 * 60_000],
  memoryBytes: [16 * 1024 * 1024, 64 * 1024 * 1024 * 1024],
  diskBytes: [1_024, 16 * 1024 * 1024 * 1024],
  outputBytes: [1_024, 16 * 1024 * 1024],
  wallClockMs: [100, 60 * 60_000],
} as const);

export function validateBuilderResourceLimits(value: BuilderResourceLimits | undefined): BuilderResourceLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 6
    || value.schemaVersion !== "builder-resource-limits/v1") {
    throw new Error("Builder resource limits must be an exact trusted runner-owned value.");
  }
  for (const [name, [minimum, maximum]] of Object.entries(bounds)) {
    const candidate = value[name as keyof typeof bounds];
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
      throw new Error(`Builder ${name} limit is outside its supported bounds.`);
    }
  }
  if (value.cpuTimeMs > value.wallClockMs) {
    throw new Error("Builder CPU time may not exceed its wall-clock limit.");
  }
  return Object.freeze({ ...value });
}

export class PlatformBuilderResourceIsolation implements BuilderResourceIsolation {
  constructor(private readonly operatingSystem = platform()) {}

  async run(
    command: readonly string[],
    cwd: string,
    limits: BuilderResourceLimits,
    environment: Readonly<Record<string, string>>,
    execute: BuilderCommandExecutor,
  ): Promise<CommandResult> {
    const validated = validateBuilderResourceLimits(limits);
    const cpuSeconds = Math.max(1, Math.ceil(validated.cpuTimeMs / 1_000));
    const diskBlocks = Math.max(1, Math.floor(validated.diskBytes / 512));
    if (this.operatingSystem !== "darwin" && this.operatingSystem !== "linux") {
      throw new Error(`Builder resource enforcement is unavailable on this runner platform: ${this.operatingSystem}`);
    }
    const wrapped = [
      "/bin/sh",
      "-c",
      "ulimit -t \"$1\" && ulimit -f \"$2\" && shift 2 && exec \"$@\"",
      "daily-improver-resource-limits",
      String(cpuSeconds),
      String(diskBlocks),
      ...command,
    ];
    return await execute(wrapped, cwd, {
      cpuTimeMs: validated.cpuTimeMs,
      memoryBytes: validated.memoryBytes,
      diskBytes: validated.diskBytes,
      outputBytes: validated.outputBytes,
      wallClockMs: validated.wallClockMs,
    }, environment);
  }
}

export const defaultBuilderResourceLimits: BuilderResourceLimits = Object.freeze({
  schemaVersion: "builder-resource-limits/v1",
  cpuTimeMs: 5 * 60_000,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  diskBytes: 512 * 1024 * 1024,
  outputBytes: 1024 * 1024,
  wallClockMs: 20 * 60_000,
});
