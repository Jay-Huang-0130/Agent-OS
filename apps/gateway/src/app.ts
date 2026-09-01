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
import { AssistantIntakeError, AssistantIntakeService, type RequestRouter } from "./assistantIntake.js";
import type { GatewayConfig } from "./config.js";
import { publicDeviceName } from "./config.js";
import { CodexAuthBridge, type OpenAIAuthService } from "./codexAuth.js";
import { AgentDatabase, type ActivityRecord } from "./database.js";
import { collectSystemStatus } from "./metrics.js";
import {
  autonomyLevels,
  commitmentOwners,
  commitmentStatuses,
  goalStatuses,
  KernelError,
  ResponsibilityKernel,
} from "./responsibilityKernel.js";

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
const assistantRequestSchema = z.object({
  message: z.string().trim().min(1).max(32_000),
}).strict();
const assistantRequestQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();
const cancelProviderLoginSchema = z.object({ loginId: z.string().uuid() }).strict();
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4_000).optional(),
}).strict();
const createGoalSchema = z.object({
  projectId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(240),
  desiredOutcome: z.string().trim().min(1).max(8_000),
  agentCommitment: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  completionCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
  cancellationCriteria: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  externalDependencies: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  deadline: z.string().datetime({ offset: true }).optional(),
  constraints: z.record(z.unknown()).optional(),
  priority: z.record(z.unknown()).optional(),
  attentionPolicy: z.record(z.unknown()).optional(),
  budget: z.record(z.unknown()).optional(),
  autonomy: z.enum(autonomyLevels).optional(),
}).strict();
const goalActionSchema = z.object({ reason: z.string().trim().min(1).max(2_000).optional() }).strict();
const listGoalsQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  status: z.enum(goalStatuses).optional(),
}).strict();
const eventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();
const createCommitmentSchema = z.object({
  goalId: z.string().uuid(),
  owner: z.enum(commitmentOwners),
  owedTo: z.enum(commitmentOwners),
  promise: z.string().trim().min(1).max(4_000),
  dueAt: z.string().datetime({ offset: true }).optional(),
  followUpPolicy: z.enum(["remind_at_due", "remind_24h_before"]).optional(),
}).strict();
const listCommitmentsQuerySchema = z.object({
  goalId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  status: z.enum(commitmentStatuses).optional(),
}).strict();
const commitmentActionSchema = z.object({
  evidenceRefs: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
}).strict();
const progressGoalSchema = z.object({
  detail: z.string().trim().min(1).max(4_000),
  progress: z.number().min(0).max(100).optional(),
}).strict();
const blockGoalSchema = z.object({ reason: z.string().trim().min(1).max(2_000) }).strict();
const completeGoalSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
  evidenceRefs: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
}).strict();
const requestApprovalSchema = z.object({
  goalId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  action: z.record(z.unknown()),
  risk: z.string().trim().min(1).max(1_000),
}).strict();
const approvalDecisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

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
  requestRouter?: RequestRouter;
}

function apiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ code, message });
}

function kernelApiError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof KernelError)) throw error;
  const status = error.code === "not_found" ? 404 : error.code === "completion_evidence_required" ? 422 : 409;
  return apiError(reply, status, error.code, error.message);
}

