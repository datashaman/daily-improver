export const candidateValueClassificationSchemaVersion = "candidate-value-classification/v1" as const;

export type CandidateValueClassificationKind = "substantive" | "cosmetic-only";

export interface CandidateValueClassification {
  readonly schemaVersion: typeof candidateValueClassificationSchemaVersion;
  readonly classification: CandidateValueClassificationKind;
}

export function isCandidateValueClassification(value: unknown): value is CandidateValueClassification {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 2
    && keys[0] === "classification"
    && keys[1] === "schemaVersion"
    && record.schemaVersion === candidateValueClassificationSchemaVersion
    && (record.classification === "substantive" || record.classification === "cosmetic-only");
}
