import type { CommandRunner } from "../infra/command-runner.js";
import { assertVerificationReport, type VerificationReport } from "../domain/verification-report.js";

const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

export type PublicationVerificationBinding = VerificationReport;

export interface PublicationAuthorization {
  readonly schemaVersion: "publication-authorization/v1";
  readonly expectedBaseSha: string;
  readonly checkedMainSha: string;
  readonly verifierInputsSha256: string;
  readonly outcome: "authorized";
  readonly decidedAt: string;
}

export async function authorizePublication(
  trustedRepository: string,
  trustedMainReference: string,
  verificationValue: unknown,
  decidedAt: string,
  runner: CommandRunner,
): Promise<PublicationAuthorization> {
  const verification = assertVerificationReport(verificationValue);
  assertDecisionTime(decidedAt);
  if (!trustedMainReference || trustedMainReference.length > 256 || trustedMainReference.startsWith("-") || trustedMainReference.includes("\0")) {
    throw new Error("Trusted main reference is malformed.");
  }

  const resolved = await runner.run(
    ["git", "rev-parse", "--verify", `${trustedMainReference}^{commit}`],
    trustedRepository,
  );
  const lines = resolved.stdout.split("\n").filter((line) => line.length > 0);
  if (resolved.exitCode !== 0 || lines.length !== 1 || !commitPattern.test(lines[0]!)) {
    throw new Error("Trusted main reference did not resolve to one unambiguous commit.");
  }
  const checkedMainSha = lines[0]!;
  const objectType = await runner.run(["git", "cat-file", "-t", checkedMainSha], trustedRepository);
  if (objectType.exitCode !== 0 || objectType.stdout.trim() !== "commit") {
    throw new Error("Trusted main reference is missing or is not a commit.");
  }
  if (checkedMainSha !== verification.expectedBaseSha) {
    throw new Error("Trusted main no longer matches the independently verified baseline.");
  }

  return {
    schemaVersion: "publication-authorization/v1",
    expectedBaseSha: verification.expectedBaseSha,
    checkedMainSha,
    verifierInputsSha256: verification.verifierInputsSha256,
    outcome: "authorized",
    decidedAt,
  };
}

function assertDecisionTime(value: string): void {
  if (value.length > 64 || new Date(value).toISOString() !== value) {
    throw new Error("Publication authorization decision time is malformed.");
  }
}
