import assert from "node:assert/strict";
import test from "node:test";
import { CodexAuthBridge } from "./codexAuth.js";

test("Codex authentication exposes device-code login without browser callbacks", () => {
  const methods = Object.getOwnPropertyNames(CodexAuthBridge.prototype);
  assert.equal(methods.includes("startDeviceLogin"), true);
  assert.equal(methods.includes("startBrowserLogin"), false);
  assert.equal(methods.includes("completeBrowserLogin"), false);
});
