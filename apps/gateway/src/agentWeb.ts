import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentDatabase } from "./database.js";
import type { ResponsibilityKernel } from "./responsibilityKernel.js";

const execFileAsync = promisify(execFile);

export const browserToolNames = ["web.open", "web.snapshot", "web.click", "web.find", "web.download"] as const;
export type BrowserToolName = typeof browserToolNames[number];
export type BrowserChallengeType = "LOGIN" | "MFA" | "CAPTCHA" | "UNKNOWN";

export interface BrowserAdapterHealth {
  ready: boolean;
  protocol: string | null;
  humanUrl: string | null;
  capabilities: string[];
  detail?: string;
}

export interface BrowserAdapterSession { sessionRef: string; profileRef: string }

export interface BrowserAdapter {
  health(): Promise<BrowserAdapterHealth>;
  acquire(input: { taskId: string; profileRef?: string }): Promise<BrowserAdapterSession>;
  release(sessionRef: string): Promise<void>;
  pause(sessionRef: string): Promise<void>;
  resume(sessionRef: string): Promise<void>;
  navigate(sessionRef: string, url: string): Promise<Record<string, unknown>>;
  snapshot(sessionRef: string): Promise<Record<string, unknown>>;
  act(sessionRef: string, action: Record<string, unknown>): Promise<Record<string, unknown>>;
  download(sessionRef: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  probeAuthentication(sessionRef: string, origin: string): Promise<boolean>;
  takeoverUrl(sessionRef: string): Promise<string>;
}

export class BrowserAdapterError extends Error {
  constructor(readonly code: "unavailable" | "protocol_error" | "busy" | "unsafe_input", message: string) {
    super(message);
    this.name = "BrowserAdapterError";
  }
}

export class BrowserAuthenticationRequired extends Error {
  constructor(readonly challengeType: BrowserChallengeType, readonly origin: string,
    readonly checkpoint: Record<string, unknown>) {
    super(`Browser authentication is required for ${origin}.`);
    this.name = "BrowserAuthenticationRequired";
  }
}

export interface BrowserChallengeRecord {
  id: string;
  goalId: string;
  taskId: string;
  sessionId: string;
  type: BrowserChallengeType;
  origin: string;
  status: "PENDING" | "TAKEN_OVER" | "COMPLETED" | "EXPIRED" | "CANCELLED";
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
}

export class BrowserTaskWaitingForAuth extends Error {
  constructor(readonly challenge: BrowserChallengeRecord) {
    super(`Task is waiting for ${challenge.type.toLowerCase()} at ${challenge.origin}.`);
    this.name = "BrowserTaskWaitingForAuth";
  }
}

function parseInfo(value: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of value.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function scrubSecrets<T>(value: T): T {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([key]) => !/(password|passwd|cookie|authorization|secret|token|credential|mfaCode)/iu.test(key))
      .map(([key, nested]) => [key, visit(nested)]));
  };
  return visit(value) as T;
}

/** Adapter for Agent Web's machine-readable `adapter request` protocol. */
export class AgentWebCliAdapter implements BrowserAdapter {
  constructor(private readonly controller: string, private readonly timeoutMs = 30_000) {}