function idempotencyKey(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const value = request.headers["idempotency-key"];
  if (value === undefined) return undefined;
  if (Array.isArray(value) || value.length < 1 || value.length > 200) {
    apiError(reply, 400, "invalid_idempotency_key", "Idempotency-Key must contain 1 to 200 characters.");
    return "";
  }
  return value;
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
  const kernel = new ResponsibilityKernel(database);
  const assistantIntake = options.requestRouter
    ? new AssistantIntakeService(database, options.requestRouter)
    : new AssistantIntakeService(database);
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

  app.post("/api/v1/assistant/requests", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const key = idempotencyKey(request, reply);
    if (key === "") return;
    const parsed = assistantRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return apiError(reply, 400, "invalid_assistant_request", "A message between 1 and 32,000 characters is required.");
    }
    try {
      const receipt = await assistantIntake.accept(session.userId, parsed.data.message, key);
      broadcast({ type: "assistant.request.received", data: receipt.request });
      return reply.code(202).send(receipt);
    } catch (error) {
      if (error instanceof AssistantIntakeError) return apiError(reply, 409, error.code, error.message);
      throw error;
    }
  });

  app.get("/api/v1/assistant/requests", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session) return;
    const parsed = assistantRequestQuerySchema.safeParse(request.query);
    if (!parsed.success) return apiError(reply, 400, "invalid_assistant_request_filter", "The request limit is invalid.");
    return assistantIntake.list(session.userId, parsed.data.limit);
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const key = idempotencyKey(request, reply);
    if (key === "") return;
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, "invalid_project", "Project name or description is invalid.");
    try {
      const project = kernel.createProject(session.userId, parsed.data, key);
      broadcast({ type: "project.created", data: project });
      return reply.code(201).send(project);
    } catch (error) {
      return kernelApiError(reply, error);
    }
  });

  app.get("/api/v1/projects", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session) return;
    return kernel.listProjects(session.userId);
  });

  app.get<{ Params: { id: string } }>("/api/v1/projects/:id", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session) return;
    try {
      return kernel.getProjectDetail(request.params.id, session.userId);
    } catch (error) {
      return kernelApiError(reply, error);
    }
  });

  app.post("/api/v1/goals", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const key = idempotencyKey(request, reply);
    if (key === "") return;
    const parsed = createGoalSchema.safeParse(request.body);
    if (!parsed.success) {
      return apiError(reply, 400, "invalid_goal", "A Goal needs a title, desired outcome and completion criteria.");
    }
    try {
      const goal = kernel.createGoal(session.userId, parsed.data, key);
      broadcast({ type: "goal.accepted", data: goal });
      return reply.code(201).send(goal);
    } catch (error) {
      return kernelApiError(reply, error);
    }
  });

  app.get("/api/v1/goals", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session) return;
    const parsed = listGoalsQuerySchema.safeParse(request.query);
    if (!parsed.success) return apiError(reply, 400, "invalid_goal_filter", "Goal filters are invalid.");
    return kernel.listGoals(session.userId, parsed.data);
  });

  app.get<{ Params: { id: string } }>("/api/v1/goals/:id", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session) return;
    try {
      return kernel.getGoal(request.params.id, session.userId);
    } catch (error) {
      return kernelApiError(reply, error);
    }
  });

  const goalAction = (action: "pause" | "resume" | "cancel") => async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const key = idempotencyKey(request, reply);
    if (key === "") return;
    const parsed = goalActionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return apiError(reply, 400, "invalid_goal_action", "The Goal action is invalid.");
    try {
      const reason = parsed.data.reason;
      const goal = action === "pause"
        ? kernel.pauseGoal(request.params.id, session.userId, reason, key)
        : action === "resume"
          ? kernel.resumeGoal(request.params.id, session.userId, reason, key)
          : kernel.cancelGoal(request.params.id, session.userId, reason, key);
      const eventType = action === "pause" ? "goal.paused" : action === "resume" ? "goal.resumed" : "goal.cancelled";
      broadcast({ type: eventType, data: goal });
      return goal;
    } catch (error) {
      return kernelApiError(reply, error);
    }
  };

  app.post<{ Params: { id: string } }>("/api/v1/goals/:id/pause", goalAction("pause"));
  app.post<{ Params: { id: string } }>("/api/v1/goals/:id/resume", goalAction("resume"));
  app.post<{ Params: { id: string } }>("/api/v1/goals/:id/cancel", goalAction("cancel"));

  app.post<{ Params: { id: string } }>("/api/v1/goals/:id/progress", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const key = idempotencyKey(request, reply);
    if (key === "") return;
    const parsed = progressGoalSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, "invalid_goal_progress", "Goal progress is invalid.");
    try {
      const goal = kernel.recordGoalProgress(
        request.params.id,
        session.userId,
        parsed.data.detail,
        parsed.data.progress,
        key,
      );
      broadcast({ type: "goal.progressed", data: goal });
      return goal;
    } catch (error) {
      return kernelApiError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/goals/:id/block", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const key = idempotencyKey(request, reply);
    if (key === "") return;
    const parsed = blockGoalSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, "invalid_goal_block", "A blocked Goal needs a reason.");
    try {
      const goal = kernel.blockGoal(request.params.id, session.userId, parsed.data.reason, key);
      broadcast({ type: "goal.blocked", data: goal });
      return goal;
    } catch (error) {
      return kernelApiError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/goals/:id/complete", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const parsed = completeGoalSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, "invalid_goal_completion", "Completion needs evidence and a reason.");
    try {
      const goal = kernel.completeGoal(
        request.params.id,
        session.userId,
        parsed.data.evidenceRefs,
        parsed.data.reason,
      );
      broadcast({ type: "goal.completed", data: goal });
      return goal;
    } catch (error) {
      return kernelApiError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/goals/:id/events", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session) return;
    const parsed = eventQuerySchema.safeParse(request.query);
    if (!parsed.success) return apiError(reply, 400, "invalid_event_filter", "Event filters are invalid.");
    try {
      return kernel.listGoalEvents(request.params.id, session.userId, parsed.data.limit);
    } catch (error) {
      return kernelApiError(reply, error);
    }
  });

  app.post("/api/v1/commitments", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const key = idempotencyKey(request, reply);
    if (key === "") return;
    const parsed = createCommitmentSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, "invalid_commitment", "Commitment details are invalid.");
    try {
      const commitment = kernel.createCommitment(session.userId, parsed.data, key);
      broadcast({ type: "commitment.created", data: commitment });
      return reply.code(201).send(commitment);
    } catch (error) {
      return kernelApiError(reply, error);
    }
  });

  app.get("/api/v1/commitments", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session) return;
    const parsed = listCommitmentsQuerySchema.safeParse(request.query);
    if (!parsed.success) return apiError(reply, 400, "invalid_commitment_filter", "Commitment filters are invalid.");
    return kernel.listCommitments(session.userId, parsed.data);
  });

  const commitmentAction = (target: "FULFILLED" | "CANCELLED") => async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const key = idempotencyKey(request, reply);
    if (key === "") return;
    const parsed = commitmentActionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return apiError(reply, 400, "invalid_commitment_action", "Commitment action is invalid.");
    try {
      const commitment = kernel.transitionCommitment(
        request.params.id,
        session.userId,
        target,
        parsed.data.evidenceRefs ?? [],
        key,
      );
      broadcast({ type: target === "FULFILLED" ? "commitment.fulfilled" : "commitment.cancelled", data: commitment });
      return commitment;
    } catch (error) {
      return kernelApiError(reply, error);
    }
  };

  app.post<{ Params: { id: string } }>("/api/v1/commitments/:id/fulfill", commitmentAction("FULFILLED"));
  app.post<{ Params: { id: string } }>("/api/v1/commitments/:id/cancel", commitmentAction("CANCELLED"));

  app.get("/api/v1/portfolio", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session) return;
    const timezone = database.getSettings(settingsDefaults()).timezone;
    return kernel.portfolio(session.userId, timezone);
  });

  app.post("/api/v1/approvals", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const parsed = requestApprovalSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, "invalid_approval", "Approval request is invalid.");
    try {
      const approval = kernel.requestApproval(session.userId, parsed.data, session.userId);
      broadcast({ type: "approval.requested", data: approval });
      return reply.code(201).send(approval);
    } catch (error) {
      return kernelApiError(reply, error);
    }
  });

  app.get("/api/v1/approvals", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session) return;
    return kernel.listApprovals(session.userId);
  });

  app.post<{ Params: { id: string } }>("/api/v1/approvals/:id/decision", async (request, reply) => {
    const session = requireSession(request, reply, database);
    if (!session || !requireCsrf(request, reply, session)) return;
    const parsed = approvalDecisionSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, "invalid_approval_decision", "Approval decision is invalid.");
    try {
      const approval = kernel.decideApproval(
        request.params.id,
        session.userId,
        parsed.data.decision,
        parsed.data.reason,
      );
      broadcast({ type: parsed.data.decision === "APPROVED" ? "approval.approved" : "approval.rejected", data: approval });
      return approval;
    } catch (error) {
      return kernelApiError(reply, error);
    }
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
