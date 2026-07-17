import type { EvidenceResult, EvidenceRunner } from "../contracts.js";
import type { ImprovementCandidate } from "../domain/model.js";
import { phpEvidenceProvenance } from "./php-provenance.js";
import { reproducibleEvidence } from "../domain/candidate-reproducibility.js";

const composerValidateCommand = [
  "composer",
  "validate",
  "--no-interaction",
  "--no-plugins",
] as const;

export interface ComposerValidationEvidence {
  readonly result: EvidenceResult;
  readonly candidates: readonly ImprovementCandidate[];
}

export async function collectComposerValidationEvidence(
  root: string,
  runner: EvidenceRunner,
): Promise<ComposerValidationEvidence> {
  const run = await runner.run({
    identity: "composer.validate",
    command: composerValidateCommand,
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    provenance: phpEvidenceProvenance(
      ["composer", "--version"],
      ["composer.json", "composer.lock"],
    ),
    classify: ({ exitCode, stdout, stderr }) => {
      if (exitCode !== 0) return "configuration-failure";
      return /warning|not recommended/i.test(`${stdout}\n${stderr}`) ? "code-finding" : "success";
    },
  });

  const candidates = run.result.status === "code-finding" || run.result.status === "configuration-failure"
    ? [composerValidationCandidate(run.result)]
    : [];
  return { result: run.result, candidates };
}

function composerValidationCandidate(result: EvidenceResult): ImprovementCandidate {
  const failure = result.status === "configuration-failure";
  return {
    id: "php-composer-validation",
    kind: "maintainability",
    title: failure ? "Repair invalid Composer configuration" : "Resolve Composer validation warnings",
    rationale: failure
      ? "Composer cannot validate the repository dependency manifest."
      : "Composer reported dependency-manifest warnings that should be resolved before publishing or updating dependencies.",
    confidence: 0.98,
    impact: failure ? 0.9 : 0.55,
    effort: 0.25,
    risk: 0.2,
    evidence: [
      `${result.commandIdentity} returned ${result.status} with exit code ${result.exitCode ?? "none"}`,
      `stdout ${result.stdoutHash}; stderr ${result.stderrHash}`,
    ],
    suggestedFiles: ["composer.json", "composer.lock"],
    reproducibility: reproducibleEvidence(0.99, [result.commandIdentity, result.provenance.toolVersion ?? "unknown Composer version"]),
  };
}
