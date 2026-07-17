import type { EvidenceRunner, GeneratedTestQualityInspectionRequest, RepositoryAdapter } from "../contracts.js";
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
import { collectPhpStaticAnalysisEvidence, phpStaticAnalysisCommand, phpStaticAnalysisSchemaVersion } from "./php-static-analysis.js";
import { collectPhpCoverageEvidence, phpCoverageCommand, phpCoverageSchemaVersion } from "./php-coverage.js";
import { collectPhpMutationEvidence, phpMutationCommand, phpMutationSchemaVersion } from "./php-mutation.js";
import { collectPhpComplexityEvidence, phpComplexityCommand, phpComplexitySchemaVersion } from "./php-complexity.js";
import { collectLaravelDeprecatedApiEvidence, collectPhpDeprecatedApiEvidence } from "./php-deprecation.js";
import { collectPhpPerformanceEvidence, phpPerformanceCommand, phpPerformanceSchemaVersion } from "./php-performance.js";
import { collectPhpDuplicateCodeEvidence, phpDuplicateCodeCommand, phpDuplicateCodeSchemaVersion, phpDuplicateCodeSourceRoots } from "./php-duplicate-code.js";
import { collectPhpValidationErrorEvidence } from "./php-validation-error-handling.js";
import { BoundedEvidenceRunner } from "../infra/bounded-evidence-runner.js";
import { PhpEvidenceCache, type PhpEvidenceCachePolicy } from "../infra/php-evidence-cache.js";
import { loadConfig, type ImproverConfig } from "../config.js";
import { reproducibleEvidence } from "../domain/candidate-reproducibility.js";
import {
  inspectPestGeneratedTestQuality,
  requireAcceptedPestGeneratedTestQuality,
  type PestGeneratedTestQualityInspection,
} from "./pest-generated-test-quality.js";

interface ComposerManifest {
  readonly require?: Readonly<Record<string, string>>;
  readonly "require-dev"?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string | readonly string[]>>;
}

type PackageMap = Readonly<Record<string, string>>;

export class PhpAdapter implements RepositoryAdapter {
  readonly id = "php";

  constructor(
    private readonly evidenceRunner: EvidenceRunner = new BoundedEvidenceRunner(),
    private readonly evidenceCache: PhpEvidenceCache = new PhpEvidenceCache(),
  ) {}

  async detect(root: string): Promise<number> {
    return (await exists(root, "composer.json")) ? 100 : 0;
  }

