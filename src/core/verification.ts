import type { CapabilityKind, RepositoryProfile } from "../domain/model.js";
import { CommandRunner, type CommandResult } from "../infra/command-runner.js";

export interface VerificationResult {
  readonly passed: boolean;
  readonly checks: readonly CommandResult[];
  readonly skipped: readonly CapabilityKind[];
}

export class Verifier {
  constructor(private readonly runner = new CommandRunner()) {}

  async verify(
    profile: RepositoryProfile,
    required: readonly CapabilityKind[],
  ): Promise<VerificationResult> {
    const checks: CommandResult[] = [];
    const skipped: CapabilityKind[] = [];
    for (const kind of required) {
      const capability = profile.capabilities.get(kind);
      if (!capability) {
        skipped.push(kind);
        continue;
      }
      const result = await this.runner.run(capability.command, profile.root);
      checks.push(result);
      if (result.exitCode !== 0) break;
    }
    return { passed: checks.every((check) => check.exitCode === 0) && skipped.length === 0, checks, skipped };
  }
}
