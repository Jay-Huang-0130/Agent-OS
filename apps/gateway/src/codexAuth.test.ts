import assert from "node:assert/strict";
import test from "node:test";
import { validateLoopbackOAuthCallback } from "./codexAuth.js";

const authUrl = "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=expected-state";

test("accepts the exact loopback callback created by the active OAuth login", () => {
  const callback = validateLoopbackOAuthCallback(
    authUrl,
    "http://localhost:1455/auth/callback?code=short-lived-code&state=expected-state",
  );
  assert.equal(callback.hostname, "localhost");
  assert.equal(callback.searchParams.get("code"), "short-lived-code");
});

test("rejects callback forwarding to any other host, port, path or state", () => {
  const invalid = [
    "http://192.168.1.1:1455/auth/callback?code=x&state=expected-state",
    "http://localhost:8787/auth/callback?code=x&state=expected-state",
    "http://localhost:1455/other?code=x&state=expected-state",
    "http://localhost:1455/auth/callback?code=x&state=wrong-state",
    "http://localhost:1455/auth/callback?state=expected-state",
  ];
  for (const callback of invalid) {
    assert.throws(() => validateLoopbackOAuthCallback(authUrl, callback));
  }
});

test("rejects an authorization URL that does not use a loopback callback", () => {
  const unsafe = "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Fexample.com%2Fcallback&state=expected-state";
  assert.throws(() => validateLoopbackOAuthCallback(unsafe, "http://example.com/callback?code=x&state=expected-state"));
});
