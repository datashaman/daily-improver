import {
  evidenceResultSchemaVersion,
  type EvidenceCommand,
  type EvidenceResult,
} from "../src/contracts.js";

export function evidenceStubMetadata(
  command: EvidenceCommand,
): Pick<EvidenceResult, "schemaVersion" | "provenance"> {
  return {
    schemaVersion: evidenceResultSchemaVersion,
    provenance: {
      status: "success",
      versionCommand: command.provenance.versionCommand,
      toolVersion: "1.0.0",
      configurationHash: "sha256:configuration",
      configurationFiles: [],
      maxConfigurationFileBytes: command.provenance.maxConfigurationFileBytes,
    },
  };
}
