#!/usr/bin/env node
import { resolve } from "node:path";
import { createApplication } from "./app.js";
import { CommandAgentProvider } from "./agents/command-agent-provider.js";
import { LocalImprovementRunner } from "./core/local-runner.js";

async function main(): Promise<void> {
  const [command = "help", path = "."] = process.argv.slice(2);
  const root = resolve(path);
  const app = createApplication();

  if (command === "inspect") {
    const adapter = await app.registry.resolve(root);
    const profile = await adapter.profile(root);
    const capabilities = Object.fromEntries(
      [...profile.capabilities].map(([kind, capability]) => [kind, capability]),
    );
    console.log(JSON.stringify({ ...profile, capabilities }, null, 2));
    return;
  }
  if (command === "plan") {
    const run = await app.pipeline.plan(root);
    console.log(JSON.stringify(run, null, 2));
    if (run.status === "rejected") process.exitCode = 2;
    return;
  }
  if (command === "analyse") return print(await app.stages.analyse(root));
  if (command === "specify") return print(await app.stages.specify(root));
  if (command === "test") return print(await app.stages.protectTests(root));
  if (command === "build") return print(await app.stages.build(root));
  if (command === "verify") return print(await app.stages.verify(root));
  if (command === "publish") return print(await app.stages.publicationRequest(root));
  if (command === "run") {
    const testCommand = requiredEnvironment("DAILY_IMPROVER_TEST_AGENT_COMMAND");
    const buildCommand = requiredEnvironment("DAILY_IMPROVER_BUILDER_COMMAND");
    const manifestKey = requiredEnvironment("DAILY_IMPROVER_MANIFEST_KEY");
    const agents = new CommandAgentProvider({ testCommand, buildCommand });
    return print(await new LocalImprovementRunner(
      app.stages,
      agents,
      resolve(".daily-improver", "worktrees"),
      manifestKey,
    ).run(root));
  }
  if (command === "history") {
    console.log(JSON.stringify(await app.store.list(root), null, 2));
    return;
  }
  console.log(`daily-improver\n\nUsage:\n  daily-improver inspect [repository]\n  daily-improver plan [repository]\n  daily-improver run [repository]\n  daily-improver analyse [repository]\n  daily-improver specify [repository]\n  daily-improver test [repository]\n  daily-improver build [repository]\n  daily-improver verify [repository]\n  daily-improver publish [repository]\n  daily-improver history [repository]`);
}

function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function requiredEnvironment(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required.`); return value; }

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
