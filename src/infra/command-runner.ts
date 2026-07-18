import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type CommandResourceExhaustion = "cpu" | "memory" | "disk" | "output" | "wall-clock";

export interface CommandExecutionLimits {
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
  readonly outputBytes: number;
  readonly wallClockMs: number;
}

export interface CommandResult {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly resourceExhausted?: CommandResourceExhaustion;
}

export class CommandRunner {
  async run(
    command: readonly string[],
    cwd: string,
    timeoutMs = 10 * 60_000,
    environment: Readonly<Record<string, string>> = {},
  ): Promise<CommandResult> {
    return await this.execute(command, cwd, timeoutMs, { ...process.env, ...environment });
  }

  async runWithExactEnvironment(
    command: readonly string[],
    cwd: string,
    timeoutMs: number,
    environment: Readonly<Record<string, string>>,
  ): Promise<CommandResult> {
    return await this.execute(command, cwd, timeoutMs, environment);
  }

  async runBoundedWithExactEnvironment(
    command: readonly string[],
    cwd: string,
    limits: CommandExecutionLimits,
    environment: Readonly<Record<string, string>>,
  ): Promise<CommandResult> {
    return await this.execute(command, cwd, limits.wallClockMs, environment, limits);
  }

  private async execute(
    command: readonly string[],
    cwd: string,
    timeoutMs: number,
    environment: Readonly<Record<string, string | undefined>>,
    limits?: CommandExecutionLimits,
  ): Promise<CommandResult> {
    const [program, ...args] = command;
    if (!program) throw new Error("Cannot execute an empty command.");
    if (limits) assertProcessAccountingAvailable();
    const started = performance.now();
    return await new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd, env: environment, shell: false, detached: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedBytes = 0;
      let resourceExhausted: CommandResourceExhaustion | undefined;
      let escalation: NodeJS.Timeout | undefined;
      const baselineDiskBytes = limits ? directoryBytes(cwd) : 0;
      const terminate = (reason?: CommandResourceExhaustion) => {
        if (reason && !resourceExhausted) resourceExhausted = reason;
        signalProcessGroup(child.pid, "SIGTERM");
        escalation ??= setTimeout(() => signalProcessGroup(child.pid, "SIGKILL"), 100);
      };
      const capture = (target: Buffer[], chunk: Buffer) => {
        const available = limits ? Math.max(0, limits.outputBytes - capturedBytes) : chunk.length;
        if (available > 0) {
          const retained = chunk.subarray(0, available);
          target.push(retained);
          capturedBytes += retained.length;
        }
        if (limits && chunk.length > available) terminate("output");
      };
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      const timer = setTimeout(() => terminate("wall-clock"), timeoutMs);
      const monitor = limits ? setInterval(() => {
        const usage = processGroupUsage(child.pid);
        if (usage.cpuTimeMs > limits.cpuTimeMs) terminate("cpu");
        else if (usage.memoryBytes > limits.memoryBytes) terminate("memory");
        else if (directoryBytes(cwd) - baselineDiskBytes > limits.diskBytes) terminate("disk");
      }, 20) : undefined;
      child.once("error", (error) => {
        clearTimeout(timer);
        if (monitor) clearInterval(monitor);
        if (escalation) clearTimeout(escalation);
        reject(error);
      });
      child.once("exit", (_code, signal) => {
        if (!resourceExhausted && signal === "SIGXCPU") resourceExhausted = "cpu";
        if (!resourceExhausted && signal === "SIGXFSZ") resourceExhausted = "disk";
        signalProcessGroup(child.pid, "SIGTERM");
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (monitor) clearInterval(monitor);
        if (escalation) clearTimeout(escalation);
        if (!resourceExhausted && code === 152) resourceExhausted = "cpu";
        if (!resourceExhausted && code === 153) resourceExhausted = "disk";
        const result: CommandResult = {
          command,
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          durationMs: Math.round(performance.now() - started),
          ...(resourceExhausted ? { resourceExhausted } : {}),
        };
        resolve(result);
      });
    });
  }
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* The complete group has already exited. */ }
}

function processGroupUsage(pid: number | undefined): { readonly cpuTimeMs: number; readonly memoryBytes: number } {
  if (!pid) return { cpuTimeMs: 0, memoryBytes: 0 };
  if (linuxAccounting) return linuxProcessGroupUsage(pid, linuxAccounting);
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,rss=,time="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) return { cpuTimeMs: 0, memoryBytes: 0 };
  let cpuTimeMs = 0;
  let memoryBytes = 0;
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+((?:(\d+)-)?\d+:\d+(?::\d+)?(?:\.\d+)?)$/u);
    if (!match || Number(match[1]) !== pid) continue;
    memoryBytes += Number(match[2]) * 1_024;
    cpuTimeMs += parseProcessTime(match[3] ?? "0:00");
  }
  return { cpuTimeMs, memoryBytes };
}

interface LinuxAccounting {
  readonly clockTicksPerSecond: number;
  readonly pageBytes: number;
}

const linuxAccounting = process.platform === "linux" && existsSync("/proc/self/stat")
  ? loadLinuxAccounting()
  : undefined;

function loadLinuxAccounting(): LinuxAccounting | undefined {
  const clockTicksPerSecond = Number(spawnSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim());
  const pageBytes = Number(spawnSync("/usr/bin/getconf", ["PAGESIZE"], { encoding: "utf8" }).stdout.trim());
  return Number.isSafeInteger(clockTicksPerSecond) && clockTicksPerSecond > 0
    && Number.isSafeInteger(pageBytes) && pageBytes > 0
    ? { clockTicksPerSecond, pageBytes }
    : undefined;
}

function linuxProcessGroupUsage(pid: number, accounting: LinuxAccounting): {
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
} {
  let cpuTicks = 0;
  let residentPages = 0;
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    let stat: string;
    try { stat = readFileSync(`/proc/${entry.name}/stat`, "utf8"); } catch { continue; }
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    if (Number(fields[2]) !== pid) continue;
    cpuTicks += Number(fields[11]) + Number(fields[12]);
    residentPages += Number(fields[21]);
  }
  return {
    cpuTimeMs: cpuTicks * 1_000 / accounting.clockTicksPerSecond,
    memoryBytes: residentPages * accounting.pageBytes,
  };
}

function assertProcessAccountingAvailable(): void {
  if (linuxAccounting) return;
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,rss=,time="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error || result.stdout.length === 0) {
    throw new Error("Builder process-group resource accounting is unavailable on this runner.");
  }
}

function parseProcessTime(value: string): number {
  const [dayPart, clockPart] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = (clockPart ?? "0:00").split(":").map(Number);
  const seconds = parts.length === 3
    ? (parts[0] ?? 0) * 3_600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)
    : (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  return (Number(dayPart) * 86_400 + seconds) * 1_000;
}

function directoryBytes(root: string): number {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try { total += lstatSync(path).size; } catch { /* Concurrent builder mutation. */ }
      }
    }
  }
  return total;
}
