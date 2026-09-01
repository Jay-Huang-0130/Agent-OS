import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { OpenAIAuthService, OpenAIConnection } from "./codexAuth.js";
import { loadConfig } from "./config.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(openAIAuth?: OpenAIAuthService) {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-os-gateway-"));
  const config = loadConfig({
    stateDir,
    databasePath: join(stateDir, "test.db"),
    pairingCodePath: join(stateDir, "pairing-code"),
    webDistPath: join(stateDir, "missing-web"),
  });
  const app = await buildApp(config, {
    ...(openAIAuth ? { openAIAuth } : {}),
  });
  apps.push(app);
  return { app, config };
}

class FakeOpenAIAuth implements OpenAIAuthService {
  value: OpenAIConnection = { available: true, state: "disconnected", authMode: null };
  private listener: ((status: OpenAIConnection) => void) | undefined;

  async status(): Promise<OpenAIConnection> { return this.value; }
  async startDeviceLogin() {
    this.value = { available: true, state: "connecting", authMode: null };
    this.listener?.(this.value);
    return {
      loginId: "8d1e249e-57a0-47cb-af4d-1e55b71fbf40",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    };
  }
  async cancelLogin(): Promise<void> { this.value = { available: true, state: "disconnected", authMode: null }; }
  async logout(): Promise<void> { this.value = { available: true, state: "disconnected", authMode: null }; }
  onUpdate(listener: (status: OpenAIConnection) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  async close(): Promise<void> {}
}

test("first-time setup creates an authenticated owner session", async () => {
  const { app, config } = await fixture();
  const metaBefore = await app.inject({ method: "GET", url: "/api/v1/meta" });
  assert.equal(metaBefore.statusCode, 200);
  assert.equal(metaBefore.json().setupRequired, true);

  const rejected = await app.inject({
    method: "POST",
    url: "/api/v1/setup/complete",
    payload: { pairingCode: "WRONG123", password: "long-enough-password", displayName: "Owner" },
  });
  assert.equal(rejected.statusCode, 403);

  const pairingCode = readFileSync(config.pairingCodePath, "utf8").trim();
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup/complete",
    payload: { pairingCode, password: "long-enough-password", displayName: "Owner" },
  });
  assert.equal(setup.statusCode, 204);
  const cookie = setup.headers["set-cookie"];
  assert.ok(cookie);

  const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().authenticated, true);
  assert.equal(session.json().user.displayName, "Owner");

  const metaAfter = await app.inject({ method: "GET", url: "/api/v1/meta" });
  assert.equal(metaAfter.json().setupRequired, false);
});

test("protected routes require authentication and CSRF", async () => {
  const { app, config } = await fixture();
  const pairingCode = readFileSync(config.pairingCodePath, "utf8").trim();
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup/complete",
    payload: { pairingCode, password: "long-enough-password", displayName: "Owner" },
  });
  const cookie = setup.headers["set-cookie"];
  assert.ok(cookie);

  const denied = await app.inject({ method: "GET", url: "/api/v1/settings" });
  assert.equal(denied.statusCode, 401);

  const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });
  const csrfToken = session.json().csrfToken as string;
  const noCsrf = await app.inject({
    method: "PUT",
    url: "/api/v1/settings",
    headers: { cookie },
    payload: { deviceName: "Pi", language: "zh-Hant", timezone: "Asia/Taipei", theme: "dark" },
  });
  assert.equal(noCsrf.statusCode, 403);

  const updated = await app.inject({
    method: "PUT",
    url: "/api/v1/settings",
    headers: { cookie, "x-csrf-token": csrfToken },
    payload: { deviceName: "Pi", language: "zh-Hant", timezone: "Asia/Taipei", theme: "dark" },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().theme, "dark");
});

test("authenticated websocket receives an initial system status snapshot", async () => {
  const { app, config } = await fixture();
  const pairingCode = readFileSync(config.pairingCodePath, "utf8").trim();
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup/complete",
    payload: { pairingCode, password: "long-enough-password", displayName: "Owner" },
  });
  const cookie = setup.headers["set-cookie"];
  assert.ok(cookie);
  const cookieHeader = Array.isArray(cookie) ? cookie[0] : cookie;
  assert.ok(cookieHeader);
  await app.ready();

  const socket = await app.injectWS("/api/v1/events", { headers: { cookie: cookieHeader } });
  const status = await new Promise<{ type: string; data: { generatedAt: string; overall: string } }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("system status event timed out")), 4_000);
    socket.on("message", (frame: Buffer) => {
      const event = JSON.parse(frame.toString()) as { type: string; data: { generatedAt: string; overall: string } };
      if (event.type !== "system.status") return;
      clearTimeout(timeout);
      resolve(event);
    });
  });

  assert.equal(status.type, "system.status");
  assert.ok(status.data.generatedAt);
  assert.ok(["healthy", "degraded", "unavailable"].includes(status.data.overall));
  socket.close();
});

