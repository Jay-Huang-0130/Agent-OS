import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import {
  clearSessionCookie,
  createSession,
  hashPassword,
  readSession,
  requireCsrf,
  requireSession,
  setSessionCookie,
  verifyPassword,
} from "./auth.js";
import type { GatewayConfig } from "./config.js";
import { publicDeviceName } from "./config.js";
import { CodexAuthBridge, type OpenAIAuthService } from "./codexAuth.js";
import { AgentDatabase, type ActivityRecord } from "./database.js";
import { collectSystemStatus } from "./metrics.js";

const settingsSchema = z.object({
  deviceName: z.string().trim().min(1).max(64),
  language: z.enum(["zh-Hant", "en"]),
  timezone: z.string().trim().min(1).max(64),
  theme: z.enum(["system", "light", "dark"]),
}).strict();

const setupSchema = z.object({
  pairingCode: z.string().min(1).max(32),
  password: z.string().min(10).max(256),
  displayName: z.string().trim().min(1).max(64),
}).strict();

const loginSchema = z.object({ password: z.string().min(1).max(256) }).strict();
const cancelProviderLoginSchema = z.object({ loginId: z.string().uuid() }).strict();

type Settings = z.infer<typeof settingsSchema>;
type EventSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

interface LoginAttempt {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

export interface BuildAppOptions {
  logger?: boolean;
  openAIAuth?: OpenAIAuthService;
}

function apiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ code, message });
}

