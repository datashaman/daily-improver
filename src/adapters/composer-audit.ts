import type {
  EvidenceCommandOutput,
  EvidenceResult,
  EvidenceResultStatus,
  EvidenceRunner,
} from "../contracts.js";
import type { ImprovementCandidate } from "../domain/model.js";
import { phpEvidenceProvenance } from "./php-provenance.js";
import { reproducibleEvidence } from "../domain/candidate-reproducibility.js";

const composerAuditCommand = [
  "composer",
  "audit",
  "--format=json",
  "--no-interaction",
  "--no-plugins",
] as const;

export const composerAuditSchemaVersion = "composer-audit-evidence/v1" as const;

export type ComposerAuditFinding =
  | ComposerVulnerabilityFinding
  | ComposerAbandonedPackageFinding
  | ComposerPolicyFinding;

export interface ComposerVulnerabilityFinding {
  readonly kind: "vulnerability";
  readonly id: string;
  readonly packageName: string;
  readonly advisoryId: string;
  readonly cve?: string;
  readonly affectedVersions?: string;
  readonly severity?: string;
}

export interface ComposerAbandonedPackageFinding {
  readonly kind: "abandoned-package";
  readonly id: string;
  readonly packageName: string;
  readonly replacement?: string;
}

export interface ComposerPolicyFinding {
  readonly kind: "policy";
  readonly id: string;
  readonly packageName: string;
  readonly policyName: string;
  readonly policyEntryId?: string;
}

export interface ComposerAuditEvidence {
  readonly schemaVersion: typeof composerAuditSchemaVersion;
  readonly result: EvidenceResult;
  readonly findings: readonly ComposerAuditFinding[];
  readonly candidates: readonly ImprovementCandidate[];
}

export async function collectComposerAuditEvidence(
  root: string,
  runner: EvidenceRunner,
): Promise<ComposerAuditEvidence> {
  const run = await runner.run({
    identity: "composer.audit",
    command: composerAuditCommand,
    cwd: root,
    timeoutMs: 60_000,
    maxOutputBytes: 256 * 1024,
    provenance: phpEvidenceProvenance(
      ["composer", "--version"],
      ["composer.json", "composer.lock"],
    ),
    classify: classifyComposerAudit,
  });

  const findings = run.result.status === "code-finding"
    ? parseComposerAudit(run.output.stdout).findings
    : [];

  return {
    schemaVersion: composerAuditSchemaVersion,
    result: run.result,
    findings,
    candidates: findings.map(composerAuditCandidate),
  };
}

