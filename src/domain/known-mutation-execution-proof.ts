import { createHash } from "node:crypto";

export const knownMutationSchemaVersion = "known-mutation/v1" as const;
export const knownMutationExecutionProofSchemaVersion = "known-mutation-execution-proof/v1" as const;

export interface KnownMutationRequirement {
  readonly schemaVersion: typeof knownMutationSchemaVersion;
  readonly id: string;
  readonly target: string;
  readonly operator: string;
  readonly executionMode: "baseline-known-mutant";
  readonly criterion: {
    readonly kind: "property-invariant" | "acceptance-criterion";
    readonly statement: string;
  };
}

export interface KnownMutationExecutionProof {
  readonly schemaVersion: typeof knownMutationExecutionProofSchemaVersion;
  readonly mutationId: string;
  readonly executionMode: "baseline-known-mutant";
  readonly testPath: string;
  readonly target: string;
  readonly criterion: KnownMutationRequirement["criterion"];
  readonly command: readonly string[];
  readonly outcome: {
    readonly status: "failed-as-required";
    readonly exitCode: number;
    readonly classification: string;
    readonly durationMs: number;
    readonly stdoutSha256: string;
    readonly stderrSha256: string;
  };
}

export interface KnownMutationProofExpectation {
  readonly requirement: KnownMutationRequirement;
  readonly approvedPropertyInvariants: readonly string[];
  readonly approvedAcceptanceCriteria: readonly string[];
  readonly changedTestPaths: readonly string[];
  readonly relevantTestPath: string;
  readonly command: readonly string[];
}

export interface KnownMutationCommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly classification: string;
}

const safePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\x20-\x7e]+$/;
const digestPattern = /^[a-f0-9]{64}$/;

export function assertKnownMutationRequirement(
  value: unknown,
  approvedPropertyInvariants: readonly string[],
  approvedAcceptanceCriteria: readonly string[],
  selectedTarget?: string,
): KnownMutationRequirement {
  const mutation = exactRecord(value, ["schemaVersion", "id", "target", "operator", "executionMode", "criterion"], "Known mutation");
  if (mutation.schemaVersion !== knownMutationSchemaVersion) throw new Error(`Known mutation must use ${knownMutationSchemaVersion}.`);
  const id = boundedString(mutation.id, "id", 256);
  const target = boundedString(mutation.target, "target", 1_024);
  if (!safePathPattern.test(target) || target !== selectedTarget) throw new Error("Known mutation must target the selected production file.");
  const operator = boundedString(mutation.operator, "operator", 256);
  if (mutation.executionMode !== "baseline-known-mutant") throw new Error("Known mutation execution mode is unsupported.");
  const criterion = exactRecord(mutation.criterion, ["kind", "statement"], "Known mutation criterion");
  if (criterion.kind !== "property-invariant" && criterion.kind !== "acceptance-criterion") {
    throw new Error("Known mutation criterion kind is unsupported.");
  }
  const statement = boundedString(criterion.statement, "criterion statement", 4_096);
  const approved = criterion.kind === "property-invariant" ? approvedPropertyInvariants : approvedAcceptanceCriteria;
  if (!approved.includes(statement)) throw new Error("Known mutation criterion is not approved by the specification.");
  return {
    schemaVersion: knownMutationSchemaVersion,
    id,
    target,
    operator,
    executionMode: "baseline-known-mutant",
    criterion: { kind: criterion.kind, statement },
  };
}

export function createKnownMutationExecutionProof(
  outcome: KnownMutationCommandOutcome,
  expectation: KnownMutationProofExpectation,
): KnownMutationExecutionProof {
  if (!Number.isInteger(outcome.exitCode) || outcome.exitCode < 1 || outcome.exitCode > 255) {
    throw new Error("Known mutation survived the relevant generated test.");
  }
  if (!Number.isFinite(outcome.durationMs) || outcome.durationMs < 0 || outcome.durationMs > 3_600_000) {
    throw new Error("Known mutation execution duration is malformed.");
  }
  const classification = boundedString(outcome.classification, "failure classification", 256);
  if (["syntax", "resource-limit", "dependency-or-autoload", "unknown", "unclassified"].includes(classification)) {
    throw new Error(`Known mutation test failed for a non-behavioral reason: ${classification}.`);
  }
  return assertKnownMutationExecutionProof({
    schemaVersion: knownMutationExecutionProofSchemaVersion,
    mutationId: expectation.requirement.id,
    executionMode: expectation.requirement.executionMode,
    testPath: expectation.relevantTestPath,
    target: expectation.requirement.target,
    criterion: expectation.requirement.criterion,
    command: expectation.command,
    outcome: {
      status: "failed-as-required",
      exitCode: outcome.exitCode,
      classification,
      durationMs: outcome.durationMs,
      stdoutSha256: createHash("sha256").update(outcome.stdout).digest("hex"),
      stderrSha256: createHash("sha256").update(outcome.stderr).digest("hex"),
    },
  }, expectation);
}