  private async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    try {
      const { stdout } = await execFileAsync(this.controller, ["adapter", "request", JSON.stringify({ method, params })], {
        timeout: this.timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      });
      const response = JSON.parse(stdout.trim()) as Record<string, unknown>;
      if (response.ok === false) {
        const error = (response.error ?? {}) as Record<string, unknown>;
        if (error.code === "AUTH_REQUIRED") {
          const rawType = String(error.type);
          throw new BrowserAuthenticationRequired(
            ["LOGIN", "MFA", "CAPTCHA"].includes(rawType) ? rawType as BrowserChallengeType : "UNKNOWN",
            String(error.origin ?? "unknown"), scrubSecrets((error.checkpoint ?? {}) as Record<string, unknown>));
        }
        throw new BrowserAdapterError("protocol_error", String(error.message ?? "Agent Web rejected the request."));
      }
      return (response.result ?? response) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof BrowserAuthenticationRequired || error instanceof BrowserAdapterError) throw error;
      throw new BrowserAdapterError("unavailable", error instanceof Error ? error.message : "Agent Web is unavailable.");
    }
  }

  async health(): Promise<BrowserAdapterHealth> {
    try {
      const { stdout } = await execFileAsync(this.controller, ["info"], { timeout: 10_000, windowsHide: true });
      const info = parseInfo(stdout);
      const protocol = info.AGENT_CONTROL_PROTOCOL ?? null;
      const ready = info.READY === "true" && info.AGENT_CONTROL_AVAILABLE === "true" && protocol === "agent-web-adapter-v1";
      return { ready, protocol, humanUrl: info.HUMAN_URL ?? null, capabilities: ready ? [...browserToolNames] : [],
        detail: ready ? "Agent Web adapter is ready." : "Agent Web is installed without the Phase 8 control adapter." };
    } catch (error) {
      return { ready: false, protocol: null, humanUrl: null, capabilities: [],
        detail: error instanceof Error ? error.message : "Agent Web is unavailable." };
    }
  }

  async acquire(input: { taskId: string; profileRef?: string }): Promise<BrowserAdapterSession> {
    const result = await this.request("session.acquire", input);
    if (typeof result.sessionRef !== "string" || typeof result.profileRef !== "string") {
      throw new BrowserAdapterError("protocol_error", "Agent Web returned invalid opaque session references.");
    }
    return { sessionRef: result.sessionRef, profileRef: result.profileRef };
  }
  async release(sessionRef: string): Promise<void> { await this.request("session.release", { sessionRef }); }
  async pause(sessionRef: string): Promise<void> { await this.request("session.pause", { sessionRef }); }
  async resume(sessionRef: string): Promise<void> { await this.request("session.resume", { sessionRef }); }
  navigate(sessionRef: string, url: string): Promise<Record<string, unknown>> { return this.request("page.navigate", { sessionRef, url }); }
  snapshot(sessionRef: string): Promise<Record<string, unknown>> { return this.request("page.snapshot", { sessionRef }); }
  act(sessionRef: string, action: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("page.act", { sessionRef, action: scrubSecrets(action) });
  }
  download(sessionRef: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("downloads.wait", { sessionRef, ...scrubSecrets(input) });
  }
  async probeAuthentication(sessionRef: string, origin: string): Promise<boolean> {
    return (await this.request("auth.probe", { sessionRef, origin })).authenticated === true;
  }
  async takeoverUrl(sessionRef: string): Promise<string> {
    const result = await this.request("session.takeoverUrl", { sessionRef });
    if (typeof result.url !== "string") throw new BrowserAdapterError("protocol_error", "Agent Web did not return a takeover URL.");
    return result.url;
  }
}

function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function text(row: Record<string, unknown>, key: string): string { return String(row[key] ?? ""); }
function nullable(row: Record<string, unknown>, key: string): string | null { return row[key] == null ? null : String(row[key]); }

export interface BrowserToolContext { ownerUserId: string; goalId: string; taskId: string }

export class BrowserPhase8Service {
  private healthState: BrowserAdapterHealth = { ready: false, protocol: null, humanUrl: null, capabilities: [] };
  private readonly tools = new Set<string>();

  constructor(private readonly database: AgentDatabase, private readonly kernel: ResponsibilityKernel,
    private readonly adapter: BrowserAdapter, private readonly notify?: (item: Record<string, unknown>) => void) {}

  async initialize(): Promise<void> {
    this.healthState = await this.adapter.health();
    this.tools.clear();
    if (this.healthState.ready) for (const name of browserToolNames) this.tools.add(name);
    this.expireChallenges();
    if (this.healthState.ready) {
      const sessions = this.database.db.prepare(`SELECT * FROM browser_sessions
        WHERE status IN ('ACTIVE', 'WAITING_AUTH') AND control_mode != 'USER'`).all() as Array<Record<string, unknown>>;
      for (const session of sessions) {
        try {
          const rebound = await this.adapter.acquire({ taskId: text(session, "task_id"), profileRef: text(session, "profile_ref") });
          this.database.db.prepare("UPDATE browser_sessions SET adapter_session_ref = ?, profile_ref = ?, updated_at = ? WHERE id = ?")
            .run(rebound.sessionRef, rebound.profileRef, new Date().toISOString(), text(session, "id"));
        } catch { /* Keep the durable reference; a later health refresh can reconcile it. */ }
      }
    }
  }
  health(): BrowserAdapterHealth { return { ...this.healthState, capabilities: [...this.healthState.capabilities] }; }
  availableTools(): ReadonlySet<string> { return this.tools; }
  has(name: string): boolean { return this.tools.has(name); }

  private assertContext(context: BrowserToolContext): void {
    const row = this.database.db.prepare(`SELECT 1 FROM tasks t JOIN goals g ON g.id = t.goal_id
      WHERE t.id = ? AND t.goal_id = ? AND g.owner_user_id = ?`).get(context.taskId, context.goalId, context.ownerUserId);
    if (!row) throw new BrowserAdapterError("unsafe_input", "Browser tool context does not belong to the owner.");
  }