  async profile(root: string): Promise<RepositoryProfile> {
    const composer = await readJson<ComposerManifest>(root, "composer.json");
    const config = await loadConfig(root);
    const packages = { ...composer.require, ...composer["require-dev"] };
    const frameworks = detectFrameworks(packages);
    const capabilities = detectCapabilities(
      packages,
      composer.scripts ?? {},
      config.analysis.php.complexity_tool,
      config.analysis.php.duplicate_code_tool,
    );
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
    const config = await loadConfig(profile.root);
    const composerValidation = await collectComposerValidationEvidence(profile.root, this.evidenceRunner);
    const composerAudit = await collectComposerAuditEvidence(profile.root, this.evidenceRunner);
    const staticAnalysisCapability = profile.capabilities.get("static-analysis");
    const staticAnalysis = staticAnalysisCapability
      ? await this.evidenceCache.collect(
        profile.root,
        staticAnalysisCachePolicy(staticAnalysisCapability),
        () => collectPhpStaticAnalysisEvidence(profile.root, staticAnalysisCapability, this.evidenceRunner),
      )
      : undefined;
    const coverageCapability = profile.capabilities.get("coverage");
    const coverage = coverageCapability
      ? await this.evidenceCache.collect(
        profile.root,
        coverageCachePolicy(coverageCapability),
        () => collectPhpCoverageEvidence(profile.root, coverageCapability, this.evidenceRunner),
      )
      : undefined;
    const mutationCapability = profile.capabilities.get("mutation-testing");
    const mutation = mutationCapability
      ? await this.evidenceCache.collect(
        profile.root,
        await mutationCachePolicy(profile.root),
        () => collectPhpMutationEvidence(profile.root, mutationCapability, this.evidenceRunner),
      )
      : undefined;
    const complexityCapability = profile.capabilities.get("complexity");
    const complexity = complexityCapability
      ? await this.evidenceCache.collect(
        profile.root,
        complexityCachePolicy,
        () => collectPhpComplexityEvidence(profile.root, complexityCapability, this.evidenceRunner),
      )
      : undefined;
    const duplicateCodeCapability = profile.capabilities.get("duplicate-code");
    const duplicateCode = duplicateCodeCapability
      ? await this.evidenceCache.collect(
        profile.root,
        await duplicateCodeCachePolicy(profile.root),
        () => collectPhpDuplicateCodeEvidence(profile.root, duplicateCodeCapability, this.evidenceRunner),
      )
      : undefined;
    const deprecationCapability = profile.capabilities.get("deprecation-analysis");
    const phpDeprecations = deprecationCapability
      ? await collectPhpDeprecatedApiEvidence(profile.root, deprecationCapability, this.evidenceRunner)
      : undefined;
    const laravelDeprecations = profile.frameworks.includes("laravel")
      ? await collectLaravelDeprecatedApiEvidence(profile.root)
      : undefined;
    const testCapability = profile.capabilities.get("test");
    const performance = testCapability?.framework === "phpunit" || testCapability?.framework === "pest"
      ? await this.evidenceCache.collect(
        profile.root,
        performanceCachePolicy(testCapability),
        () => collectPhpPerformanceEvidence(
          profile.root,
          testCapability,
          config.analysis.php,
          profile.frameworks.includes("laravel"),
          this.evidenceRunner,
        ),
      )
      : undefined;
    const validationErrorHandling = profile.frameworks.includes("laravel")
      ? await collectPhpValidationErrorEvidence(profile.root)
      : undefined;
    const candidates: ImprovementCandidate[] = [
      ...composerValidation.candidates,
      ...composerAudit.candidates,
      ...(staticAnalysis?.candidates ?? []),
      ...(coverage?.candidates ?? []),
      ...(mutation?.candidates ?? []),
      ...(complexity?.candidates ?? []),
      ...(duplicateCode?.candidates ?? []),
      ...(phpDeprecations?.candidates ?? []),
      ...(laravelDeprecations?.candidates ?? []),
      ...(performance?.candidates ?? []),
      ...(validationErrorHandling?.candidates ?? []),
      ...await collectPhpEvidence(profile.root, {
        includePreparedCoverage: coverageCapability === undefined,
        includePreparedMutation: mutationCapability === undefined,
        includePreparedComplexity: complexityCapability === undefined,
      }),
    ];
    if (!profile.capabilities.has("test")) {
      candidates.push(candidate("php-test-baseline", "test-protection", "Add an automated test baseline", "The repository has no detected PHPUnit or Pest test capability.", 0.95, 0.95, 0.55, 0.2, 0.2, 0.8, 120, ["composer.json has no detected test runner"], ["composer.json", "tests"]));
    }
    if (!profile.capabilities.has("static-analysis")) {
      candidates.push(candidate("php-static-analysis", "static-analysis", "Introduce incremental static analysis", "Static analysis catches type and contract defects before an agent-generated patch can merge.", 0.92, 0.85, 0.4, 0.15, 0.2, 0.85, 100, ["No PHPStan or Psalm capability detected"], ["composer.json", "phpstan.neon"]));
    }
    if (!profile.capabilities.has("mutation-testing")) {
      candidates.push(candidate("php-mutation-testing", "mutation-testing", "Add mutation testing for critical code", "Mutation testing measures whether the existing suite can detect meaningful behavioral changes.", 0.82, 0.72, 0.65, 0.2, 0.25, 0.8, 120, ["No Infection capability detected"], ["composer.json", "infection.json5"]));
    }
    if (profile.capabilities.has("test")) {
      candidates.push(candidate("php-property-tests", "property-testing", "Add a property test around a stable domain invariant", "Property tests strengthen protection around behavior with a broad input space.", 0.68, 0.75, 0.5, 0.25, 0.2, 0.95, 80, ["A PHP test runner is available"], ["tests/Property"]));
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

  async inspectGeneratedTestQuality(request: GeneratedTestQualityInspectionRequest): Promise<PestGeneratedTestQualityInspection | undefined> {
    if (request.framework !== "pest") return undefined;
    const inspection = await inspectPestGeneratedTestQuality(request);
    requireAcceptedPestGeneratedTestQuality(inspection);
    return inspection;
  }
}

function candidate(id: string, kind: ImprovementCandidate["kind"], title: string, rationale: string, confidence: number, impact: number, effort: number, risk: number, subsystemRisk: number, testability: number, estimatedDiffLines: number, evidence: string[], suggestedFiles: string[]): ImprovementCandidate {
  return {
    id,
    kind,
    title,
    rationale,
    confidence,
    impact,
    effort,
    risk,
    subsystemRisk,
    testability,
    estimatedDiffLines,
    evidence,
    suggestedFiles,
    reproducibility: reproducibleEvidence(0.9, ["PHP manifest capability inspection"]),
  };
}

function detectFrameworks(packages: PackageMap): string[] {
  const frameworks: string[] = [];
  if (packages["laravel/framework"]) frameworks.push("laravel");
  if (packages["symfony/framework-bundle"]) frameworks.push("symfony");
  return frameworks;
}

function detectCapabilities(
  packages: PackageMap,
  scripts: NonNullable<ComposerManifest["scripts"]>,
  configuredComplexityTool: ImproverConfig["analysis"]["php"]["complexity_tool"],
  configuredDuplicateCodeTool: ImproverConfig["analysis"]["php"]["duplicate_code_tool"],
): ReadonlyMap<CapabilityKind, CommandCapability> {
  const capabilities = new Map<CapabilityKind, CommandCapability>();
  capabilities.set("install", command("install", ["composer", "install"], "convention"));
  if (packages["pestphp/pest"]) {
    capabilities.set("test", command("test", ["vendor/bin/pest"], "manifest", "pest"));
    capabilities.set("coverage", command("coverage", ["vendor/bin/pest"], "manifest", "pest"));
  } else if (packages["phpunit/phpunit"]) {
    capabilities.set("test", command("test", ["vendor/bin/phpunit"], "manifest", "phpunit"));
    capabilities.set("coverage", command("coverage", ["vendor/bin/phpunit"], "manifest", "phpunit"));
  }
  else if (scripts.test) capabilities.set("test", command("test", ["composer", "test"], "manifest"));
  if (packages["laravel/pint"]) capabilities.set("lint", command("lint", ["vendor/bin/pint", "--test"], "manifest", "pint"));
  else if (packages["friendsofphp/php-cs-fixer"]) capabilities.set("lint", command("lint", ["vendor/bin/php-cs-fixer", "check"], "manifest", "php-cs-fixer"));
  if (packages["phpstan/phpstan"] || packages["larastan/larastan"] || packages["nunomaduro/larastan"]) capabilities.set("static-analysis", command("static-analysis", ["vendor/bin/phpstan", "analyse"], "manifest", "phpstan"));
  else if (packages["vimeo/psalm"]) capabilities.set("static-analysis", command("static-analysis", ["vendor/bin/psalm"], "manifest", "psalm"));
  if (packages["infection/infection"]) capabilities.set("mutation-testing", command("mutation-testing", ["vendor/bin/infection", "--no-interaction"], "manifest", "infection"));
  if (packages["phpcompatibility/php-compatibility"]) capabilities.set("deprecation-analysis", command("deprecation-analysis", ["vendor/bin/phpcs"], "manifest", "phpcompatibility"));
  if (configuredComplexityTool === "phpmetrics") {
    capabilities.set("complexity", command("complexity", ["vendor/bin/phpmetrics"], "configuration", "phpmetrics"));
  } else if (configuredComplexityTool === "auto" && packages["phpmetrics/phpmetrics"]) {
    capabilities.set("complexity", command("complexity", ["vendor/bin/phpmetrics"], "manifest", "phpmetrics"));
  }
  if (configuredDuplicateCodeTool === "phpcpd") {
    capabilities.set("duplicate-code", command("duplicate-code", ["vendor/bin/phpcpd"], "configuration", "phpcpd"));
  } else if (configuredDuplicateCodeTool === "auto" && packages["sebastian/phpcpd"]) {
    capabilities.set("duplicate-code", command("duplicate-code", ["vendor/bin/phpcpd"], "manifest", "phpcpd"));
  }
  if (packages["giorgiosironi/eris"]) capabilities.set("property-testing", command("property-testing", ["vendor/bin/phpunit", "tests/Property"], "manifest", "eris"));
  return capabilities;
}

function command(kind: CapabilityKind, args: string[], source: CommandCapability["source"], framework?: string): CommandCapability {
  return framework ? { kind, command: args, source, framework } : { kind, command: args, source };
}

const phpSourcePatterns = ["composer.json", "composer.lock", "**/*.php"];

function staticAnalysisCachePolicy(capability: CommandCapability): PhpEvidenceCachePolicy {
  const tool = capability.framework === "psalm" ? "psalm" : "phpstan";
  return {
    collector: `static-analysis-${tool}`,
    policyVersion: "php-static-analysis-policy/v1",
    evidenceSchemaVersion: phpStaticAnalysisSchemaVersion,
    command: phpStaticAnalysisCommand(tool),
    versionCommand: [`vendor/bin/${tool}`, "--version"],
    configurationPaths: tool === "phpstan"
      ? ["phpstan.neon", "phpstan.neon.dist"]
      : ["psalm.xml", "psalm.xml.dist"],
    sourcePatterns: phpSourcePatterns,
  };
}

function coverageCachePolicy(capability: CommandCapability): PhpEvidenceCachePolicy {
  const tool = capability.framework === "pest" ? "pest" : "phpunit";
  return {
    collector: `coverage-${tool}`,
    policyVersion: "php-coverage-policy/v1",
    evidenceSchemaVersion: phpCoverageSchemaVersion,
    command: phpCoverageCommand(tool, "$TRUSTED_CLOVER_PATH"),
    versionCommand: [`vendor/bin/${tool}`, "--version"],
    configurationPaths: tool === "pest"
      ? ["phpunit.xml", "phpunit.xml.dist", "tests/Pest.php"]
      : ["phpunit.xml", "phpunit.xml.dist"],
    sourcePatterns: phpSourcePatterns,
  };
}

function performanceCachePolicy(capability: CommandCapability): PhpEvidenceCachePolicy {
  const tool = capability.framework === "pest" ? "pest" : "phpunit";
  return {
    collector: `performance-${tool}`,
    policyVersion: "php-performance-policy/v1",
    evidenceSchemaVersion: phpPerformanceSchemaVersion,
    command: phpPerformanceCommand(tool, "$TRUSTED_JUNIT_PATH"),
    versionCommand: [`vendor/bin/${tool}`, "--version"],
    configurationPaths: tool === "pest"
      ? [".ai/improver.yml", "phpunit.xml", "phpunit.xml.dist", "tests/Pest.php"]
      : [".ai/improver.yml", "phpunit.xml", "phpunit.xml.dist"],
    sourcePatterns: phpSourcePatterns,
  };
}

async function mutationCachePolicy(root: string): Promise<PhpEvidenceCachePolicy> {
  const configNames = ["infection.json5", "infection.json", "infection.json5.dist", "infection.json.dist"];
  const selectedIndex = await firstExistingIndex(root, configNames);
  return {
    collector: "mutation-infection",
    policyVersion: "php-mutation-policy/v1",
    evidenceSchemaVersion: phpMutationSchemaVersion,
    command: phpMutationCommand("$TRUSTED_INFECTION_CONFIG"),
    versionCommand: ["vendor/bin/infection", "--version"],
    configurationPaths: configNames.slice(0, selectedIndex + 1),
    sourcePatterns: phpSourcePatterns,
  };
}

const complexityCachePolicy: PhpEvidenceCachePolicy = {
  collector: "complexity-phpmetrics",
  policyVersion: "php-complexity-policy/v1",
  evidenceSchemaVersion: phpComplexitySchemaVersion,
  command: phpComplexityCommand("$TRUSTED_REPORT_PATH"),
  versionCommand: ["vendor/bin/phpmetrics", "--version"],
  configurationPaths: [".ai/improver.yml"],
  sourcePatterns: ["composer.json", "composer.lock", "app/Domain/**/*.php", "src/**/*.php"],
};

async function duplicateCodeCachePolicy(root: string): Promise<PhpEvidenceCachePolicy> {
  const sourceRoots = await phpDuplicateCodeSourceRoots(root);
  return {
    collector: "duplicate-code-phpcpd",
    policyVersion: "php-duplicate-code-policy/v1",
    evidenceSchemaVersion: phpDuplicateCodeSchemaVersion,
    command: phpDuplicateCodeCommand("$TRUSTED_PHPCPD_REPORT_PATH", sourceRoots.length > 0 ? sourceRoots : ["app", "src"]),
    versionCommand: ["vendor/bin/phpcpd", "--version"],
    configurationPaths: [".ai/improver.yml"],
    sourcePatterns: ["composer.json", "composer.lock", "app/**/*.php", "src/**/*.php"],
  };
}

async function firstExistingIndex(root: string, paths: readonly string[]): Promise<number> {
  for (const [index, path] of paths.entries()) {
    if (await exists(root, path)) return index;
  }
  return paths.length - 1;
}