test("OpenAI device authorization requires the owner session and CSRF", async () => {
  const provider = new FakeOpenAIAuth();
  const { app, config } = await fixture(provider);
  const pairingCode = readFileSync(config.pairingCodePath, "utf8").trim();
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup/complete",
    payload: { pairingCode, password: "long-enough-password", displayName: "Owner" },
  });
  const cookie = setup.headers["set-cookie"];
  assert.ok(cookie);
  const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });
  const csrfToken = session.json().csrfToken as string;

  const anonymous = await app.inject({ method: "GET", url: "/api/v1/providers/openai" });
  assert.equal(anonymous.statusCode, 401);
  const noCsrf = await app.inject({
    method: "POST",
    url: "/api/v1/providers/openai/oauth/start",
    headers: { cookie },
  });
  assert.equal(noCsrf.statusCode, 403);

  const started = await app.inject({
    method: "POST",
    url: "/api/v1/providers/openai/oauth/start",
    headers: { cookie, "x-csrf-token": csrfToken },
  });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().userCode, "ABCD-1234");
  assert.equal(started.json().verificationUrl, "https://auth.openai.com/codex/device");

  provider.value = { available: true, state: "connected", authMode: "chatgpt", email: "owner@example.com", planType: "plus" };
  const status = await app.inject({ method: "GET", url: "/api/v1/providers/openai", headers: { cookie } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().state, "connected");
  assert.equal(status.json().planType, "plus");
  assert.equal("accessToken" in status.json(), false);

  const logout = await app.inject({
    method: "POST",
    url: "/api/v1/providers/openai/logout",
    headers: { cookie, "x-csrf-token": csrfToken },
  });
  assert.equal(logout.statusCode, 204);
});

test("owner can create and control durable Projects and Goals", async () => {
  const { app, config } = await fixture();
  const pairingCode = readFileSync(config.pairingCodePath, "utf8").trim();
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup/complete",
    payload: { pairingCode, password: "long-enough-password", displayName: "Owner" },
  });
  const cookie = setup.headers["set-cookie"];
  assert.ok(cookie);
  const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });
  const csrfToken = session.json().csrfToken as string;
  const writeHeaders = { cookie, "x-csrf-token": csrfToken };

  const anonymous = await app.inject({ method: "GET", url: "/api/v1/goals" });
  assert.equal(anonymous.statusCode, 401);
  const noCsrf = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "Agent-OS" },
    headers: { cookie },
  });
  assert.equal(noCsrf.statusCode, 403);

  const project = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { ...writeHeaders, "idempotency-key": "create-agent-os-project" },
    payload: { name: "Agent-OS", description: "Responsibility Kernel" },
  });
  assert.equal(project.statusCode, 201);
  const projectId = project.json().id as string;
  const projectReplay = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { ...writeHeaders, "idempotency-key": "create-agent-os-project" },
    payload: { name: "Agent-OS", description: "Responsibility Kernel" },
  });
  assert.equal(projectReplay.json().id, projectId);
  const projectConflict = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { ...writeHeaders, "idempotency-key": "create-agent-os-project" },
    payload: { name: "Different project" },
  });
  assert.equal(projectConflict.statusCode, 409);

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/goals",
    headers: { ...writeHeaders, "idempotency-key": "accept-phase-3" },
    payload: {
      projectId,
      title: "Complete Phase 3",
      desiredOutcome: "The responsibility kernel is durable.",
      agentCommitment: ["Preserve state across restarts."],
      completionCriteria: ["All Phase 3 tests pass."],
      autonomy: "ACT_WITHIN_POLICY",
    },
  });
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.json().status, "ACTIVE");
  assert.deepEqual(accepted.json().contract.completionCriteria, ["All Phase 3 tests pass."]);
  const goalId = accepted.json().id as string;

  const listed = await app.inject({
    method: "GET",
    url: `/api/v1/goals?projectId=${projectId}&status=ACTIVE`,
    headers: { cookie },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().length, 1);

  const paused = await app.inject({
    method: "POST",
    url: `/api/v1/goals/${goalId}/pause`,
    headers: { ...writeHeaders, "idempotency-key": "pause-phase-3" },
    payload: { reason: "Deployment window" },
  });
  assert.equal(paused.statusCode, 200);
  assert.equal(paused.json().status, "WAITING");
  const resumed = await app.inject({
    method: "POST",
    url: `/api/v1/goals/${goalId}/resume`,
    headers: writeHeaders,
    payload: {},
  });
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.json().status, "ACTIVE");

  const cancelled = await app.inject({
    method: "POST",
    url: `/api/v1/goals/${goalId}/cancel`,
    headers: writeHeaders,
    payload: { reason: "Owner changed direction" },
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().status, "CANCELLED");
  const events = await app.inject({
    method: "GET",
    url: `/api/v1/goals/${goalId}/events`,
    headers: { cookie },
  });
  assert.deepEqual(events.json().map((event: { type: string }) => event.type), [
    "goal.accepted",
    "goal.paused",
    "goal.resumed",
    "goal.cancelled",
  ]);
});

