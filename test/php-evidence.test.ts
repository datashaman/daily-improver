import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectPhpEvidence } from "../src/adapters/php-evidence.js";

test("collects low Clover coverage and high complexity as ranked PHP evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-improver-evidence-"));
  await mkdir(join(root, ".ai", "evidence"), { recursive: true });
  await writeFile(join(root, ".ai", "evidence", "clover.xml"), `<coverage><project>
    <file name="app/Domain/RiskyService.php"><metrics statements="20" coveredstatements="4" /></file>
  </project></coverage>`);
  await writeFile(join(root, ".ai", "evidence", "complexity.json"), JSON.stringify({
    files: [{ file: "app/Domain/BranchingService.php", cyclomaticComplexity: 18, maintainabilityIndex: 42 }],
  }));
  const candidates = await collectPhpEvidence(root);
  assert.equal(candidates.find((candidate) => candidate.id.startsWith("coverage-"))?.target, "app/Domain/RiskyService.php");
  assert.match(candidates.find((candidate) => candidate.id.startsWith("complexity-"))?.rationale ?? "", /complexity 18/);
});
