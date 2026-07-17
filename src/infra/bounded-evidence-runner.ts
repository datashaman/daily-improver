import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import type {
  EvidenceCommand,
  EvidenceCommandOutput,
  EvidenceResultStatus,
  EvidenceRun,
  EvidenceRunner,
} from "../contracts.js";

interface CapturedStream {
  readonly chunks: Buffer[];
  readonly hash: Hash;
  bytes: number;
  capturedBytes: number;
}

export class BoundedEvidenceRunner implements EvidenceRunner {
  async run(request: EvidenceCommand): Promise<EvidenceRun> {
    const [program, ...args] = request.command;
    if (!program) throw new Error("Cannot execute an empty evidence command.");
    if (request.timeoutMs <= 0) throw new Error("Evidence command timeout must be positive.");
    if (request.maxOutputBytes < 0) throw new Error("Evidence command output limit cannot be negative.");

    const started = performance.now();
    const stdout = capturedStream();
    const stderr = capturedStream();

    return await new Promise((resolve) => {
      const child = spawn(program, args, {
        cwd: request.cwd,
        env: { ...process.env, ...request.environment },
        shell: false,
      });
      let finished = false;
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const finish = (status: EvidenceResultStatus, exitCode: number | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        const output = {
          stdout: Buffer.concat(stdout.chunks).toString("utf8"),
          stderr: Buffer.concat(stderr.chunks).toString("utf8"),
        };
        resolve({
          result: {
            commandIdentity: request.identity,
            command: request.command,
            status,
            durationMs: Math.round(performance.now() - started),
            exitCode,
            stdoutHash: digest(stdout.hash),
            stderrHash: digest(stderr.hash),
            stdoutBytes: stdout.bytes,
            stderrBytes: stderr.bytes,
            outputLimitBytes: request.maxOutputBytes,
            outputTruncated: stdout.bytes > stdout.capturedBytes || stderr.bytes > stderr.capturedBytes,
          },
          output,
        });
      };

      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, request.maxOutputBytes));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, request.maxOutputBytes));

      child.once("error", (error: NodeJS.ErrnoException) => {
        finish(error.code === "ENOENT" ? "unavailable-tool" : "infrastructure-failure", null);
      });

      child.once("close", (code) => {
        if (finished) return;
        if (timedOut) {
          finish("timeout", code);
          return;
        }
        const output: EvidenceCommandOutput = {
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout.chunks).toString("utf8"),
          stderr: Buffer.concat(stderr.chunks).toString("utf8"),
          outputTruncated: stdout.bytes > stdout.capturedBytes || stderr.bytes > stderr.capturedBytes,
        };
        try {
          finish(request.classify(output), output.exitCode);
        } catch {
          finish("infrastructure-failure", output.exitCode);
        }
      });

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      }, request.timeoutMs);
    });
  }
}

function capturedStream(): CapturedStream {
  return { chunks: [], hash: createHash("sha256"), bytes: 0, capturedBytes: 0 };
}

function capture(stream: CapturedStream, chunk: Buffer, limit: number): void {
  stream.hash.update(chunk);
  stream.bytes += chunk.length;
  const remaining = limit - stream.capturedBytes;
  if (remaining <= 0) return;
  const captured = chunk.subarray(0, remaining);
  stream.chunks.push(captured);
  stream.capturedBytes += captured.length;
}

function digest(hash: Hash): string {
  return `sha256:${hash.digest("hex")}`;
}