function classifyComposerAudit(output: EvidenceCommandOutput): EvidenceResultStatus {
  if (output.outputTruncated) return "infrastructure-failure";

  const error = `${output.stdout}\n${output.stderr}`;
  if (/no installed packages found|no packages\s*-\s*skipping audit|run ["']?composer install|missing required packages/i.test(error)) {
    return "missing-packages";
  }
  if (/composer\.json.*(?:invalid|not valid|does not match)|valid composer\.json and composer\.lock|could not find.*composer\.json|configuration.*(?:invalid|error)/i.test(error)) {
    return "configuration-failure";
  }

  let parsed: ParsedComposerAudit;
  try {
    parsed = parseComposerAudit(output.stdout);
  } catch {
    return "infrastructure-failure";
  }

  if (parsed.unreachableRepositories > 0) return "infrastructure-failure";
  if (parsed.findings.length > 0) return "code-finding";
  return output.exitCode === 0 ? "success" : "infrastructure-failure";
}

interface ParsedComposerAudit {
  readonly findings: readonly ComposerAuditFinding[];
  readonly unreachableRepositories: number;
}

function parseComposerAudit(output: string): ParsedComposerAudit {
  const value: unknown = JSON.parse(output);
  if (!isRecord(value)) throw new Error("Composer audit output must be a JSON object.");

  const findings: ComposerAuditFinding[] = [];
  findings.push(...parseAdvisories(value.advisories));
  findings.push(...parseAbandonedPackages(value.abandoned));
  findings.push(...parsePolicyFindings(value.filter));
  findings.push(...parseIgnoredAdvisories(value["ignored-advisories"]));

  const unreachable = value["unreachable-repositories"];
  if (unreachable !== undefined && !Array.isArray(unreachable)) {
    throw new Error("Composer audit unreachable repositories must be an array.");
  }

  return { findings, unreachableRepositories: unreachable?.length ?? 0 };
}

function parseAdvisories(value: unknown): ComposerVulnerabilityFinding[] {
  if (value === undefined || Array.isArray(value) && value.length === 0) return [];
  if (!isRecord(value)) throw new Error("Composer audit advisories must be keyed by package.");

  const findings: ComposerVulnerabilityFinding[] = [];
  for (const [packageKey, advisories] of Object.entries(value)) {
    if (!Array.isArray(advisories)) throw new Error("Composer audit package advisories must be arrays.");
    for (const advisory of advisories) {
      if (!isRecord(advisory)) throw new Error("Composer audit advisory must be an object.");
      const packageName = boundedString(advisory.packageName) ?? boundedString(packageKey);
      const advisoryId = boundedString(advisory.advisoryId);
      if (!packageName || !advisoryId) throw new Error("Composer audit advisory identity is missing.");
      const cve = boundedString(advisory.cve);
      const affectedVersions = boundedString(advisory.affectedVersions);
      const severity = boundedString(advisory.severity);
      findings.push({
        kind: "vulnerability",
        id: `composer:vulnerability:${packageName}:${advisoryId}`,
        packageName,
        advisoryId,
        ...(cve ? { cve } : {}),
        ...(affectedVersions ? { affectedVersions } : {}),
        ...(severity ? { severity } : {}),
      });
    }
  }
  return findings;
}

function parseAbandonedPackages(value: unknown): ComposerAbandonedPackageFinding[] {
  if (value === undefined || Array.isArray(value) && value.length === 0) return [];
  const packages: Array<readonly [string, unknown]> = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") packages.push([entry, undefined]);
      else if (isRecord(entry)) {
        const name = boundedString(entry.name) ?? boundedString(entry.prettyName);
        if (!name) throw new Error("Composer audit abandoned package identity is missing.");
        packages.push([name, entry.replacement ?? entry.abandoned]);
      } else throw new Error("Composer audit abandoned package is invalid.");
    }
  } else if (isRecord(value)) {
    for (const [packageKey, replacement] of Object.entries(value)) {
      const packageName = boundedString(packageKey);
      if (!packageName) throw new Error("Composer audit abandoned package identity is missing.");
      packages.push([packageName, replacement]);
    }
  } else throw new Error("Composer audit abandoned packages must be an object or array.");

  return packages.map(([packageName, replacement]) => {
    const replacementName = boundedString(replacement);
    return {
      kind: "abandoned-package",
      id: `composer:abandoned:${packageName}`,
      packageName,
      ...(replacementName ? { replacement: replacementName } : {}),
    };
  });
}

function parsePolicyFindings(value: unknown): ComposerPolicyFinding[] {
  if (value === undefined || Array.isArray(value) && value.length === 0) return [];
  if (!isRecord(value)) throw new Error("Composer audit policy findings must be keyed by package.");
  const findings: ComposerPolicyFinding[] = [];
  for (const [packageKey, entries] of Object.entries(value)) {
    const packageName = boundedString(packageKey);
    if (!packageName) throw new Error("Composer audit policy package identity is missing.");
    if (!Array.isArray(entries)) throw new Error("Composer audit policy entries must be arrays.");
    for (const entry of entries) {
      if (!isRecord(entry)) throw new Error("Composer audit policy entry must be an object.");
      const policyName = boundedString(entry.listName);
      if (!policyName) throw new Error("Composer audit policy identity is missing.");
      const policyEntryId = boundedString(entry.id);
      findings.push({
        kind: "policy",
        id: `composer:policy:${packageName}:${policyName}:${policyEntryId ?? "match"}`,
        packageName,
        policyName,
        ...(policyEntryId ? { policyEntryId } : {}),
      });
    }
  }
  return findings;
}

