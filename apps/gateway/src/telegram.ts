import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentDatabase } from "./database.js";
import type { AssistantIntakeService } from "./assistantIntake.js";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: { id: number; type: string };
  from?: TelegramUser;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramBotIdentity {
  id: number;
  username?: string;
  first_name: string;
}

export interface TelegramBotApi {
  getMe(signal?: AbortSignal): Promise<TelegramBotIdentity>;
  getUpdates(offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<{ messageId: number }>;
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export class HttpTelegramBotApi implements TelegramBotApi {
  private readonly baseUrl: string;

  constructor(token: string, apiOrigin = "https://api.telegram.org") {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token)) throw new Error("Telegram Bot Token format is invalid.");
    this.baseUrl = `${apiOrigin.replace(/\/$/u, "")}/bot${token}`;
  }

  getMe(signal?: AbortSignal): Promise<TelegramBotIdentity> {
    return this.call<TelegramBotIdentity>("getMe", {}, signal);
  }

  getUpdates(offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      ...(offset === undefined ? {} : { offset }),
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    }, signal);
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<{ messageId: number }> {
    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }, signal);
    return { messageId: result.message_id };
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new TelegramApiError(0, "Telegram network request failed.");
    }
    const payload = await response.json().catch(() => null) as TelegramEnvelope<T> | null;
    if (!response.ok || !payload?.ok || payload.result === undefined) {
      throw new TelegramApiError(payload?.error_code ?? response.status,
        payload?.description ?? `Telegram ${method} failed.`, payload?.parameters?.retry_after);
    }
    return payload.result;
  }
}

export interface TelegramChannelStatus {
  configured: boolean;
  running: boolean;
  botUsername: string | null;
  connected: boolean;
  connectedDisplayName: string | null;
  lastError: string | null;
}

export interface TelegramNotification {
  id: string;
  title: string;
  detail: string;
}

type Clock = () => Date;

export class TelegramChannelService {
  private running = false;
  private stopped = false;
  private bot: TelegramBotIdentity | undefined;
  private lastError: string | null = null;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private flushing = false;

  constructor(
    private readonly database: AgentDatabase,
    private readonly intake: Pick<AssistantIntakeService, "accept">,
    private readonly api: TelegramBotApi,
    private readonly clock: Clock = () => new Date(),
  ) {
    this.database.db.prepare("UPDATE telegram_deliveries SET status = 'PENDING' WHERE status = 'SENDING'").run();
  }

