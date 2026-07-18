import { createServer } from "node:net";
import { platform } from "node:os";
import type { CommandResult } from "../infra/command-runner.js";
import { CommandRunner } from "../infra/command-runner.js";

export interface BuilderNetworkPolicy {
  readonly schemaVersion: "builder-network-policy/v1";
  readonly outbound: "deny" | "allow";
}

export interface BuilderNetworkIsolation {
  run(
    command: readonly string[],
    cwd: string,
    timeoutMs: number,
    environment: Readonly<Record<string, string>>,
  ): Promise<CommandResult>;
}

export function validateBuilderNetworkPolicy(value: BuilderNetworkPolicy | undefined): BuilderNetworkPolicy {
  if (value === undefined) return { schemaVersion: "builder-network-policy/v1", outbound: "deny" };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2
    || value.schemaVersion !== "builder-network-policy/v1"
    || (value.outbound !== "deny" && value.outbound !== "allow")) {
    throw new Error("Builder network policy must be an exact trusted runner-owned value.");
  }
  return Object.freeze({ schemaVersion: value.schemaVersion, outbound: value.outbound });
}

export class PlatformBuilderNetworkIsolation implements BuilderNetworkIsolation {
  constructor(
    private readonly operatingSystem = platform(),
    private readonly runner = new CommandRunner(),
  ) {}

  async run(
    command: readonly string[],
    cwd: string,
    timeoutMs: number,
    environment: Readonly<Record<string, string>>,
  ): Promise<CommandResult> {
    const wrap = this.wrapper();
    await verifyNetworkDenial(wrap, cwd, environment, this.runner);
    return await this.runner.runWithExactEnvironment(wrap(command), cwd, timeoutMs, environment);
  }

  private wrapper(): (command: readonly string[]) => readonly string[] {
    if (this.operatingSystem === "darwin") {
      return (command) => [
        "/usr/bin/sandbox-exec",
        "-p",
        "(version 1) (allow default) (deny network*)",
        ...command,
      ];
    }
    if (this.operatingSystem === "linux") {
      return (command) => ["/usr/bin/unshare", "--user", "--map-root-user", "--net", "--", ...command];
    }
    throw new Error(`Builder outbound network denial is unavailable on this runner platform: ${this.operatingSystem}`);
  }
}

async function verifyNetworkDenial(
  wrap: (command: readonly string[]) => readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  runner: CommandRunner,
): Promise<void> {
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Builder network isolation verification endpoint is unavailable.");
    const probe = [
      process.execPath,
      "-e",
      "const net=require('node:net');const socket=net.connect(Number(process.argv[1]),'127.0.0.1');socket.setTimeout(1000);socket.on('connect',()=>process.exit(1));socket.on('error',()=>process.exit(0));socket.on('timeout',()=>process.exit(0));",
      String(address.port),
    ];
    const reachable = await runner.runWithExactEnvironment(probe, cwd, 5_000, environment);
    if (reachable.exitCode !== 1) {
      throw new Error("Builder network isolation verification endpoint is unreachable before isolation.");
    }
    const result = await runner.runWithExactEnvironment(wrap(probe), cwd, 5_000, environment);
    if (result.exitCode !== 0) {
      throw new Error("Builder outbound network denial is unavailable or could not be verified.");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