function parseIgnoredAdvisories(value: unknown): ComposerPolicyFinding[] {
  if (value === undefined || Array.isArray(value) && value.length === 0) return [];
  if (!isRecord(value)) throw new Error("Composer ignored advisories must be keyed by package.");
  const findings: ComposerPolicyFinding[] = [];
  for (const [packageKey, advisories] of Object.entries(value)) {
    const packageName = boundedString(packageKey);
    if (!packageName) throw new Error("Composer ignored advisory package identity is missing.");
    if (!Array.isArray(advisories)) throw new Error("Composer ignored advisories must be arrays.");
    for (const advisory of advisories) {
      if (!isRecord(advisory)) throw new Error("Composer ignored advisory must be an object.");
      const advisoryId = boundedString(advisory.advisoryId);
      if (!advisoryId) throw new Error("Composer ignored advisory identity is missing.");
      findings.push({
        kind: "policy",
        id: `composer:policy:${packageName}:ignored-advisory:${advisoryId}`,
        packageName,
        policyName: "ignored-advisory",
        policyEntryId: advisoryId,
      });
    }
  }
  return findings;
}

function composerAuditCandidate(finding: ComposerAuditFinding): ImprovementCandidate {
  if (finding.kind === "vulnerability") {
    return {
      id: finding.id,
      kind: "dependency-vulnerability",
      title: `Remediate vulnerable dependency ${finding.packageName}`,
      rationale: `${finding.packageName} is affected by Composer advisory ${finding.advisoryId}.`,
      confidence: 0.99,
      impact: 1,
      effort: 0.45,
      risk: 0.5,
      subsystemRisk: 0.65,
      testability: 0.6,
      evidence: [
        `package ${finding.packageName}; advisory ${finding.advisoryId}`,
        `affected versions ${finding.affectedVersions ?? "not reported"}; severity ${finding.severity ?? "not reported"}`,
      ],
      suggestedFiles: ["composer.json", "composer.lock"],
      target: finding.packageName,
      estimatedDiffLines: 120,
      reproducibility: reproducibleEvidence(0.99, ["composer.audit executed collector"]),
    };
  }
  if (finding.kind === "abandoned-package") {
    return {
      id: finding.id,
      kind: "maintainability",
      title: `Replace abandoned dependency ${finding.packageName}`,
      rationale: finding.replacement
        ? `Composer marks ${finding.packageName} as abandoned and recommends ${finding.replacement}.`
        : `Composer marks ${finding.packageName} as abandoned without a replacement.`,
      confidence: 0.99,
      impact: 0.75,
      effort: 0.65,
      risk: 0.55,
      subsystemRisk: 0.6,
      testability: 0.5,
      evidence: [`package ${finding.packageName}; replacement ${finding.replacement ?? "not reported"}`],
      suggestedFiles: ["composer.json", "composer.lock"],
      target: finding.packageName,
      estimatedDiffLines: 160,
      reproducibility: reproducibleEvidence(0.99, ["composer.audit executed collector"]),
    };
  }
  return {
    id: finding.id,
    kind: "maintainability",
    title: `Review dependency policy match for ${finding.packageName}`,
    rationale: `${finding.packageName} matched Composer dependency policy ${finding.policyName}.`,
    confidence: 0.99,
    impact: 0.85,
    effort: 0.4,
    risk: 0.4,
    subsystemRisk: 0.45,
    testability: 0.65,
    evidence: [`package ${finding.packageName}; policy ${finding.policyName}; entry ${finding.policyEntryId ?? "not reported"}`],
    suggestedFiles: ["composer.json", "composer.lock"],
    target: finding.packageName,
    estimatedDiffLines: 80,
    reproducibility: reproducibleEvidence(0.99, ["composer.audit executed collector"]),
  };
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 512);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
