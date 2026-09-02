import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { AgentDatabase } from "./database.js";
import type { ModelRuntime } from "./modelRuntime.js";
import { ResponsibilityKernel, type GoalRecord } from "./responsibilityKernel.js";

export interface WatcherRecord {
  id: string;
  goalId: string;
  ownerUserId: string;
  sourceUrl: string;
  intervalSeconds: number;
  semanticReview: boolean;
  selectedModel: string | null;
  modelTokenBudget: number;
  modelTokensUsed: number;
  endAt: string | null;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  lastFingerprint: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WatcherObservation {
  id: string;
  watcherId: string;
  status: "INITIAL" | "UNCHANGED" | "CHANGED" | "FAILED" | "FINAL_REVIEW";
  previousFingerprint: string | null;
  fingerprint: string | null;
  delta: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
  summary: string;
  modelRunId: string | null;
  modelTokens: number;
  checkedAt: string;
}

export interface WatcherNotification {
  id: string;
  title: string;
  detail: string;
  kind: "task";
  createdAt: string;
  read: boolean;
  goalId: string;
  watcherId: string;
}

export interface WatcherSnapshot extends WatcherRecord {
  checkpoints: Array<{ version: number; fingerprint: string; contentType: string; fetchedAt: string }>;
  observations: WatcherObservation[];
  notifications: WatcherNotification[];
}

export interface WatcherFetcher {
  fetch(url: string): Promise<{ content: string; contentType: string; etag?: string; lastModified?: string; finalUrl?: string }>;
}

export class WatcherError extends Error {
  constructor(readonly code: "not_found" | "invalid_source" | "conflict" | "fetch_failed", message: string) {
    super(message);
    this.name = "WatcherError";
  }
}

const semanticSchema = z.object({ summary: z.string().min(1).max(8_000), material: z.boolean() }).strict();
const semanticJsonSchema = { type: "object", additionalProperties: false, required: ["summary", "material"],
  properties: { summary: { type: "string" }, material: { type: "boolean" } } };

export class PublicHttpWatcherFetcher implements WatcherFetcher {
  constructor(private readonly timeoutMs = 15_000, private readonly maxBytes = 512 * 1024) {}

  async fetch(input: string): Promise<{ content: string; contentType: string; etag?: string; lastModified?: string; finalUrl: string }> {
    let url = new URL(input);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertPublicUrl(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref();
      try {
        const response = await globalThis.fetch(url, { redirect: "manual", signal: controller.signal,
          headers: { "user-agent": "Agent-OS-Watcher/0.1", accept: "application/json,text/html,text/plain;q=0.9,*/*;q=0.1" } });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirects === 3) throw new WatcherError("fetch_failed", "Watcher source redirected too many times.");
          url = new URL(location, url);
          continue;
        }
        if (!response.ok) throw new WatcherError("fetch_failed", `Watcher source returned HTTP ${response.status}.`);
        const length = Number(response.headers.get("content-length") ?? 0);
        if (length > this.maxBytes) throw new WatcherError("fetch_failed", "Watcher source exceeds the 512 KiB limit.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > this.maxBytes) throw new WatcherError("fetch_failed", "Watcher source exceeds the 512 KiB limit.");
        return { content: new TextDecoder().decode(bytes), contentType: response.headers.get("content-type") ?? "text/plain",
          ...(response.headers.get("etag") ? { etag: response.headers.get("etag") as string } : {}),
          ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified") as string } : {}),
          finalUrl: url.toString() };
      } finally { clearTimeout(timer); }
    }
    throw new WatcherError("fetch_failed", "Watcher source could not be fetched.");
  }
}