function normalizePairingCode(value: string): string {
  return value.replace(/[\s-]/gu, "").toUpperCase();
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ensurePairingCode(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const current = normalizePairingCode(readFileSync(path, "utf8"));
    if (current.length >= 6) return current;
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const code = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  writeFileSync(path, `${code}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows development hosts do not implement POSIX permissions.
  }
  return code;
}

function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/u).filter(Boolean);
  const value = parts.length > 1
    ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`
    : displayName.slice(0, 2);
  return value.toUpperCase();
}

function activityForApi(record: ActivityRecord) {
  const allowed = new Set(["system", "security", "settings", "update"]);
  return {
    id: record.id,
    title: record.title,
    detail: record.detail,
    kind: allowed.has(record.type) ? record.type : "system",
    occurredAt: record.createdAt,
  };
}

function requestIsSameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function settingsDefaults(): Settings {
  return {
    deviceName: publicDeviceName(),
    language: "zh-Hant",
    timezone: process.env.TZ ?? "Asia/Taipei",
    theme: "system",
  };
}

export async function buildApp(config: GatewayConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const secure = Boolean(config.tlsCertPath && config.tlsKeyPath);
  const https = secure
    ? { cert: readFileSync(config.tlsCertPath as string), key: readFileSync(config.tlsKeyPath as string) }
    : undefined;
  const app = fastify({
    logger: options.logger ?? false,
    trustProxy: false,
    bodyLimit: 256 * 1024,
    ...(https ? { https } : {}),
  });
  const database = new AgentDatabase(config.databasePath);
  const sockets = new Set<EventSocket>();
  const loginAttempts = new Map<string, LoginAttempt>();
  const pairingCode = database.hasOwner() ? undefined : ensurePairingCode(config.pairingCodePath);

  const broadcast = (event: unknown) => {
    const frame = JSON.stringify(event);
    for (const socket of sockets) {
      try {
        socket.send(frame);
      } catch {
        sockets.delete(socket);
      }
    }
  };
  const openAIAuth = options.openAIAuth ?? new CodexAuthBridge(config);
  const stopOpenAIUpdates = openAIAuth.onUpdate((status) => {
    broadcast({ type: "provider.openai.updated", data: status });
  });

  const addActivity = (type: string, title: string, detail: string, severity = "info") => {
    const record = database.addActivity(type, title, detail, severity);
    broadcast({ type: "activity.created", data: activityForApi(record) });
    return record;
  };

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "content-security-policy",
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
    );
    if (secure) reply.header("strict-transport-security", "max-age=31536000");
    return payload;
  });

  app.addHook("preHandler", async (request, reply) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !requestIsSameOrigin(request)) {
      return apiError(reply, 403, "invalid_origin", "This request did not come from the Agent-OS interface.");
    }
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024, perMessageDeflate: false },
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      database.getOwner();
      return { status: "ready" };
    } catch {
      return apiError(reply, 503, "database_unavailable", "Agent-OS database is unavailable.");
    }
  });

  app.get("/api/v1/meta", async () => ({
    name: "Agent-OS",
    version: config.version,
    setupRequired: !database.hasOwner(),
    secure,
    hostname: publicDeviceName(),
  }));

  app.post("/api/v1/setup/complete", async (request, reply) => {
    if (database.hasOwner()) return apiError(reply, 409, "setup_complete", "Agent-OS has already been configured.");
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) {
      return apiError(reply, 400, "invalid_setup", "Check the name, pairing code and password (minimum 10 characters).");
    }
    if (!pairingCode || !safeEqual(normalizePairingCode(parsed.data.pairingCode), pairingCode)) {
      return apiError(reply, 403, "invalid_pairing_code", "The pairing code is incorrect.");
    }

    const password = await hashPassword(parsed.data.password);
    const owner = database.createOwner(parsed.data.displayName, password.hash, password.salt);
    database.setSettings(settingsDefaults());
    const session = createSession(database, owner.id, config.sessionTtlSeconds);
    setSessionCookie(reply, session.token, session.expiresAt, secure);
    if (existsSync(config.pairingCodePath)) unlinkSync(config.pairingCodePath);
    addActivity("security", "Device paired", `${owner.displayName} completed first-time setup.`);
    return reply.code(204).send();
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    if (!database.hasOwner()) {
      return apiError(reply, 409, "setup_required", "Complete first-time setup before signing in.");
    }
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, "invalid_login", "Enter your Agent-OS password.");
    const key = request.ip;
    const now = Date.now();
    const attempt = loginAttempts.get(key);
    if (attempt?.blockedUntil && attempt.blockedUntil > now) {
      reply.header("retry-after", Math.ceil((attempt.blockedUntil - now) / 1_000));
      return apiError(reply, 429, "login_rate_limited", "Too many attempts. Wait one minute and try again.");
    }
    const owner = database.getOwner();
    const valid = owner && await verifyPassword(parsed.data.password, owner.passwordHash, owner.passwordSalt);
    if (!owner || !valid) {
      const recent = Boolean(attempt && now - attempt.firstFailureAt < 5 * 60_000);
      const failures = recent && attempt ? attempt.failures + 1 : 1;
      loginAttempts.set(key, {
        failures,
        firstFailureAt: recent && attempt ? attempt.firstFailureAt : now,
        blockedUntil: failures >= 5 ? now + 60_000 : 0,
      });
      return apiError(reply, 401, "invalid_credentials", "The password is incorrect.");
    }
    loginAttempts.delete(key);
    const session = createSession(database, owner.id, config.sessionTtlSeconds);
    setSessionCookie(reply, session.token, session.expiresAt, secure);
    addActivity("security", "Signed in", `${owner.displayName} signed in to the management interface.`);
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/session", async (request) => {
    const session = readSession(request, database);
    if (!session) return { authenticated: false };
    return {
      authenticated: true,
      user: { id: session.userId, displayName: session.displayName, initials: initials(session.displayName) },
      csrfToken: session.csrfToken,
    };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    database.deleteSession(session.tokenHash);
    clearSessionCookie(reply, secure);
    return reply.code(204).send();
  });

  app.get("/api/v1/system/status", async (request, reply) => {
    if (!requireSession(request, reply, database)) return;
    return collectSystemStatus(config.version);
  });

  app.get("/api/v1/activity", async (request, reply) => {
    if (!requireSession(request, reply, database)) return;
    return database.listActivity(30).map(activityForApi);
  });

  app.get("/api/v1/settings", async (request, reply) => {
    if (!requireSession(request, reply, database)) return;
    return database.getSettings(settingsDefaults());
  });

  app.put("/api/v1/settings", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, "invalid_settings", "One or more settings are invalid.");
    database.setSettings(parsed.data);
    addActivity("settings", "Settings updated", `${session.displayName} changed device settings.`);
    broadcast({ type: "settings.updated", data: parsed.data });
    return parsed.data;
  });

  app.get("/api/v1/providers/openai", async (request, reply) => {
    if (!requireSession(request, reply, database)) return;
    return openAIAuth.status(false);
  });

  app.post("/api/v1/providers/openai/oauth/start", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    try {
      const login = await openAIAuth.startDeviceLogin();
      addActivity("settings", "OpenAI sign-in started", `${session.displayName} started secure device authorization.`);
      return login;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "OpenAI sign-in could not be started.";
      return apiError(reply, 503, "openai_login_unavailable", message);
    }
  });

  app.post("/api/v1/providers/openai/oauth/cancel", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const parsed = cancelProviderLoginSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, "invalid_login_id", "The OpenAI login ID is invalid.");
    try {
      await openAIAuth.cancelLogin(parsed.data.loginId);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "OpenAI sign-in could not be cancelled.";
      return apiError(reply, 503, "openai_cancel_failed", message);
    }
  });

  app.post("/api/v1/providers/openai/logout", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    try {
      await openAIAuth.logout();
      addActivity("settings", "OpenAI disconnected", `${session.displayName} disconnected the ChatGPT account.`);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "OpenAI could not be disconnected.";
      return apiError(reply, 503, "openai_logout_failed", message);
    }
  });

  app.get("/api/v1/events", { websocket: true }, (socket, request) => {
    if (!requestIsSameOrigin(request)) {
      socket.close(1008, "invalid origin");
      return;
    }
    const session = readSession(request, database);
    if (!session) {
      socket.close(1008, "authentication required");
      return;
    }
    sockets.add(socket);
    socket.send(JSON.stringify({ type: "heartbeat", data: { at: new Date().toISOString() } }));
    void collectSystemStatus(config.version).then((status) => {
      if (sockets.has(socket)) socket.send(JSON.stringify({ type: "system.status", data: status }));
    }).catch(() => { /* The regular status stream will retry. */ });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  const heartbeat = setInterval(() => {
    broadcast({ type: "heartbeat", data: { at: new Date().toISOString() } });
  }, 25_000);
  heartbeat.unref();

  let collectingSystemStatus = false;
  let previousOverallStatus: "healthy" | "degraded" | "unavailable" | undefined;
  const systemStatusStream = setInterval(async () => {
    if (!sockets.size || collectingSystemStatus) return;
    collectingSystemStatus = true;
    try {
      const status = await collectSystemStatus(config.version);
      broadcast({ type: "system.status", data: status });
      if (status.overall === "degraded" && previousOverallStatus !== "degraded") {
        broadcast({
          type: "notification.created",
          data: {
            id: `system-${Date.now()}`,
            title: "系統狀態需要注意",
            detail: "Agent-OS 偵測到資源或服務異常，請查看系統狀態。",
            kind: "system",
            createdAt: status.generatedAt,
            read: false,
          },
        });
      }
      previousOverallStatus = status.overall;
    } finally {
      collectingSystemStatus = false;
    }
  }, 15_000);
  systemStatusStream.unref();

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    clearInterval(systemStatusStream);
  });

  if (existsSync(join(config.webDistPath, "index.html"))) {
    await app.register(fastifyStatic, { root: config.webDistPath, prefix: "/" });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url === "/healthz" || request.url === "/readyz") {
      return apiError(reply, 404, "not_found", "The requested Agent-OS endpoint does not exist.");
    }
    if (existsSync(join(config.webDistPath, "index.html"))) {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    }
    return apiError(reply, 503, "web_ui_unavailable", "The Agent-OS Web interface has not been built.");
  });

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const socket of sockets) socket.close(1001, "server shutdown");
    sockets.clear();
    stopOpenAIUpdates();
    await openAIAuth.close();
    database.close();
  });

  return app;
}