  private async session(context: BrowserToolContext): Promise<Record<string, unknown>> {
    this.assertContext(context);
    const existing = this.database.db.prepare("SELECT * FROM browser_sessions WHERE task_id = ?").get(context.taskId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.control_mode !== "AGENT" || existing.status !== "ACTIVE") {
        throw new BrowserAdapterError("busy", "The browser session is reserved for user authentication.");
      }
      const currentToken = nullable(existing, "lease_token");
      const lease = currentToken ? this.kernel.renewLease(currentToken, context.taskId, 5 * 60_000)
        : this.kernel.acquireLease("browser_session", text(existing, "id"), context.taskId, 5 * 60_000);
      if (!lease) throw new BrowserAdapterError("busy", "The browser session lease belongs to another controller.");
      if (lease.token !== currentToken) {
        this.database.db.prepare("UPDATE browser_sessions SET lease_token = ?, updated_at = ? WHERE id = ?")
          .run(lease.token, new Date().toISOString(), text(existing, "id"));
        existing.lease_token = lease.token;
      }
      return existing;
    }
    const remote = await this.adapter.acquire({ taskId: context.taskId });
    const now = new Date().toISOString();
    const id = randomUUID();
    const lease = this.kernel.acquireLease("browser_session", id, context.taskId, 5 * 60_000);
    if (!lease) { await this.adapter.release(remote.sessionRef); throw new BrowserAdapterError("busy", "Browser session is already leased."); }
    this.database.db.prepare(`INSERT INTO browser_sessions
      (id, owner_user_id, task_id, adapter_session_ref, profile_ref, control_mode, status, lease_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'AGENT', 'ACTIVE', ?, ?, ?)`)
      .run(id, context.ownerUserId, context.taskId, remote.sessionRef, remote.profileRef, lease.token, now, now);
    return this.database.db.prepare("SELECT * FROM browser_sessions WHERE id = ?").get(id) as Record<string, unknown>;
  }

  async execute(name: string, args: Record<string, unknown>, context: BrowserToolContext): Promise<unknown> {
    if (!this.has(name)) throw new BrowserAdapterError("unavailable", `Browser tool ${name} is not available.`);
    const session = await this.session(context);
    const sessionRef = text(session, "adapter_session_ref");
    try {
      if (name === "web.open") {
        if (typeof args.url !== "string" || !/^https?:\/\//iu.test(args.url)) throw new BrowserAdapterError("unsafe_input", "web.open requires an HTTP(S) URL.");
        return await this.adapter.navigate(sessionRef, args.url);
      }
      if (name === "web.snapshot") return await this.adapter.snapshot(sessionRef);
      if (name === "web.click") {
        if (typeof args.selector !== "string" || !args.selector.trim()) throw new BrowserAdapterError("unsafe_input", "web.click requires a selector.");
        return await this.adapter.act(sessionRef, { type: "click", selector: args.selector });
      }
      if (name === "web.find") {
        if (typeof args.query !== "string" || !args.query.trim()) throw new BrowserAdapterError("unsafe_input", "web.find requires a query.");
        return await this.adapter.act(sessionRef, { type: "find", query: args.query });
      }
      if (name === "web.download") return await this.adapter.download(sessionRef, args);
      throw new BrowserAdapterError("unsafe_input", `Unknown browser tool: ${name}`);
    } catch (error) {
      if (!(error instanceof BrowserAuthenticationRequired)) throw error;
      throw new BrowserTaskWaitingForAuth(await this.createChallenge(context, session, error));
    }
  }

  private async createChallenge(context: BrowserToolContext, session: Record<string, unknown>, error: BrowserAuthenticationRequired): Promise<BrowserChallengeRecord> {
    await this.adapter.pause(text(session, "adapter_session_ref"));
    const leaseToken = nullable(session, "lease_token");
    if (leaseToken) this.kernel.releaseLease(leaseToken, context.taskId);
    const now = new Date();
    const nowIso = now.toISOString();
    const checkpointId = randomUUID();
    const version = Number((this.database.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM browser_checkpoints WHERE session_id = ?")
      .get(text(session, "id")) as { version: number }).version);
    const challengeId = randomUUID();
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.database.db.prepare(`INSERT INTO browser_checkpoints
        (id, session_id, task_id, version, url, checkpoint_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(checkpointId, text(session, "id"), context.taskId, version, error.origin, JSON.stringify(scrubSecrets(error.checkpoint)), nowIso);
      this.database.db.prepare(`INSERT INTO browser_auth_challenges
        (id, owner_user_id, goal_id, task_id, session_id, checkpoint_id, type, origin, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`)
        .run(challengeId, context.ownerUserId, context.goalId, context.taskId, text(session, "id"), checkpointId,
          error.challengeType, error.origin, nowIso, new Date(now.getTime() + 15 * 60_000).toISOString());
      this.database.db.prepare(`UPDATE browser_sessions SET origin = ?, control_mode = 'PAUSED', status = 'WAITING_AUTH',
        lease_token = NULL, updated_at = ? WHERE id = ?`).run(error.origin, nowIso, text(session, "id"));
      this.database.db.prepare(`INSERT INTO browser_notifications
        (id, owner_user_id, goal_id, task_id, challenge_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), context.ownerUserId, context.goalId, context.taskId, challengeId, "瀏覽器需要你完成登入",
          `${error.origin} 需要 ${error.challengeType}；Agent 已安全停止。`, nowIso);
      this.database.db.exec("COMMIT");
    } catch (cause) { this.database.db.exec("ROLLBACK"); throw cause; }
    const challenge = this.requireChallenge(challengeId, context.ownerUserId);
    this.notify?.({ id: challenge.id, title: "瀏覽器需要你完成登入", detail: `${challenge.origin} 需要 ${challenge.type}；Agent 已安全停止。`,
      kind: "attention", createdAt: challenge.createdAt, read: false, goalId: challenge.goalId, taskId: challenge.taskId,
      challengeId: challenge.id });
    return challenge;
  }

  listChallenges(ownerUserId: string): BrowserChallengeRecord[] {
    this.expireChallenges();
    return (this.database.db.prepare(`SELECT * FROM browser_auth_challenges WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 200`)
      .all(ownerUserId) as Array<Record<string, unknown>>).map(challengeFromRow);
  }

  private requireChallenge(id: string, ownerUserId: string): BrowserChallengeRecord {
    const row = this.database.db.prepare("SELECT * FROM browser_auth_challenges WHERE id = ? AND owner_user_id = ?")
      .get(id, ownerUserId) as Record<string, unknown> | undefined;
    if (!row) throw new BrowserAdapterError("unsafe_input", "Browser authentication challenge was not found.");
    return challengeFromRow(row);
  }

  async beginTakeover(id: string, ownerUserId: string, gatewayOrigin: string): Promise<{ challenge: BrowserChallengeRecord; takeoverUrl: string; expiresAt: string }> {
    await this.initialize();
    const challenge = this.requireChallenge(id, ownerUserId);
    if (!this.healthState.ready) throw new BrowserAdapterError("unavailable", "Browser capability is unavailable.");
    if (!new Set(["PENDING", "TAKEN_OVER"]).has(challenge.status)) throw new BrowserAdapterError("busy", `Challenge cannot be taken over from ${challenge.status}.`);
    const session = this.database.db.prepare("SELECT * FROM browser_sessions WHERE id = ?").get(challenge.sessionId) as Record<string, unknown>;
    await this.adapter.pause(text(session, "adapter_session_ref"));
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const now = new Date().toISOString();
    this.database.db.prepare(`INSERT INTO browser_takeover_tokens
      (token_hash, challenge_id, owner_user_id, origin, profile_ref, task_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tokenHash(token), id, ownerUserId, gatewayOrigin, text(session, "profile_ref"), challenge.taskId, expiresAt, now);
    this.database.db.prepare("UPDATE browser_auth_challenges SET status = 'TAKEN_OVER' WHERE id = ?").run(id);
    this.database.db.prepare("UPDATE browser_sessions SET control_mode = 'USER', updated_at = ? WHERE id = ?").run(now, challenge.sessionId);
    return { challenge: this.requireChallenge(id, ownerUserId), takeoverUrl: `${gatewayOrigin}/api/v1/browser/takeovers/${token}`, expiresAt };
  }

  async resolveTakeover(token: string, ownerUserId: string, gatewayOrigin?: string): Promise<{ url: string; challengeId: string }> {
    const now = new Date().toISOString();
    const row = this.database.db.prepare(`SELECT bt.*, bs.adapter_session_ref FROM browser_takeover_tokens bt
      JOIN browser_auth_challenges bc ON bc.id = bt.challenge_id JOIN browser_sessions bs ON bs.id = bc.session_id
      WHERE bt.token_hash = ? AND bt.owner_user_id = ? AND bt.revoked_at IS NULL AND bt.expires_at > ?
        AND (? IS NULL OR bt.origin = ?)`)
      .get(tokenHash(token), ownerUserId, now, gatewayOrigin ?? null, gatewayOrigin ?? null) as Record<string, unknown> | undefined;
    if (!row) throw new BrowserAdapterError("unsafe_input", "Takeover link is invalid or expired.");
    this.database.db.prepare("UPDATE browser_takeover_tokens SET consumed_at = COALESCE(consumed_at, ?) WHERE token_hash = ?")
      .run(now, tokenHash(token));
    return { url: await this.adapter.takeoverUrl(text(row, "adapter_session_ref")), challengeId: text(row, "challenge_id") };
  }

  async completeChallenge(id: string, ownerUserId: string): Promise<BrowserChallengeRecord> {
    await this.initialize();
    if (!this.healthState.ready) throw new BrowserAdapterError("unavailable", "Browser capability is unavailable.");
    const challenge = this.requireChallenge(id, ownerUserId);
    if (!new Set(["PENDING", "TAKEN_OVER"]).has(challenge.status)) throw new BrowserAdapterError("busy", `Challenge cannot complete from ${challenge.status}.`);
    const row = this.database.db.prepare("SELECT * FROM browser_sessions WHERE id = ?").get(challenge.sessionId) as Record<string, unknown>;
    if (!await this.adapter.probeAuthentication(text(row, "adapter_session_ref"), challenge.origin)) {
      throw new BrowserAdapterError("busy", "Authentication is not complete yet.");
    }
    await this.adapter.resume(text(row, "adapter_session_ref"));
    const lease = this.kernel.acquireLease("browser_session", challenge.sessionId, challenge.taskId, 5 * 60_000);
    if (!lease) throw new BrowserAdapterError("busy", "Browser session could not be reacquired by the Agent.");
    const now = new Date().toISOString();
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.database.db.prepare("UPDATE browser_auth_challenges SET status = 'COMPLETED', completed_at = ? WHERE id = ?").run(now, id);
      this.database.db.prepare("UPDATE browser_takeover_tokens SET revoked_at = ? WHERE challenge_id = ? AND revoked_at IS NULL").run(now, id);
      this.database.db.prepare(`UPDATE browser_sessions SET control_mode = 'AGENT', status = 'ACTIVE', lease_token = ?, updated_at = ? WHERE id = ?`)
        .run(lease.token, now, challenge.sessionId);
      this.database.db.prepare(`INSERT OR IGNORE INTO wake_conditions
        (id, goal_id, task_id, type, status, due_at, payload_json, misfire_policy, idempotency_key, created_at)
        VALUES (?, ?, ?, 'AUTH_COMPLETED', 'PENDING', ?, ?, 'RUN_ONCE_NOW', ?, ?)`)
        .run(randomUUID(), challenge.goalId, challenge.taskId, now, JSON.stringify({ challengeId: id }), `auth:${id}`, now);
      this.database.db.exec("COMMIT");
    } catch (error) { this.database.db.exec("ROLLBACK"); throw error; }
    this.kernel.resumeTaskAfterAuthentication(challenge.taskId, ownerUserId, id);
    this.kernel.resumeGoalAfterAuthentication(challenge.goalId, ownerUserId, id);
    return this.requireChallenge(id, ownerUserId);
  }

  expireChallenges(at = new Date()): number {
    const now = at.toISOString();
    const result = this.database.db.prepare(`UPDATE browser_auth_challenges SET status = 'EXPIRED'
      WHERE status IN ('PENDING', 'TAKEN_OVER') AND expires_at <= ?`).run(now);
    this.database.db.prepare(`UPDATE browser_takeover_tokens SET revoked_at = COALESCE(revoked_at, ?)
      WHERE revoked_at IS NULL AND expires_at <= ?`).run(now, now);
    this.database.db.prepare(`UPDATE browser_sessions SET control_mode = 'PAUSED', updated_at = ?
      WHERE id IN (SELECT session_id FROM browser_auth_challenges WHERE status = 'EXPIRED') AND status = 'WAITING_AUTH'`).run(now);
    return Number(result.changes);
  }
}

function challengeFromRow(row: Record<string, unknown>): BrowserChallengeRecord {
  return { id: text(row, "id"), goalId: text(row, "goal_id"), taskId: text(row, "task_id"), sessionId: text(row, "session_id"),
    type: text(row, "type") as BrowserChallengeType, status: text(row, "status") as BrowserChallengeRecord["status"],
    origin: text(row, "origin"), createdAt: text(row, "created_at"), expiresAt: text(row, "expires_at"),
    completedAt: nullable(row, "completed_at") };
}
