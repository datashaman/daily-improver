import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DailyImprovementStore } from "../src/contracts.js";
import { authorizePublication } from "../src/core/publication-authorization.js";
import { AdapterRegistry } from "../src/core/adapter-registry.js";
import { PipelineStages } from "../src/core/stages.js";
import type { DailyImprovementDecision } from "../src/domain/model.js";
import { CommandRunner, type CommandResult } from "../src/infra/command-runner.js";

test("authorizes publication only while trusted main remains at the verified commit", async () => {
  const fixture = await createRepository();
  const decidedAt = "2026-07-18T10:30:00.000Z";
  const authorization = await authorizePublication(
    fixture.repository,
    "main",
    verification(fixture.head),
    decidedAt,
    fixture.runner,
  );
  assert.deepEqual(authorization, {
    schemaVersion: "publication-authorization/v1",
    expectedBaseSha: fixture.head,
    checkedMainSha: fixture.head,
    verifierInputsSha256: "a".repeat(64),
    outcome: "authorized",
    decidedAt,
  });
  assert.doesNotMatch(JSON.stringify(authorization), new RegExp(fixture.repository));

  await writeFile(join(fixture.repository, "advanced.txt"), "advanced\n");
  await git(fixture.runner, fixture.repository, ["add", "advanced.txt"]);
  await git(fixture.runner, fixture.repository, ["commit", "-m", "advance main"]);
  await assert.rejects(
    authorizePublication(fixture.repository, "main", verification(fixture.head), decidedAt, fixture.runner),
    /no longer matches/,
  );
});

test("rejects missing, rewound, non-commit, and ambiguously resolved main state", async () => {
  const rewound = await createRepository();
  await writeFile(join(rewound.repository, "next.txt"), "next\n");
  await git(rewound.runner, rewound.repository, ["add", "next.txt"]);
  await git(rewound.runner, rewound.repository, ["commit", "-m", "next"]);
  const advanced = (await rewound.runner.run(["git", "rev-parse", "HEAD"], rewound.repository)).stdout.trim();
  await git(rewound.runner, rewound.repository, ["branch", "verified-tip", advanced]);
  await git(rewound.runner, rewound.repository, ["checkout", "verified-tip"]);
  await git(rewound.runner, rewound.repository, ["branch", "-f", "main", rewound.head]);
  await git(rewound.runner, rewound.repository, ["checkout", "main"]);
  await assert.rejects(
    authorizePublication(rewound.repository, "main", verification(advanced), timestamp, rewound.runner),
    /no longer matches/,
  );

  await assert.rejects(
    authorizePublication(rewound.repository, "refs/heads/absent", verification(rewound.head), timestamp, rewound.runner),
    /one unambiguous commit/,
  );
  const blob = (await rewound.runner.run(["git", "hash-object", "README.md"], rewound.repository)).stdout.trim();
  await git(rewound.runner, rewound.repository, ["tag", "blob-main", blob]);
  await assert.rejects(
    authorizePublication(rewound.repository, "blob-main", verification(rewound.head), timestamp, rewound.runner),
    /one unambiguous commit/,
  );
  await assert.rejects(
    authorizePublication(
      rewound.repository,
      "main",
      verification(rewound.head),
      timestamp,
      new AmbiguousMainRunner(rewound.head),
    ),
    /one unambiguous commit/,
  );
});

