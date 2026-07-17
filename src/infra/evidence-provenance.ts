import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import type {
  EvidenceConfigurationFile,
  EvidenceProvenanceRequest,
} from "../contracts.js";

export interface ConfigurationProvenance {
  readonly hash: string | null;
  readonly files: readonly EvidenceConfigurationFile[];
  readonly failed: boolean;
}

export async function hashEvidenceConfiguration(
  root: string,
  request: EvidenceProvenanceRequest,
): Promise<ConfigurationProvenance> {
  if (request.maxConfigurationFileBytes <= 0) {
    throw new Error("Evidence configuration file limit must be positive.");
  }

  const paths = [...new Set(request.configurationPaths)].sort();
  const files: EvidenceConfigurationFile[] = [];
  for (const path of paths) {
    if (!isSafeRelativePath(path)) {
      files.push({ path, status: "unreadable", bytes: null, sha256: null });
      continue;
    }
    files.push(await hashFile(join(root, path), path, request.maxConfigurationFileBytes));
  }

  const failed = files.some((file) => file.status === "unreadable" || file.status === "oversized");
  return {
    hash: failed ? null : sha256(JSON.stringify(files)),
    files,
    failed,
  };
}

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false;
  const normalized = normalize(path);
  return normalized !== ".." && !normalized.startsWith(`..${sep}`);
}

async function hashFile(
  absolutePath: string,
  relativePath: string,
  limit: number,
): Promise<EvidenceConfigurationFile> {
  try {
    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return { path: relativePath, status: "unreadable", bytes: stats.size, sha256: null };
      }
      if (stats.size > limit) {
        return { path: relativePath, status: "oversized", bytes: stats.size, sha256: null };
      }
      const content = Buffer.alloc(limit + 1);
      let bytes = 0;
      while (bytes < content.length) {
        const read = await handle.read(content, bytes, content.length - bytes, bytes);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
      }
      if (bytes > limit) {
        return { path: relativePath, status: "oversized", bytes, sha256: null };
      }
      return {
        path: relativePath,
        status: "hashed",
        bytes,
        sha256: sha256(content.subarray(0, bytes)),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: relativePath, status: "absent", bytes: null, sha256: null };
    }
    return { path: relativePath, status: "unreadable", bytes: null, sha256: null };
  }
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
