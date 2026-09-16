import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserAdapter, BrowserAdapterHealth, BrowserAdapterSession } from "./agentWeb.js";
import { BrowserAuthenticationRequired, BrowserPhase8Service } from "./agentWeb.js";
import { AgentDatabase } from "./database.js";
import { PlanManager } from "./phase6Runtime.js";
import type { ModelOption, ModelRunRequest, ModelRunResult, ModelRuntime } from "./modelRuntime.js";
import { ResponsibilityKernel } from "./responsibilityKernel.js";

class FakeBrowserAdapter implements BrowserAdapter {
  authenticated = false;
  paused = false;
  async health(): Promise<BrowserAdapterHealth> {
    return { ready: true, protocol: "agent-web-adapter-v1", humanUrl: "https://browser.local/",
      capabilities: ["web.open", "web.snapshot", "web.click", "web.find", "web.download"] };
  }
  async acquire(): Promise<BrowserAdapterSession> { return { sessionRef: "session-opaque", profileRef: "profile-opaque" }; }
  async release(): Promise<void> {}
  async pause(): Promise<void> { this.paused = true; }
  async resume(): Promise<void> { this.paused = false; }
  async navigate(): Promise<Record<string, unknown>> {
    if (!this.authenticated) throw new BrowserAuthenticationRequired("MFA", "https://accounts.example.com",
      { url: "https://accounts.example.com/mfa", cookie: "must-not-persist", password: "must-not-persist" });
    return { url: "https://example.com/private", title: "Private" };
  }
  async snapshot(): Promise<Record<string, unknown>> { return { title: "Page" }; }
  async act(): Promise<Record<string, unknown>> { return { acted: true }; }
  async download(): Promise<Record<string, unknown>> { return { downloadRef: "opaque-download" }; }
  async probeAuthentication(): Promise<boolean> { return this.authenticated; }
  async takeoverUrl(): Promise<string> { return "https://browser.local/vnc.html"; }
}

class ToolCallingRuntime implements ModelRuntime {
  async run<T>(request: ModelRunRequest<T>): Promise<ModelRunResult<T>> {
    const output = request.parse({ status: "TOOL_CALL", summary: "Open the page.", outputs: [], evidence: [], nextActions: [],
      toolCall: { name: "web.open", arguments: { url: "https://example.com/private" } } });
    return { runId: "run", provider: "fake", model: "fake", threadId: "thread", turnId: "turn", output,
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 }, durationMs: 1 };
  }
  async interrupt(): Promise<boolean> { return false; }
  async listModels(): Promise<ModelOption[]> { return []; }
}

test("Phase 8 persists a secret-free auth checkpoint, gives the user exclusive control, and resumes via AUTH_COMPLETED", async () => {
  const database = new AgentDatabase(":memory:");
  const owner = database.createOwner("Owner", "hash", "salt");
  const kernel = new ResponsibilityKernel(database, { reconcileOnStart: false });
  const goal = kernel.createGoal(owner.id, { title: "Use a private page", desiredOutcome: "Read it",
    completionCriteria: ["Page was read"] });
  const task = kernel.createTask({ goalId: goal.id, title: "Open private page", kind: "ACTION",
    specification: { allowedTools: ["web.open"], completionCriteria: ["Page was read"],
      budget: { maxTokens: 1000, maxDurationMs: 5000, maxAttempts: 1 } } }, owner.id);
  const adapter = new FakeBrowserAdapter();
  const browser = new BrowserPhase8Service(database, kernel, adapter);
  await browser.initialize();
  const manager = new PlanManager(database, kernel, new ToolCallingRuntime(), browser);

  const envelope = await manager.executeTask(owner.id, task.id);
  assert.equal(envelope.status, "BLOCKED");
  assert.equal(kernel.getTask(task.id).status, "WAITING_AUTH");
  assert.equal(kernel.getGoal(goal.id, owner.id).status, "WAITING_AUTH");
  const [challenge] = browser.listChallenges(owner.id);
  assert.ok(challenge);
  assert.equal(challenge.type, "MFA");
  const checkpoint = database.db.prepare("SELECT checkpoint_json FROM browser_checkpoints").get() as { checkpoint_json: string };
  assert.equal(checkpoint.checkpoint_json.includes("cookie"), false);
  assert.equal(checkpoint.checkpoint_json.includes("password"), false);

  const takeover = await browser.beginTakeover(challenge.id, owner.id, "https://agent-os.local");
  assert.match(takeover.takeoverUrl, /^https:\/\/agent-os\.local\/api\/v1\/browser\/takeovers\//u);
  const token = takeover.takeoverUrl.split("/").at(-1) as string;
  assert.equal((await browser.resolveTakeover(token, owner.id)).url, "https://browser.local/vnc.html");
  await assert.rejects(() => browser.execute("web.snapshot", {}, { ownerUserId: owner.id, goalId: goal.id, taskId: task.id }),
    /reserved for user authentication/u);

  adapter.authenticated = true;
  const completed = await browser.completeChallenge(challenge.id, owner.id);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(kernel.getTask(task.id).status, "READY");
  assert.equal(kernel.getGoal(goal.id, owner.id).status, "ACTIVE");
  const wake = database.db.prepare("SELECT type, status FROM wake_conditions WHERE idempotency_key = ?").get(`auth:${challenge.id}`) as Record<string, unknown>;
  assert.equal(wake.type, "AUTH_COMPLETED");
  assert.equal(wake.status, "PENDING");
  const tokenRow = database.db.prepare("SELECT revoked_at FROM browser_takeover_tokens").get() as Record<string, unknown>;
  assert.equal(typeof tokenRow.revoked_at, "string");
  database.close();
});