export class WatcherService {
  private readonly workerId = randomUUID();
  private readonly jobs = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: AgentDatabase,
    private readonly kernel: ResponsibilityKernel,
    private readonly fetcher: WatcherFetcher = new PublicHttpWatcherFetcher(),
    private readonly runtime?: ModelRuntime,
    private readonly notify?: (notification: WatcherNotification) => void,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  create(ownerUserId: string, input: { goalId: string; sourceUrl: string; intervalSeconds: number; semanticReview?: boolean;
    selectedModel?: string; modelTokenBudget?: number; endAt?: string }, idempotencyKey?: string): WatcherRecord {
    this.kernel.getGoal(input.goalId, ownerUserId);
    const sourceUrl = canonicalHttpUrl(input.sourceUrl);
    if (idempotencyKey) {
      const existing = this.database.db.prepare("SELECT * FROM watchers WHERE owner_user_id = ? AND idempotency_key = ?")
        .get(ownerUserId, idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        const record = watcherFromRow(existing);
        if (record.goalId !== input.goalId || record.sourceUrl !== sourceUrl) throw new WatcherError("conflict", "Idempotency-Key was reused for another watcher.");
        return record;
      }
    }
    const now = this.clock();
    const intervalSeconds = Math.max(60, Math.min(604_800, Math.round(input.intervalSeconds)));
    const endAt = input.endAt ? new Date(input.endAt) : undefined;
    if (endAt && (!Number.isFinite(endAt.getTime()) || endAt <= now)) throw new WatcherError("invalid_source", "Watcher endAt must be in the future.");
    const record: WatcherRecord = { id: randomUUID(), goalId: input.goalId, ownerUserId, sourceUrl, intervalSeconds,
      semanticReview: input.semanticReview ?? false, selectedModel: input.selectedModel ?? null,
      modelTokenBudget: Math.max(0, Math.min(1_000_000, Math.round(input.modelTokenBudget ?? 20_000))), modelTokensUsed: 0,
      endAt: endAt?.toISOString() ?? null, status: "ACTIVE", lastFingerprint: null, lastCheckedAt: null,
      nextCheckAt: now.toISOString(), consecutiveFailures: 0, lastError: null, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    this.database.db.prepare(`INSERT INTO watchers
      (id, goal_id, owner_user_id, source_url, interval_seconds, semantic_review, selected_model, model_token_budget,
       model_tokens_used, end_at, status, next_check_at, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ACTIVE', ?, ?, ?, ?)`)
      .run(record.id, record.goalId, ownerUserId, sourceUrl, intervalSeconds, record.semanticReview ? 1 : 0,
        record.selectedModel, record.modelTokenBudget, record.endAt, record.nextCheckAt, idempotencyKey ?? null, record.createdAt, record.updatedAt);
    const pendingTasks = this.kernel.getGoalDetail(record.goalId, ownerUserId).tasks.filter((task) => task.status === "PENDING");
    for (const task of pendingTasks) {
      this.kernel.transitionTask(task.id, "READY", "watcher");
      this.kernel.transitionTask(task.id, "LEASED", "watcher");
      this.kernel.transitionTask(task.id, "RUNNING", "watcher");
      this.kernel.transitionTask(task.id, "WAITING", "watcher", { summary: "由 Phase 7 Watcher 持續執行。", watcherId: record.id });
    }
    this.kernel.recordGoalEvent(record.goalId, ownerUserId, "watcher.created", { watcherId: record.id, sourceUrl,
      intervalSeconds, semanticReview: record.semanticReview, endAt: record.endAt }, "watcher");
    return record;
  }

  list(ownerUserId: string): WatcherRecord[] {
    return (this.database.db.prepare("SELECT * FROM watchers WHERE owner_user_id = ? ORDER BY updated_at DESC")
      .all(ownerUserId) as Array<Record<string, unknown>>).map(watcherFromRow);
  }

  detail(id: string, ownerUserId: string): WatcherSnapshot {
    const watcher = this.require(id, ownerUserId);
    const checkpoints = this.database.db.prepare(`SELECT version, fingerprint, content_type, fetched_at FROM watcher_checkpoints
      WHERE watcher_id = ? ORDER BY version DESC LIMIT 50`).all(id) as Array<Record<string, unknown>>;
    const observations = this.database.db.prepare(`SELECT * FROM watcher_observations WHERE watcher_id = ?
      ORDER BY checked_at DESC, rowid DESC LIMIT 100`).all(id) as Array<Record<string, unknown>>;
    const notifications = this.database.db.prepare(`SELECT * FROM watcher_notifications WHERE watcher_id = ?
      ORDER BY created_at DESC LIMIT 100`).all(id) as Array<Record<string, unknown>>;
    return { ...watcher, checkpoints: checkpoints.map((row) => ({ version: Number(row.version), fingerprint: String(row.fingerprint),
      contentType: String(row.content_type), fetchedAt: String(row.fetched_at) })), observations: observations.map(observationFromRow),
      notifications: notifications.map(notificationFromRow) };
  }

  cancel(id: string, ownerUserId: string): WatcherRecord {
    const watcher = this.require(id, ownerUserId);
    if (watcher.status === "CANCELLED") return watcher;
    const now = this.clock().toISOString();
    this.database.db.prepare("UPDATE watchers SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, id);
    this.kernel.recordGoalEvent(watcher.goalId, ownerUserId, "watcher.cancelled", { watcherId: id }, "watcher");
    return this.require(id, ownerUserId);
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.jobs.values()]);
  }

