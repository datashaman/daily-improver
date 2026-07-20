import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function collectTests(directory) {
  const tests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...await collectTests(path));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) tests.push(path);
  }
  return tests.sort();
}

const testRoot = await mkdtemp(join(tmpdir(), "daily-improver-test-run-"));

try {
  const tests = await collectTests(join(process.cwd(), "dist", "test"));
  if (tests.length === 0) throw new Error("No compiled test files were found.");
  const child = spawn(process.execPath, ["--test", "--test-concurrency=4", ...tests], {
    stdio: "inherit",
    env: {
      ...process.env,
      TMPDIR: testRoot,
      TMP: testRoot,
      TEMP: testRoot,
    },
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