export function assertKnownMutationExecutionProof(
  value: unknown,
  expectation: KnownMutationProofExpectation,
): KnownMutationExecutionProof {
  const requirement = assertKnownMutationRequirement(
    expectation.requirement,
    expectation.approvedPropertyInvariants,
    expectation.approvedAcceptanceCriteria,
    expectation.requirement.target,
  );
  const proof = exactRecord(value, ["schemaVersion", "mutationId", "executionMode", "testPath", "target", "criterion", "command", "outcome"], "Known-mutation execution proof");
  if (proof.schemaVersion !== knownMutationExecutionProofSchemaVersion) {
    throw new Error(`Known-mutation execution proof must use ${knownMutationExecutionProofSchemaVersion}.`);
  }
  if (proof.mutationId !== requirement.id || proof.executionMode !== requirement.executionMode) {
    throw new Error("Known-mutation execution proof identifies the wrong mutation.");
  }
  const testPath = boundedString(proof.testPath, "test path", 1_024);
  if (!safePathPattern.test(testPath) || testPath !== expectation.relevantTestPath || !expectation.changedTestPaths.includes(testPath)) {
    throw new Error("Known-mutation execution proof identifies the wrong generated test.");
  }
  if (proof.target !== requirement.target) throw new Error("Known-mutation execution proof identifies the wrong target.");
  const criterion = exactRecord(proof.criterion, ["kind", "statement"], "Known-mutation execution criterion");
  if (criterion.kind !== requirement.criterion.kind || criterion.statement !== requirement.criterion.statement) {
    throw new Error("Known-mutation execution proof identifies the wrong approved criterion.");
  }
  if (!Array.isArray(proof.command) || proof.command.length === 0 || proof.command.length > 32
    || proof.command.some((argument) => typeof argument !== "string" || argument.length > 1_024)
    || JSON.stringify(proof.command) !== JSON.stringify(expectation.command)) {
    throw new Error("Known-mutation execution proof records the wrong test command.");
  }
  const outcome = exactRecord(proof.outcome, ["status", "exitCode", "classification", "durationMs", "stdoutSha256", "stderrSha256"], "Known-mutation execution outcome");
  if (outcome.status !== "failed-as-required" || !Number.isInteger(outcome.exitCode) || (outcome.exitCode as number) < 1 || (outcome.exitCode as number) > 255) {
    throw new Error("Known mutation survived the relevant generated test.");
  }
  const classification = boundedString(outcome.classification, "failure classification", 256);
  if (["syntax", "resource-limit", "dependency-or-autoload", "unknown", "unclassified"].includes(classification)) {
    throw new Error(`Known mutation test failed for a non-behavioral reason: ${classification}.`);
  }
  if (!Number.isFinite(outcome.durationMs) || (outcome.durationMs as number) < 0 || (outcome.durationMs as number) > 3_600_000) {
    throw new Error("Known-mutation execution duration is malformed.");
  }
  if (typeof outcome.stdoutSha256 !== "string" || !digestPattern.test(outcome.stdoutSha256)
    || typeof outcome.stderrSha256 !== "string" || !digestPattern.test(outcome.stderrSha256)) {
    throw new Error("Known-mutation execution output hashes are malformed.");
  }
  return {
    schemaVersion: knownMutationExecutionProofSchemaVersion,
    mutationId: requirement.id,
    executionMode: requirement.executionMode,
    testPath,
    target: requirement.target,
    criterion: requirement.criterion,
    command: proof.command as readonly string[],
    outcome: {
      status: "failed-as-required",
      exitCode: outcome.exitCode as number,
      classification,
      durationMs: outcome.durationMs as number,
      stdoutSha256: outcome.stdoutSha256,
      stderrSha256: outcome.stderrSha256,
    },
  };
}

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an exact object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${name} must have an exact schema.`);
  return record;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) throw new Error(`Known mutation ${name} is malformed.`);
  return value;
}
