import type { RequiredVerifierContract } from "../domain/required-verifier.js";
import { throwRequiredVerifierUnavailable } from "../domain/required-verifier.js";
import type { CommandResult, CommandRunner } from "../infra/command-runner.js";
import {
  runVerifierCommand,
  type VerifierCommandEnvironmentDecision,
} from "./verifier-command-environment.js";

export function unavailableRequiredVerifierAdapter(
  adapterId: string,
  verifierContract: RequiredVerifierContract,
): never {
  throwRequiredVerifierUnavailable(verifierContract, "adapter", "capability-unavailable", adapterId);
}

export async function runRequiredVerifierCommand(
  runner: CommandRunner,
  environment: VerifierCommandEnvironmentDecision,
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
  verifierContract: RequiredVerifierContract,
  selection: string,
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await runVerifierCommand(runner, environment, command, cwd, timeoutMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EACCES") {
      throwRequiredVerifierUnavailable(verifierContract, "command", "executable-unavailable", selection);
    }
    throw error;
  }
  if (result.exitCode === 126 || result.exitCode === 127) {
    throwRequiredVerifierUnavailable(verifierContract, "command", "executable-unavailable", selection);
  }
  return result;
}
