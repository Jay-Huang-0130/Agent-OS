import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-os-gateway-"));
  const config = loadConfig({
    stateDir,
    databasePath: join(stateDir, "test.db"),
    pairingCodePath: join(stateDir, "pairing-code"),
    webDistPath: join(stateDir, "missing-web"),
  });
  const app = await buildApp(config);
  apps.push(app);
  return { app, config };
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
