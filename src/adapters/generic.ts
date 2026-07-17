import type { RepositoryAdapter } from "../contracts.js";
import type { ImprovementCandidate, RepositoryProfile } from "../domain/model.js";
import { exists } from "./shared.js";

const signals = [".git", "README.md", "Makefile"];

export class GenericAdapter implements RepositoryAdapter {
  readonly id = "generic";

  async detect(root: string): Promise<number> {
    const matches = await Promise.all(signals.map((signal) => exists(root, signal)));
    return matches.filter(Boolean).length ? 1 : 0;
  }

  async profile(root: string): Promise<RepositoryProfile> {
    const found = (await Promise.all(signals.map(async (s) => ((await exists(root, s)) ? s : undefined)))).filter(
      (value): value is string => Boolean(value),
    );
    return { root, adapter: this.id, language: "unknown", frameworks: [], signals: found, capabilities: new Map() };
  }

  async discoverCandidates(): Promise<readonly ImprovementCandidate[]> {
    return [
      {
        id: "generic-documentation-baseline",
        kind: "documentation",
        title: "Establish repository operating documentation",
        rationale: "Document the repository's install, test, and contribution workflow before automating changes.",
        confidence: 0.75,
        impact: 0.55,
        effort: 0.2,
        risk: 0.05,
        evidence: ["No language-specific repository adapter matched."],
        suggestedFiles: ["README.md"],
      },
    ];
  }
}
