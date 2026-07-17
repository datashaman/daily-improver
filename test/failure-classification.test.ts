import assert from "node:assert/strict";
import test from "node:test";
import { PhpAdapter } from "../src/adapters/php.js";

test("classifies common PHP failures for review feedback", () => {
  const adapter = new PhpAdapter();
  assert.equal(adapter.classifyFailure("Parse error: syntax error"), "syntax");
  assert.equal(adapter.classifyFailure("Failed asserting that false is true"), "test-assertion");
  assert.equal(adapter.classifyFailure("Allowed memory size exhausted"), "resource-limit");
});