test("main advancement blocks the daily claim completion and publication artifacts", async () => {
  const fixture = await createRepository();
  const runRoot = join(fixture.repository, ".ai", "runs", "2026-07-18");
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(fixture.repository, ".ai", "improver.yml"), [
    "version: 1",
    "schedule:",
    "  timezone: Africa/Johannesburg",
    "  time: '05:00'",
    "limits:",
    "  max_changed_files: 1",
    "  max_diff_lines: 10",
    "  max_cost_usd: 1",
    "  max_open_prs: 1",
    "verification:",
    "  commands: []",
    "  mutation_testing: targeted",
    "pull_request:",
    "  draft: true",
    "  labels: [daily-improver]",
    "protected_paths: [tests/**]",
    "selection:",
    "  priorities: []",
    "",
  ].join("\n"));
  await writeFile(join(runRoot, "spec.json"), JSON.stringify({
    id: "bounded-fix",
    title: "Bounded fix",
    objective: "Correct one bounded behavior.",
    evidence: ["verified evidence"],
    constraints: { maxFiles: 1, maxChangedLines: 10, maxCostUsd: 1 },
  }));
  await writeFile(join(runRoot, "verification.json"), JSON.stringify({
    ...verification(fixture.head),
    checks: [],
  }));
  const claim: DailyImprovementDecision = {
    schemaVersion: "daily-improvement-decision/v1",
    repositoryId: "b".repeat(64),
    utcDate: "2026-07-18",
    claimId: "claim-1",
    outcome: "claimed",
    decidedAt: timestamp,
  };
  await writeFile(join(runRoot, "daily-improvement-decision.json"), JSON.stringify(claim));
  await writeFile(join(fixture.repository, "advanced.txt"), "advanced\n");
  await git(fixture.runner, fixture.repository, ["add", "."]);
  await git(fixture.runner, fixture.repository, ["commit", "-m", "advance after verification"]);

  let completed = false;
  const store: DailyImprovementStore = {
    claim: async () => claim,
    release: async () => ({ ...claim, outcome: "released" }),
    complete: async () => {
      completed = true;
      return { ...claim, outcome: "completed" };
    },
  };
  const stages = new PipelineStages(new AdapterRegistry([]), store, undefined, undefined, fixture.runner, {
    now: () => new Date(timestamp),
  });
  process.env.DAILY_IMPROVER_RUN_DATE = "2026-07-18";
  try {
    await assert.rejects(
      stages.publicationRequest(fixture.repository, { repository: fixture.repository, reference: "main" }),
      /no longer matches/,
    );
    assert.equal(completed, false);
    await assert.rejects(readFile(join(runRoot, "publication-authorization.json")), /ENOENT/);
    await assert.rejects(readFile(join(runRoot, "publication-request.json")), /ENOENT/);
  } finally {
    delete process.env.DAILY_IMPROVER_RUN_DATE;
  }
});

const timestamp = "2026-07-18T10:30:00.000Z";

function verification(expectedBaseSha: string) {
  return {
    schemaVersion: "verification-report/v1" as const,
    passed: true,
    expectedBaseSha,
    verifierInputsSha256: "a".repeat(64),
  };
}

class AmbiguousMainRunner extends CommandRunner {
  constructor(private readonly sha: string) { super(); }

  override async run(command: readonly string[], cwd: string, timeoutMs?: number, environment?: Readonly<Record<string, string>>): Promise<CommandResult> {
    if (command[0] === "git" && command[1] === "rev-parse") {
      return { command, exitCode: 0, stdout: `${this.sha}\n${this.sha}\n`, stderr: "", durationMs: 0 };
    }
    return await super.run(command, cwd, timeoutMs, environment);
  }
}

async function createRepository(): Promise<{ readonly repository: string; readonly runner: CommandRunner; readonly head: string }> {
  const repository = await mkdtemp(join(tmpdir(), "daily-improver-publication-authorization-"));
  const runner = new CommandRunner();
  await writeFile(join(repository, "README.md"), "baseline\n");
  await git(runner, repository, ["init", "-b", "main"]);
  await git(runner, repository, ["config", "user.email", "improver@example.test"]);
  await git(runner, repository, ["config", "user.name", "Daily Improver Test"]);
  await git(runner, repository, ["add", "."]);
  await git(runner, repository, ["commit", "-m", "baseline"]);
  const head = (await runner.run(["git", "rev-parse", "HEAD"], repository)).stdout.trim();
  return { repository, runner, head };
}

async function git(runner: CommandRunner, root: string, args: readonly string[]): Promise<void> {
  const result = await runner.run(["git", ...args], root);
  assert.equal(result.exitCode, 0, result.stderr);
}