test("Phase 4 API exposes commitments, portfolio projection and Project detail", async () => {
  const { app, config } = await fixture();
  const pairingCode = readFileSync(config.pairingCodePath, "utf8").trim();
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/setup/complete",
    payload: { pairingCode, password: "long-enough-password", displayName: "Owner" },
  });
  const cookie = setup.headers["set-cookie"];
  assert.ok(cookie);
  const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } });
  const writeHeaders = { cookie, "x-csrf-token": session.json().csrfToken as string };
  const projectResponse = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: writeHeaders,
    payload: { name: "Phase 4" },
  });
  const projectId = projectResponse.json().id as string;
  const goalResponse = await app.inject({
    method: "POST",
    url: "/api/v1/goals",
    headers: writeHeaders,
    payload: {
      projectId,
      title: "Ship the Secretary Portfolio",
      desiredOutcome: "The owner sees real durable responsibilities.",
      completionCriteria: ["Portfolio acceptance tests pass."],
      deadline: "2026-09-05T18:00:00+08:00",
      priority: { urgency: "high", userRank: 1 },
      autonomy: "PREPARE",
    },
  });
  assert.equal(goalResponse.statusCode, 201);
  assert.equal(goalResponse.json().contract.deadline, "2026-09-05T18:00:00+08:00");
  const goalId = goalResponse.json().id as string;

  const commitmentResponse = await app.inject({
    method: "POST",
    url: "/api/v1/commitments",
    headers: { ...writeHeaders, "idempotency-key": "phase-4-commitment" },
    payload: {
      goalId,
      owner: "AGENT_OS",
      owedTo: "USER",
      promise: "Prepare the daily responsibility summary",
      dueAt: "2026-09-04T18:00:00+08:00",
      followUpPolicy: "remind_24h_before",
    },
  });
  assert.equal(commitmentResponse.statusCode, 201);
  const commitmentId = commitmentResponse.json().id as string;

  const portfolio = await app.inject({ method: "GET", url: "/api/v1/portfolio", headers: { cookie } });
  assert.equal(portfolio.statusCode, 200);
  assert.equal(portfolio.json().activeProjects[0].id, projectId);
  assert.equal(portfolio.json().commitments[0].id, commitmentId);

  const detail = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: { cookie } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().goals[0].id, goalId);
  assert.equal(detail.json().commitments[0].id, commitmentId);
  assert.equal(detail.json().timeline.some((event: { type: string }) => event.type === "goal.accepted"), true);

  const approval = await app.inject({
    method: "POST",
    url: "/api/v1/approvals",
    headers: writeHeaders,
    payload: { goalId, action: { summary: "Publish the Secretary view" }, risk: "external_side_effect" },
  });
  assert.equal(approval.statusCode, 201);
  const approvalId = approval.json().id as string;
  const decisionQueue = await app.inject({ method: "GET", url: "/api/v1/portfolio", headers: { cookie } });
  assert.equal(decisionQueue.json().needsDecision[0].id, goalId);
  assert.equal(decisionQueue.json().approvals[0].id, approvalId);
  const decided = await app.inject({
    method: "POST",
    url: `/api/v1/approvals/${approvalId}/decision`,
    headers: writeHeaders,
    payload: { decision: "APPROVED", reason: "Owner approved the publication." },
  });
  assert.equal(decided.statusCode, 200);
  assert.equal(decided.json().status, "APPROVED");

  const fulfilled = await app.inject({
    method: "POST",
    url: `/api/v1/commitments/${commitmentId}/fulfill`,
    headers: writeHeaders,
    payload: { evidenceRefs: ["artifact:daily-summary"] },
  });
  assert.equal(fulfilled.statusCode, 200);
  assert.equal(fulfilled.json().status, "FULFILLED");
});