  async runNow(id: string, ownerUserId?: string): Promise<WatcherObservation> {
    const watcher = ownerUserId ? this.require(id, ownerUserId) : this.requireAny(id);
    const goal = this.kernel.getGoal(watcher.goalId, watcher.ownerUserId);
    if (watcher.status !== "ACTIVE" || goal.status !== "ACTIVE") {
      throw new WatcherError("conflict", `Watcher cannot run while Watcher is ${watcher.status} and Goal is ${goal.status}.`);
    }
    const active = this.jobs.get(id);
    if (active) {
      await active;
      return this.latestObservation(id);
    }
    const lease = this.kernel.acquireLease("watcher", id, this.workerId, 60_000);
    if (!lease) throw new WatcherError("conflict", "Watcher is already being checked by another worker.");
    const job = this.execute(watcher).finally(() => { this.kernel.releaseLease(lease.token, this.workerId); this.jobs.delete(id); });
    this.jobs.set(id, job);
    await job;
    return this.latestObservation(id);
  }

  private async scan(): Promise<void> {
    const rows = this.database.db.prepare(`SELECT w.id FROM watchers w JOIN goals g ON g.id = w.goal_id
      WHERE w.status = 'ACTIVE' AND g.status = 'ACTIVE' AND w.next_check_at <= ?
      ORDER BY w.next_check_at LIMIT 10`).all(this.clock().toISOString()) as Array<Record<string, unknown>>;
    for (const row of rows) if (!this.jobs.has(String(row.id))) void this.runNow(String(row.id)).catch(() => undefined);
  }

