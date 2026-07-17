import type { EvidenceRunner, RepositoryAdapter } from "../contracts.js";
import type {
  CapabilityKind,
  CommandCapability,
  ImprovementCandidate,
  RepositoryProfile,
} from "../domain/model.js";
import { exists, readJson } from "./shared.js";
import { collectPhpEvidence } from "./php-evidence.js";
import { collectComposerValidationEvidence } from "./composer-validation.js";
import { collectComposerAuditEvidence } from "./composer-audit.js";
import { collectPhpStaticAnalysisEvidence } from "./php-static-analysis.js";
import { BoundedEvidenceRunner } from "../infra/bounded-evidence-runner.js";

interface ComposerManifest {
  readonly require?: Readonly<Record<string, string>>;
  readonly "require-dev"?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string | readonly string[]>>;
}

type PackageMap = Readonly<Record<string, string>>;

export class PhpAdapter implements RepositoryAdapter {
  readonly id = "php";

  constructor(private readonly evidenceRunner: EvidenceRunner = new BoundedEvidenceRunner()) {}

  async detect(root: string): Promise<number> {
    return (await exists(root, "composer.json")) ? 100 : 0;
  }

  async profile(root: string): Promise<RepositoryProfile> {
    const composer = await readJson<ComposerManifest>(root, "composer.json");
    const packages = { ...composer.require, ...composer["require-dev"] };
    const frameworks = detectFrameworks(packages);
    const capabilities = await detectCapabilities(root, packages, composer.scripts ?? {});
    return {
      root,
      adapter: this.id,
      language: "php",
      frameworks,
      signals: ["composer.json", ...frameworks.map((framework) => `framework:${framework}`)],
      capabilities,
    };
  }

  async discoverCandidates(profile: RepositoryProfile): Promise<readonly ImprovementCandidate[]> {
    const composerValidation = await collectComposerValidationEvidence(profile.root, this.evidenceRunner);
    const composerAudit = await collectComposerAuditEvidence(profile.root, this.evidenceRunner);
    const staticAnalysisCapability = profile.capabilities.get("static-analysis");
    const staticAnalysis = staticAnalysisCapability
      ? await collectPhpStaticAnalysisEvidence(profile.root, staticAnalysisCapability, this.evidenceRunner)
      : undefined;
    const candidates: ImprovementCandidate[] = [
      ...composerValidation.candidates,
      ...composerAudit.candidates,
      ...(staticAnalysis?.candidates ?? []),
      ...await collectPhpEvidence(profile.root),
    ];
    if (!profile.capabilities.has("test")) {
      candidates.push(candidate("php-test-baseline", "test-protection", "Add an automated test baseline", "The repository has no detected PHPUnit or Pest test capability.", 0.95, 0.95, 0.55, 0.2, ["composer.json has no detected test runner"], ["composer.json", "tests"]));
    }
    if (!profile.capabilities.has("static-analysis")) {
      candidates.push(candidate("php-static-analysis", "static-analysis", "Introduce incremental static analysis", "Static analysis catches type and contract defects before an agent-generated patch can merge.", 0.92, 0.85, 0.4, 0.15, ["No PHPStan or Psalm capability detected"], ["composer.json", "phpstan.neon"]));
    }
    if (!profile.capabilities.has("mutation-testing")) {
      candidates.push(candidate("php-mutation-testing", "mutation-testing", "Add mutation testing for critical code", "Mutation testing measures whether the existing suite can detect meaningful behavioral changes.", 0.82, 0.72, 0.65, 0.2, ["No Infection capability detected"], ["composer.json", "infection.json5"]));
    }
    if (profile.capabilities.has("test")) {
      candidates.push(candidate("php-property-tests", "property-testing", "Add a property test around a stable domain invariant", "Property tests strengthen protection around behavior with a broad input space.", 0.68, 0.75, 0.5, 0.25, ["A PHP test runner is available"], ["tests/Property"]));
    }
    return candidates;
  }

  classifyFailure(output: string): string {
    if (/syntax error|parse error/i.test(output)) return "syntax";
    if (/failed asserting|failures?:/i.test(output)) return "test-assertion";
    if (/out of memory|allowed memory/i.test(output)) return "resource-limit";
    if (/class .* not found|autoload/i.test(output)) return "dependency-or-autoload";
    return "unknown";
  }
}

function candidate(id: string, kind: ImprovementCandidate["kind"], title: string, rationale: string, confidence: number, impact: number, effort: number, risk: number, evidence: string[], suggestedFiles: string[]): ImprovementCandidate {
  return { id, kind, title, rationale, confidence, impact, effort, risk, evidence, suggestedFiles };
}

function detectFrameworks(packages: PackageMap): string[] {
  const frameworks: string[] = [];
  if (packages["laravel/framework"]) frameworks.push("laravel");
  if (packages["symfony/framework-bundle"]) frameworks.push("symfony");
  return frameworks;
}

async function detectCapabilities(root: string, packages: PackageMap, scripts: NonNullable<ComposerManifest["scripts"]>): Promise<ReadonlyMap<CapabilityKind, CommandCapability>> {
  const capabilities = new Map<CapabilityKind, CommandCapability>();
  capabilities.set("install", command("install", ["composer", "install"], "convention"));
  if (packages["pestphp/pest"]) capabilities.set("test", command("test", ["vendor/bin/pest"], "manifest", "pest"));
  else if (packages["phpunit/phpunit"]) capabilities.set("test", command("test", ["vendor/bin/phpunit"], "manifest", "phpunit"));
  else if (scripts.test) capabilities.set("test", command("test", ["composer", "test"], "manifest"));
  if (packages["laravel/pint"]) capabilities.set("lint", command("lint", ["vendor/bin/pint", "--test"], "manifest", "pint"));
  else if (packages["friendsofphp/php-cs-fixer"]) capabilities.set("lint", command("lint", ["vendor/bin/php-cs-fixer", "check"], "manifest", "php-cs-fixer"));
  if (packages["phpstan/phpstan"] || packages["larastan/larastan"] || packages["nunomaduro/larastan"]) capabilities.set("static-analysis", command("static-analysis", ["vendor/bin/phpstan", "analyse"], "manifest", "phpstan"));
  else if (packages["vimeo/psalm"]) capabilities.set("static-analysis", command("static-analysis", ["vendor/bin/psalm"], "manifest", "psalm"));
  if (packages["infection/infection"]) capabilities.set("mutation-testing", command("mutation-testing", ["vendor/bin/infection", "--no-interaction"], "manifest", "infection"));
  if (packages["giorgiosironi/eris"]) capabilities.set("property-testing", command("property-testing", ["vendor/bin/phpunit", "tests/Property"], "manifest", "eris"));
  if (await exists(root, "phpunit.xml")) capabilities.set("coverage", command("coverage", ["vendor/bin/phpunit", "--coverage-text"], "configuration"));
  return capabilities;
}

function command(kind: CapabilityKind, args: string[], source: CommandCapability["source"], framework?: string): CommandCapability {
  return framework ? { kind, command: args, source, framework } : { kind, command: args, source };
}
