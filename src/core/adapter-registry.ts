import type { RepositoryAdapter } from "../contracts.js";

export class AdapterRegistry {
  constructor(private readonly adapters: readonly RepositoryAdapter[]) {}

  async resolve(root: string): Promise<RepositoryAdapter> {
    const results = await Promise.all(
      this.adapters.map(async (adapter) => ({ adapter, score: await adapter.detect(root) })),
    );
    const match = results.sort((a, b) => b.score - a.score)[0];
    if (!match || match.score <= 0) {
      throw new Error(`No repository adapter recognized ${root}`);
    }
    return match.adapter;
  }
}