  private async execute(watcher: WatcherRecord): Promise<void> {
    if (watcher.status !== "ACTIVE") return;
    const now = this.clock();
    const goal = this.kernel.getGoal(watcher.goalId, watcher.ownerUserId);
    if (["CANCELLED", "COMPLETED"].includes(goal.status)) {
      this.database.db.prepare("UPDATE watchers SET status = ?, updated_at = ? WHERE id = ?")
        .run(goal.status === "COMPLETED" ? "COMPLETED" : "CANCELLED", now.toISOString(), watcher.id);
      return;
    }
    if (goal.status !== "ACTIVE") {
      this.database.db.prepare("UPDATE watchers SET next_check_at = ?, updated_at = ? WHERE id = ?")
        .run(new Date(now.getTime() + watcher.intervalSeconds * 1_000).toISOString(), now.toISOString(), watcher.id);
      return;
    }
    try {
      const fetched = await this.fetcher.fetch(watcher.sourceUrl);
      const normalized = normalizeContent(fetched.content, fetched.contentType);
      const fingerprint = createHash("sha256").update(normalized).digest("hex");
      const previous = this.database.db.prepare(`SELECT * FROM watcher_checkpoints WHERE watcher_id = ?
        ORDER BY version DESC LIMIT 1`).get(watcher.id) as Record<string, unknown> | undefined;
      const previousFingerprint = previous ? String(previous.fingerprint) : null;
      const status: WatcherObservation["status"] = !previous ? "INITIAL" : previousFingerprint === fingerprint ? "UNCHANGED" : "CHANGED";
      const delta = deterministicDelta(previous ? String(previous.normalized_content) : "", normalized);
      const evidence = [{ kind: "HTTP_SNAPSHOT", reference: fetched.finalUrl ?? watcher.sourceUrl,
        summary: `SHA-256 ${fingerprint}; ${normalized.length} normalized characters; fetched ${now.toISOString()}.` }];
      let summary = status === "INITIAL" ? "已建立第一個基準 checkpoint。"
        : status === "UNCHANGED" ? "來源沒有變更；只更新 checkpoint 時間，不呼叫模型也不通知。"
          : `偵測到來源變更：${String(delta.summary)}`;
      let modelRunId: string | null = null;
      let modelTokens = 0;
      if (status === "CHANGED" && watcher.semanticReview && this.runtime && watcher.modelTokenBudget - watcher.modelTokensUsed >= 100) {
        try {
          const remaining = watcher.modelTokenBudget - watcher.modelTokensUsed;
          const result = await this.runtime.run({ purpose: "WAKE", ownerUserId: watcher.ownerUserId, goalId: watcher.goalId,
            ...(watcher.selectedModel ? { model: watcher.selectedModel } : {}), maxOutputTokens: Math.max(100, Math.min(2_000, remaining)), timeoutMs: 60_000,
            instructions: "Analyze only the supplied deterministic watcher delta. State what materially changed in the user's language. Do not claim access beyond the supplied snapshots.",
            input: `Source: ${watcher.sourceUrl}\nPrevious:\n${String(previous?.normalized_content ?? "").slice(0, 12_000)}\n\nCurrent:\n${normalized.slice(0, 12_000)}`,
            outputSchema: semanticJsonSchema, parse: (value) => semanticSchema.parse(value) });
          modelRunId = result.runId;
          modelTokens = result.usage.inputTokens + result.usage.outputTokens;
          summary = result.output.summary;
        } catch (error) {
          summary = `${summary}（語意分析暫時不可用，已保留 deterministic Delta：${error instanceof Error ? error.message : String(error)}）`;
        }
      }
      const observationId = randomUUID();
      this.database.db.exec("BEGIN IMMEDIATE");
      try {
        if (status !== "UNCHANGED") {
          const versionRow = this.database.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM watcher_checkpoints WHERE watcher_id = ?")
            .get(watcher.id) as { version: number };
          this.database.db.prepare(`INSERT INTO watcher_checkpoints
            (id, watcher_id, version, fingerprint, normalized_content, content_type, source_etag, source_last_modified, fetched_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), watcher.id, Number(versionRow.version), fingerprint, normalized, fetched.contentType,
              fetched.etag ?? null, fetched.lastModified ?? null, now.toISOString(), now.toISOString());
        }
        this.database.db.prepare(`INSERT INTO watcher_observations
          (id, watcher_id, status, previous_fingerprint, fingerprint, delta_json, evidence_json, summary, model_run_id, model_tokens, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(observationId, watcher.id, status, previousFingerprint, fingerprint, JSON.stringify(delta), JSON.stringify(evidence),
            summary, modelRunId, modelTokens, now.toISOString());
        this.database.db.prepare(`UPDATE watchers SET last_fingerprint = ?, last_checked_at = ?, next_check_at = ?,
          consecutive_failures = 0, last_error = NULL, model_tokens_used = model_tokens_used + ?, updated_at = ? WHERE id = ?`)
          .run(fingerprint, now.toISOString(), new Date(now.getTime() + watcher.intervalSeconds * 1_000).toISOString(),
            modelTokens, now.toISOString(), watcher.id);
        this.database.db.exec("COMMIT");
      } catch (error) { this.database.db.exec("ROLLBACK"); throw error; }
      this.kernel.recordGoalEvent(watcher.goalId, watcher.ownerUserId, `watcher.${status.toLowerCase()}`,
        { watcherId: watcher.id, observationId, fingerprint, previousFingerprint, modelTokens }, "watcher");
      if (status === "CHANGED") this.createNotification(watcher, observationId, "監看來源有變更", summary, now);
      if (watcher.endAt && now >= new Date(watcher.endAt)) this.finish(watcher, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failures = watcher.consecutiveFailures + 1;
      const retrySeconds = Math.min(86_400, watcher.intervalSeconds * 2 ** Math.min(failures - 1, 8));
      const observationId = randomUUID();
      this.database.db.prepare(`INSERT INTO watcher_observations
        (id, watcher_id, status, delta_json, evidence_json, summary, model_tokens, checked_at)
        VALUES (?, ?, 'FAILED', '{}', '[]', ?, 0, ?)`).run(observationId, watcher.id, message, now.toISOString());
      this.database.db.prepare(`UPDATE watchers SET last_checked_at = ?, next_check_at = ?, consecutive_failures = ?,
        last_error = ?, updated_at = ? WHERE id = ?`).run(now.toISOString(), new Date(now.getTime() + retrySeconds * 1_000).toISOString(),
          failures, message.slice(0, 1_000), now.toISOString(), watcher.id);
      this.kernel.recordGoalEvent(watcher.goalId, watcher.ownerUserId, "watcher.failed",
        { watcherId: watcher.id, observationId, failures, retrySeconds, error: message.slice(0, 500) }, "watcher");
      if (failures % 3 === 0) this.createNotification(watcher, observationId, "監看來源持續失敗",
        `已連續失敗 ${failures} 次；Goal 仍保留，下一次會使用退避排程重試。${message}`, now);
    }
  }

  private finish(watcher: WatcherRecord, now: Date): void {
    const observations = this.database.db.prepare("SELECT COUNT(*) AS total, SUM(status = 'CHANGED') AS changes FROM watcher_observations WHERE watcher_id = ?")
      .get(watcher.id) as Record<string, unknown>;
    const summary = `監看期間完成：共 ${Number(observations.total)} 次檢查、${Number(observations.changes ?? 0)} 次變更。`;
    const observationId = randomUUID();
    this.database.db.prepare(`INSERT INTO watcher_observations
      (id, watcher_id, status, delta_json, evidence_json, summary, model_tokens, checked_at)
      VALUES (?, ?, 'FINAL_REVIEW', ?, ?, ?, 0, ?)`)
      .run(observationId, watcher.id, JSON.stringify({ total: Number(observations.total), changes: Number(observations.changes ?? 0) }),
        JSON.stringify([{ kind: "WATCHER_HISTORY", reference: `watcher:${watcher.id}`, summary }]), summary, now.toISOString());
    this.database.db.prepare("UPDATE watchers SET status = 'COMPLETED', updated_at = ? WHERE id = ?").run(now.toISOString(), watcher.id);
    const envelope = { status: "COMPLETED", summary, outputs: [{ name: "watcher", value: watcher.id }],
      evidence: [{ kind: "OBSERVATION", reference: `watcher:${watcher.id}`, summary }], nextActions: [] };
    for (const task of this.kernel.getGoalDetail(watcher.goalId, watcher.ownerUserId).tasks.filter((item) => item.status === "WAITING")) {
      this.kernel.transitionTask(task.id, "RUNNING", "watcher");
      this.kernel.transitionTask(task.id, "VERIFYING", "watcher", envelope);
      this.kernel.transitionTask(task.id, "COMPLETED", "watcher", envelope);
    }
    const goal: GoalRecord = this.kernel.completeGoal(watcher.goalId, watcher.ownerUserId, [`watcher:${watcher.id}`], summary);
    this.createNotification(watcher, observationId, "長期監看已完成", goal.stateReason ?? summary, now);
  }

  private createNotification(watcher: WatcherRecord, observationId: string, title: string, body: string, now: Date): void {
    const notification: WatcherNotification = { id: randomUUID(), title, detail: body, kind: "task", createdAt: now.toISOString(),
      read: false, goalId: watcher.goalId, watcherId: watcher.id };
    this.database.db.prepare(`INSERT INTO watcher_notifications
      (id, owner_user_id, goal_id, watcher_id, observation_id, title, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(notification.id, watcher.ownerUserId, watcher.goalId, watcher.id, observationId, title, body, notification.createdAt);
    this.notify?.(notification);
  }

  private require(id: string, ownerUserId: string): WatcherRecord {
    const row = this.database.db.prepare("SELECT * FROM watchers WHERE id = ? AND owner_user_id = ?").get(id, ownerUserId) as Record<string, unknown> | undefined;
    if (!row) throw new WatcherError("not_found", "Watcher not found.");
    return watcherFromRow(row);
  }

  private requireAny(id: string): WatcherRecord {
    const row = this.database.db.prepare("SELECT * FROM watchers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new WatcherError("not_found", "Watcher not found.");
    return watcherFromRow(row);
  }

  private latestObservation(id: string): WatcherObservation {
    const row = this.database.db.prepare("SELECT * FROM watcher_observations WHERE watcher_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new WatcherError("not_found", "Watcher has no observation.");
    return observationFromRow(row);
  }
}

function canonicalHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    url.hash = "";
    return url.toString();
  } catch { throw new WatcherError("invalid_source", "Watcher source must be an HTTP or HTTPS URL without embedded credentials."); }
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new WatcherError("invalid_source", "Only public HTTP/HTTPS sources are allowed.");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new WatcherError("invalid_source", "Private, loopback and link-local watcher sources are blocked.");
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/u, "");
  if (isIP(normalized) === 4) {
    const [a = 0, b = 0] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || a >= 224;
  }
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/u.test(normalized) || normalized.startsWith("ff");
}

function normalizeContent(content: string, contentType: string): string {
  const trimmed = content.replace(/\u0000/gu, "").trim();
  if (/json/iu.test(contentType)) {
    try { return stableJson(JSON.parse(trimmed)); } catch { /* Preserve invalid JSON as text. */ }
  }
  const withoutMarkup = /html|xml/iu.test(contentType)
    ? trimmed.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ").replace(/<[^>]+>/gu, " ") : trimmed;
  return withoutMarkup.replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&").replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">").replace(/\s+/gu, " ").trim();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function deterministicDelta(previous: string, current: string): Record<string, unknown> {
  if (!previous) return { kind: "INITIAL", previousLength: 0, currentLength: current.length, summary: "建立初始快照" };
  if (previous === current) return { kind: "UNCHANGED", previousLength: previous.length, currentLength: current.length, summary: "內容相同" };
  let prefix = 0;
  while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < current.length - prefix
    && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix += 1;
  const removed = previous.slice(prefix, previous.length - suffix);
  const added = current.slice(prefix, current.length - suffix);
  return { kind: "CHANGED", previousLength: previous.length, currentLength: current.length, prefixLength: prefix,
    removedLength: removed.length, addedLength: added.length, removedPreview: removed.slice(0, 1_000), addedPreview: added.slice(0, 1_000),
    summary: `新增 ${added.length} 字元、移除 ${removed.length} 字元` };
}

function watcherFromRow(row: Record<string, unknown>): WatcherRecord {
  return { id: String(row.id), goalId: String(row.goal_id), ownerUserId: String(row.owner_user_id), sourceUrl: String(row.source_url),
    intervalSeconds: Number(row.interval_seconds), semanticReview: Number(row.semantic_review) === 1,
    selectedModel: row.selected_model == null ? null : String(row.selected_model), modelTokenBudget: Number(row.model_token_budget),
    modelTokensUsed: Number(row.model_tokens_used), endAt: row.end_at == null ? null : String(row.end_at), status: String(row.status) as WatcherRecord["status"],
    lastFingerprint: row.last_fingerprint == null ? null : String(row.last_fingerprint), lastCheckedAt: row.last_checked_at == null ? null : String(row.last_checked_at),
    nextCheckAt: String(row.next_check_at), consecutiveFailures: Number(row.consecutive_failures), lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function observationFromRow(row: Record<string, unknown>): WatcherObservation {
  return { id: String(row.id), watcherId: String(row.watcher_id), status: String(row.status) as WatcherObservation["status"],
    previousFingerprint: row.previous_fingerprint == null ? null : String(row.previous_fingerprint),
    fingerprint: row.fingerprint == null ? null : String(row.fingerprint), delta: parseObject(row.delta_json),
    evidence: parseArray(row.evidence_json), summary: String(row.summary), modelRunId: row.model_run_id == null ? null : String(row.model_run_id),
    modelTokens: Number(row.model_tokens), checkedAt: String(row.checked_at) };
}

function notificationFromRow(row: Record<string, unknown>): WatcherNotification {
  return { id: String(row.id), title: String(row.title), detail: String(row.body), kind: "task", createdAt: String(row.created_at),
    read: row.read_at != null, goalId: String(row.goal_id), watcherId: String(row.watcher_id) };
}

function parseObject(value: unknown): Record<string, unknown> {
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

function parseArray(value: unknown): Array<Record<string, unknown>> {
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : []; } catch { return []; }
}
