import assert from "node:assert/strict";
import test from "node:test";
import * as agentWeb from "./agentWeb.js";

test("OpenAI authentication has no Agent Web runtime integration", () => {
  assert.deepEqual(Object.keys(agentWeb), []);
});
