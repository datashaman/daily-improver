import { spawn } from "node:child_process";

export interface CommandResult {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export class CommandRunner {
  async run(
    command: readonly string[],
    cwd: string,
    timeoutMs = 10 * 60_000,
    environment: Readonly<Record<string, string>> = {},
  ): Promise<CommandResult> {
    const [program, ...args] = command;
    if (!program) throw new Error("Cannot execute an empty command.");
    const started = performance.now();
    return await new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd, env: { ...process.env, ...environment }, shell: false });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ command, exitCode: code ?? 1, stdout, stderr, durationMs: Math.round(performance.now() - started) });
      });
    });
  }
}
