import { createHash } from "node:crypto";
import type { CommandRunner } from "../infra/command-runner.js";

export async function captureVerifierExecutionState(root: string, base: string, runner: CommandRunner): Promise<string> {
  const status = await runner.run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  if (status.exitCode !== 0 || status.stdout.length > 4 * 1024 * 1024) throw new Error("Unable to capture bounded verifier state before targeted mutation.");
  const diff = await runner.run(["git", "diff", "--binary", "--no-ext-diff", base], root);
  if (diff.exitCode !== 0 || diff.stdout.length > 8 * 1024 * 1024) throw new Error("Unable to capture bounded verifier diff before targeted mutation.");
  return createHash("sha256").update(status.stdout).update("\0").update(diff.stdout).digest("hex");
}

export async function assertVerifierExecutionStateUnchanged(
  root: string,
  base: string,
  expectedState: string,
  runner: CommandRunner,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(expectedState) || await captureVerifierExecutionState(root, base, runner) !== expectedState) {
    throw new Error("Verifier policy execution changed the fresh verifier checkout.");
  }
}
