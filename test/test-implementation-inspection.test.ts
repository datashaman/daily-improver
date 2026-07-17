import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertTestImplementationInspection,
  inspectGeneratedTestImplementation,
  requireBlackBoxTest,
} from "../src/domain/test-implementation-inspection.js";

const target = "src/MoneyAllocator.php";
const testPath = "tests/MoneyAllocatorPropertyTest.php";
const invariant = "Every allocation sums to its requested total.";
const targetSource = `<?php
final class MoneyAllocator {
  public function allocate(int $total, int $parts): array {
    $share = intdiv($total, $parts);
    return array_fill(0, $parts, $share);
  }
}
`;

const expectation = {
  testPath,
  observedTestPaths: [testPath],
  target,
  criterion: { kind: "property-invariant" as const, statement: invariant },
  approvedPropertyInvariants: [invariant],
  approvedAcceptanceCriteria: ["The public behavior is protected."],
};

test("accepts a black-box test bound to the observed test, selected target, and approved invariant", async () => {
  const root = await fixture(`<?php
use App\\Domain\\MoneyAllocator;
$allocator = new MoneyAllocator();
for ($total = 0; $total < 50; $total++) {
  $allocation = $allocator->allocate($total, 3);
  if (array_sum($allocation) !== $total) throw new RuntimeException('invariant failed');
}
`);
  const inspection = await inspectGeneratedTestImplementation({ root, ...expectation });
  assert.equal(inspection.outcome, "accepted");
  assert.deepEqual(inspection.signals, []);
  assert.equal(inspection.testPath, testPath);
  assert.equal(inspection.target, target);
  assert.equal(inspection.criterion.statement, invariant);
  assert.match(inspection.testSha256, /^[a-f0-9]{64}$/);
  assert.match(inspection.targetSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(inspection), /intdiv|array_fill|MoneyAllocator;/);
  assert.doesNotThrow(() => requireBlackBoxTest(inspection));
});

test("rejects tests that inspect production source text", async () => {
  const root = await fixture(`<?php
$source = file_get_contents(__DIR__ . '/../src/MoneyAllocator.php');
if (!str_contains($source, 'intdiv')) throw new RuntimeException('implementation changed');
`);
  const inspection = await inspectGeneratedTestImplementation({ root, ...expectation });
  assert.equal(inspection.outcome, "rejected");
  assert.deepEqual(inspection.signals, ["production-source-inspection"]);
  assert.throws(() => requireBlackBoxTest(inspection), /implementation details/);
});

test("rejects long exact and identifier-renamed structural copies of the target algorithm", async () => {
  const copiedTarget = `<?php
function distribute($total, $parts) {
  $share = intdiv($total, $parts);
  $remainder = $total % $parts;
  $allocation = array_fill(0, $parts, $share);
  for ($index = 0; $index < $remainder; $index++) {
    $allocation[$index]++;
  }
  return $allocation;
}
`;
  const exactRoot = await fixture(`<?php
function expected($total, $parts) {
  $share = intdiv($total, $parts);
  $remainder = $total % $parts;
  $allocation = array_fill(0, $parts, $share);
  for ($index = 0; $index < $remainder; $index++) {
    $allocation[$index]++;
  }
  return $allocation;
}
`, copiedTarget);
  const exact = await inspectGeneratedTestImplementation({ root: exactRoot, ...expectation });
  assert.equal(exact.outcome, "rejected");
  assert.ok(exact.signals.includes("exact-token-copy"));

  const renamedRoot = await fixture(`<?php
function oracle($amount, $count) {
  $base = intdiv($amount, $count);
  $left = $amount % $count;
  $expected = array_fill(0, $count, $base);
  for ($position = 0; $position < $left; $position++) {
    $expected[$position]++;
  }
  return $expected;
}
`, copiedTarget);
  const renamed = await inspectGeneratedTestImplementation({ root: renamedRoot, ...expectation });
  assert.equal(renamed.outcome, "rejected");
  assert.ok(renamed.signals.includes("structural-token-copy"));
});

test("fails closed on extended, unbound, and inconsistent retained decisions", async () => {
  const root = await fixture("<?php $actual = (new MoneyAllocator())->allocate(12, 3);\n");
  const inspection = await inspectGeneratedTestImplementation({ root, ...expectation });
  assert.throws(() => assertTestImplementationInspection({ ...inspection, extra: true }, expectation), /exact schema/);
  assert.throws(() => assertTestImplementationInspection({ ...inspection, testPath: "tests/Other.php" }, expectation), /observed generated test/);
  assert.throws(() => assertTestImplementationInspection({
    ...inspection,
    criterion: { kind: "property-invariant", statement: "An unapproved invariant." },
  }, expectation), /not approved/);
  assert.throws(() => assertTestImplementationInspection({ ...inspection, outcome: "rejected" }, expectation), /outcome is inconsistent/);
});

async function fixture(testSource: string, productionSource = targetSource): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "test-implementation-inspection-"));
  for (const [path, source] of [[target, productionSource], [testPath, testSource]] as const) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source, "utf8");
  }
  return root;
}
