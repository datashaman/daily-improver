import type { Policy, PolicyContext } from "../contracts.js";
import type { ImprovementSpec, PolicyDecision } from "../domain/model.js";

export class DiffLimitPolicy implements Policy {
  readonly id = "diff-limits";

  evaluate(spec: ImprovementSpec, context: PolicyContext): PolicyDecision {
    const allowed =
      context.estimatedFiles <= spec.constraints.maxFiles &&
      context.estimatedChangedLines <= spec.constraints.maxChangedLines;
    return {
      policy: this.id,
      allowed,
      reason: allowed
        ? "Estimated diff is within file and line limits."
        : `Estimated diff (${context.estimatedFiles} files, ${context.estimatedChangedLines} lines) exceeds limits.`,
    };
  }
}

export class CostBudgetPolicy implements Policy {
  readonly id = "cost-budget";

  evaluate(spec: ImprovementSpec, context: PolicyContext): PolicyDecision {
    const allowed = context.estimatedCostUsd <= spec.constraints.maxCostUsd;
    return {
      policy: this.id,
      allowed,
      reason: allowed
        ? "Estimated cost is within budget."
        : `Estimated cost $${context.estimatedCostUsd.toFixed(2)} exceeds $${spec.constraints.maxCostUsd.toFixed(2)}.`,
    };
  }
}

export class TestProtectionPolicy implements Policy {
  readonly id = "test-protection";

  evaluate(spec: ImprovementSpec, context: PolicyContext): PolicyDecision {
    const required = spec.verification.includes("test");
    const allowed = !required || context.availableCapabilities.has("test");
    return {
      policy: this.id,
      allowed,
      reason: allowed ? "Test protection is available." : "The spec requires tests, but no test capability exists.",
    };
  }
}

export function evaluatePolicies(
  policies: readonly Policy[],
  spec: ImprovementSpec,
  context: PolicyContext,
): readonly PolicyDecision[] {
  return policies.map((policy) => policy.evaluate(spec, context));
}