  start(): void {
    if (this.loop) return;
    this.stopped = false;
    this.controller = new AbortController();
    this.loop = this.run(this.controller.signal).finally(() => {
      this.running = false;
      this.loop = undefined;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    await this.loop?.catch(() => undefined);
  }

  status(): TelegramChannelStatus {
    const binding = this.database.db.prepare(
      "SELECT display_name FROM telegram_bindings ORDER BY created_at LIMIT 1",
    ).get() as { display_name: string } | undefined;
    return {
      configured: true,
      running: this.running,
      botUsername: this.bot?.username ?? null,
      connected: Boolean(binding),
      connectedDisplayName: binding?.display_name || null,
      lastError: this.lastError,
    };
  }

  setVerifiedBot(identity: TelegramBotIdentity): void {
    this.bot = identity;
  }

  createPairing(ownerUserId: string, ttlMs = 10 * 60_000): { code: string; expiresAt: string; deepLink: string | null } {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(8);
    const code = [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.database.db.prepare("DELETE FROM telegram_pairing_codes WHERE owner_user_id = ? OR expires_at <= ?")
      .run(ownerUserId, now.toISOString());
    this.database.db.prepare(`INSERT INTO telegram_pairing_codes
      (code_hash, owner_user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
      .run(hashCode(code), ownerUserId, expiresAt, now.toISOString());
    return { code, expiresAt, deepLink: this.bot?.username ? `https://t.me/${this.bot.username}?start=${code}` : null };
  }

  disconnect(ownerUserId: string): boolean {
    const changed = this.database.db.prepare("DELETE FROM telegram_bindings WHERE owner_user_id = ?").run(ownerUserId);
    this.database.db.prepare("DELETE FROM telegram_pairing_codes WHERE owner_user_id = ?").run(ownerUserId);
    return Number(changed.changes) === 1;
  }

  async sendTest(ownerUserId: string): Promise<boolean> {
    const queued = this.enqueueForOwner(ownerUserId, "Agent-OS Telegram 連線測試成功。", `telegram:test:${randomUUID()}`);
    if (queued) await this.flushDeliveries();
    return queued;
  }

  notify(ownerUserId: string, notification: TelegramNotification): void {
    const body = `${notification.title}\n\n${notification.detail}`.trim();
    if (this.enqueueForOwner(ownerUserId, body, `telegram:notification:${notification.id}`)) {
      void this.flushDeliveries();
    }
  }

  async processUpdate(update: TelegramUpdate): Promise<void> {
    const existing = this.database.db.prepare("SELECT status FROM telegram_updates WHERE update_id = ?")
      .get(update.update_id) as { status: string } | undefined;
    if (existing?.status === "PROCESSED") return;
    if (!existing) {
      this.database.db.prepare(`INSERT INTO telegram_updates (update_id, status, received_at)
        VALUES (?, 'RECEIVED', ?)`).run(update.update_id, this.clock().toISOString());
    }
    try {
      await this.handleMessage(update);
      this.database.db.prepare(`UPDATE telegram_updates SET status = 'PROCESSED', error = NULL, processed_at = ?
        WHERE update_id = ?`).run(this.clock().toISOString(), update.update_id);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
      this.database.db.prepare(`UPDATE telegram_updates SET status = 'FAILED', error = ?, processed_at = ?
        WHERE update_id = ?`).run(message, this.clock().toISOString(), update.update_id);
      throw error;
    }
  }

  async flushDeliveries(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (!this.stopped) {
        const now = this.clock();
        const row = this.database.db.prepare(`SELECT * FROM telegram_deliveries
          WHERE status IN ('PENDING', 'FAILED') AND available_at <= ? ORDER BY created_at LIMIT 1`)
          .get(now.toISOString()) as Record<string, unknown> | undefined;
        if (!row) return;
        const id = String(row.id);
        this.database.db.prepare("UPDATE telegram_deliveries SET status = 'SENDING' WHERE id = ?").run(id);
        try {
          const messageIds: number[] = [];
          for (const part of splitTelegramText(String(row.body))) {
            const sent = await this.api.sendMessage(String(row.chat_id), part, this.controller?.signal);
            messageIds.push(sent.messageId);
          }
          this.database.db.prepare(`UPDATE telegram_deliveries SET status = 'SENT', attempts = attempts + 1,
            external_message_id = ?, sent_at = ?, last_error = NULL WHERE id = ?`)
            .run(messageIds.join(","), this.clock().toISOString(), id);
        } catch (error) {
          if (this.stopped && isAbort(error)) return;
          const attempts = Number(row.attempts) + 1;
          const retryAfter = error instanceof TelegramApiError && error.retryAfterSeconds
            ? error.retryAfterSeconds : Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6));
          const availableAt = new Date(this.clock().getTime() + retryAfter * 1_000).toISOString();
          const message = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
          this.database.db.prepare(`UPDATE telegram_deliveries SET status = 'FAILED', attempts = attempts + 1,
            available_at = ?, last_error = ? WHERE id = ?`).run(availableAt, message, id);
          this.lastError = message;
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let failureDelayMs = 1_000;
    while (!this.stopped) {
      try {
        if (!this.bot) this.bot = await this.api.getMe(signal);
        this.running = true;
        this.lastError = null;
        const offset = this.readOffset();
        const updates = await this.api.getUpdates(offset, 25, signal);
        for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
          try { await this.processUpdate(update); }
          catch (error) { this.lastError = error instanceof Error ? error.message : String(error); }
          this.writeOffset(update.update_id + 1);
        }
        await this.flushDeliveries();
        failureDelayMs = 1_000;
      } catch (error) {
        if (this.stopped && isAbort(error)) return;
        this.running = false;
        this.lastError = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
        await abortableDelay(failureDelayMs, signal).catch(() => undefined);
        failureDelayMs = Math.min(30_000, failureDelayMs * 2);
      }
    }
  }

  private async handleMessage(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.from || message.chat.type !== "private" || !message.text?.trim()) return;
    const text = message.text.trim();
    const start = text.match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]+))?$/u);
    if (start) {
      const code = start[1];
      if (code && this.consumePairing(code, message.from, String(message.chat.id))) {
        this.enqueueRaw(String(message.chat.id), this.database.getOwner()?.id ?? "",
          "已成功連接 Agent-OS。現在可以直接傳訊息給我。輸入 /help 查看可用指令。",
          `telegram:pairing:${update.update_id}`);
      } else {
        this.enqueueUnbound(String(message.chat.id), "請先在 Agent-OS 設定頁產生 Telegram 配對碼，再使用連結或輸入 /start 配對碼。",
          `telegram:pairing-rejected:${update.update_id}`);
      }
      await this.flushDeliveries();
      return;
    }

    const binding = this.bindingFor(message.from.id, message.chat.id);
    if (!binding) {
      this.enqueueUnbound(String(message.chat.id), "這個 Telegram 帳號尚未與 Agent-OS 配對。請先到 Agent-OS 設定頁連接 Telegram。",
        `telegram:unbound:${update.update_id}`);
      await this.flushDeliveries();
      return;
    }
    if (/^\/help(?:@[A-Za-z0-9_]+)?$/u.test(text)) {
      this.enqueueRaw(String(message.chat.id), binding.ownerUserId,
        "直接傳送文字即可與 Agent-OS 對話。\n\n/help 使用說明\n/status 連線狀態\n/unlink 解除 Telegram 配對",
        `telegram:help:${update.update_id}`);
    } else if (/^\/status(?:@[A-Za-z0-9_]+)?$/u.test(text)) {
      this.enqueueRaw(String(message.chat.id), binding.ownerUserId, "Agent-OS 已連線，Telegram 通訊正常。",
        `telegram:status:${update.update_id}`);
    } else if (/^\/unlink(?:@[A-Za-z0-9_]+)?$/u.test(text)) {
      this.enqueueRaw(String(message.chat.id), binding.ownerUserId, "Telegram 配對已解除。",
        `telegram:unlink:${update.update_id}`);
      this.disconnect(binding.ownerUserId);
    } else if (text.startsWith("/")) {
      this.enqueueRaw(String(message.chat.id), binding.ownerUserId, "不支援這個指令。輸入 /help 查看使用方式。",
        `telegram:unknown-command:${update.update_id}`);
    } else {
      try {
        const receipt = await this.intake.accept(binding.ownerUserId, text, `telegram:update:${update.update_id}`, {
          conversationId: binding.conversationId,
        });
        this.enqueueRaw(String(message.chat.id), binding.ownerUserId, receipt.assistantMessage,
          `telegram:reply:${update.update_id}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "暫時無法處理訊息。";
        this.enqueueRaw(String(message.chat.id), binding.ownerUserId, `Agent-OS 處理訊息失敗：${detail}`,
          `telegram:error:${update.update_id}`);
      }
    }
    await this.flushDeliveries();
  }

  private consumePairing(code: string, user: TelegramUser, chatId: string): boolean {
    const now = this.clock().toISOString();
    const row = this.database.db.prepare(`SELECT owner_user_id FROM telegram_pairing_codes
      WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
      .get(hashCode(code.toUpperCase()), now) as { owner_user_id: string } | undefined;
    if (!row) return false;
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 200);
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.database.db.prepare("DELETE FROM telegram_bindings WHERE telegram_user_id = ? OR chat_id = ?")
        .run(String(user.id), chatId);
      this.database.db.prepare(`INSERT INTO telegram_bindings
        (owner_user_id, telegram_user_id, chat_id, display_name, conversation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_user_id) DO UPDATE SET telegram_user_id = excluded.telegram_user_id,
          chat_id = excluded.chat_id, display_name = excluded.display_name, updated_at = excluded.updated_at`)
        .run(row.owner_user_id, String(user.id), chatId, displayName, randomUUID(), now, now);
      this.database.db.prepare("UPDATE telegram_pairing_codes SET consumed_at = ? WHERE code_hash = ?")
        .run(now, hashCode(code.toUpperCase()));
      this.database.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }

  private bindingFor(userId: number, chatId: number): { ownerUserId: string; conversationId: string } | undefined {
    const row = this.database.db.prepare(`SELECT owner_user_id, conversation_id FROM telegram_bindings
      WHERE telegram_user_id = ? AND chat_id = ?`).get(String(userId), String(chatId)) as
      { owner_user_id: string; conversation_id: string } | undefined;
    return row ? { ownerUserId: row.owner_user_id, conversationId: row.conversation_id } : undefined;
  }

  private enqueueForOwner(ownerUserId: string, body: string, idempotencyKey: string): boolean {
    const binding = this.database.db.prepare("SELECT chat_id FROM telegram_bindings WHERE owner_user_id = ?")
      .get(ownerUserId) as { chat_id: string } | undefined;
    if (!binding) return false;
    this.enqueueRaw(binding.chat_id, ownerUserId, body, idempotencyKey);
    return true;
  }

  private enqueueUnbound(chatId: string, body: string, idempotencyKey: string): void {
    const owner = this.database.getOwner();
    if (!owner) return;
    this.enqueueRaw(chatId, owner.id, body, idempotencyKey);
  }

  private enqueueRaw(chatId: string, ownerUserId: string, body: string, idempotencyKey: string): void {
    if (!ownerUserId || !body.trim()) return;
    const now = this.clock().toISOString();
    this.database.db.prepare(`INSERT OR IGNORE INTO telegram_deliveries
      (id, owner_user_id, chat_id, body, status, attempts, available_at, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)`)
      .run(randomUUID(), ownerUserId, chatId, body.trim().slice(0, 32_000), now, idempotencyKey, now);
  }

  private readOffset(): number | undefined {
    const row = this.database.db.prepare("SELECT value FROM telegram_state WHERE key = 'update_offset'")
      .get() as { value: string } | undefined;
    if (!row) return undefined;
    const value = Number(row.value);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  private writeOffset(offset: number): void {
    this.database.db.prepare(`INSERT INTO telegram_state (key, value, updated_at) VALUES ('update_offset', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(String(offset), this.clock().toISOString());
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function splitTelegramText(text: string): string[] {
  const limit = 4_000;
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let index = rest.lastIndexOf("\n", limit);
    if (index < limit / 2) index = limit;
    parts.push(rest.slice(0, index));
    rest = rest.slice(index).replace(/^\n/u, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
