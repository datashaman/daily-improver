import type { EvidenceProvenanceRequest } from "../contracts.js";

const maxConfigurationFileBytes = 256 * 1024;

export function phpEvidenceProvenance(
  versionCommand: readonly string[],
  configurationPaths: readonly string[],
  configurationRoot?: string,
): EvidenceProvenanceRequest {
  return {
    versionCommand,
    configurationPaths,
    maxConfigurationFileBytes,
    ...(configurationRoot ? { configurationRoot } : {}),
  };
}
