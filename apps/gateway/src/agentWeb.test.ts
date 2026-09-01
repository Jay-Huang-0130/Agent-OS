import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedAgentWebOAuthSocket,
  isAllowedOpenAIAuthUrl,
  parseAgentWebInfo,
} from "./agentWeb.js";

test("accepts only official OpenAI HTTPS authorization hosts", () => {
  assert.equal(isAllowedOpenAIAuthUrl("https://auth.openai.com/oauth/authorize?state=test"), true);
  assert.equal(isAllowedOpenAIAuthUrl("https://chatgpt.com/auth/callback"), true);
  assert.equal(isAllowedOpenAIAuthUrl("http://auth.openai.com/oauth/authorize"), false);
  assert.equal(isAllowedOpenAIAuthUrl("https://auth.openai.com.example.test/oauth"), false);
  assert.equal(isAllowedOpenAIAuthUrl("https://user@auth.openai.com/oauth"), false);
});

test("accepts only the private Agent Web OAuth socket", () => {
  assert.equal(isAllowedAgentWebOAuthSocket("/run/agent-web-oauth/open.sock"), true);
  assert.equal(isAllowedAgentWebOAuthSocket("/tmp/open.sock"), false);
  assert.equal(isAllowedAgentWebOAuthSocket(undefined), false);
});

test("parses only stable uppercase Agent Web capability keys", () => {
  assert.deepEqual(parseAgentWebInfo([
    "READY=true",
    "HUMAN_URL=https://192.168.1.2:6901/",
    "OPENAI_OAUTH_BROWSER_AVAILABLE=true",
    "not-a-key=ignored",
  ].join("\n")), {
    READY: "true",
    HUMAN_URL: "https://192.168.1.2:6901/",
    OPENAI_OAUTH_BROWSER_AVAILABLE: "true",
  });
});
