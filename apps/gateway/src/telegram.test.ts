import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentDatabase } from "./database.js";
import {
  TelegramApiError,
  TelegramChannelService,
  type TelegramBotApi,
  type TelegramUpdate,
} from "./telegram.js";

class FakeTelegramApi implements TelegramBotApi {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  failNextSend = false;

  async getMe() { return { id: 99, username: "agent_os_test_bot", first_name: "Agent OS" }; }
  async getUpdates(): Promise<TelegramUpdate[]> { return []; }
  async sendMessage(chatId: string, text: string): Promise<{ messageId: number }> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new TelegramApiError(503, "temporary Telegram failure");
    }
    this.sent.push({ chatId, text });
    return { messageId: this.sent.length };
  }
}

function fixture() {
  const database = new AgentDatabase(":memory:");
  const owner = database.createOwner("Owner", "hash", "salt");
  const accepted: Array<{ ownerUserId: string; message: string; key?: string; conversationId?: string }> = [];
  const intake = {
    async accept(ownerUserId: string, message: string, key?: string, options?: { conversationId?: string }) {
      accepted.push({ ownerUserId, message, ...(key ? { key } : {}),
        ...(options?.conversationId ? { conversationId: options.conversationId } : {}) });
      return { assistantMessage: `回答：${message}` } as never;
    },
  };
  const api = new FakeTelegramApi();
  let now = new Date("2026-09-16T00:00:00.000Z");
  const service = new TelegramChannelService(database, intake, api, () => now);
  return { database, owner, accepted, api, service, advance(ms: number) { now = new Date(now.getTime() + ms); } };
}

test("migration 9 creates durable Telegram channel tables", () => {
  const database = new AgentDatabase(":memory:");
  try {
    assert.equal(database.migrationVersions().at(-1), 9);
    const tables = database.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'telegram_%'`)
      .all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((item) => item.name).sort(), [
      "telegram_bindings", "telegram_deliveries", "telegram_pairing_codes", "telegram_state", "telegram_updates",
    ]);
  } finally { database.close(); }
});

test("private Telegram pairing routes messages through Assistant Intake and sends the reply", async () => {
  const { database, owner, accepted, api, service } = fixture();
  try {
    const pairing = service.createPairing(owner.id);
    await service.processUpdate({ update_id: 10, message: { message_id: 1, text: `/start ${pairing.code}`,
      chat: { id: 456, type: "private" }, from: { id: 123, first_name: "Jay" } } });
    assert.match(api.sent[0]?.text ?? "", /成功連接 Agent-OS/u);
    assert.equal(service.status().connected, true);
    assert.equal(service.status().connectedDisplayName, "Jay");

    await service.processUpdate({ update_id: 11, message: { message_id: 2, text: "幫我整理今天的事情",
      chat: { id: 456, type: "private" }, from: { id: 123, first_name: "Jay" } } });
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.ownerUserId, owner.id);
    assert.equal(accepted[0]?.key, "telegram:update:11");
    assert.match(api.sent.at(-1)?.text ?? "", /回答：幫我整理今天的事情/u);

    await service.processUpdate({ update_id: 11, message: { message_id: 2, text: "幫我整理今天的事情",
      chat: { id: 456, type: "private" }, from: { id: 123, first_name: "Jay" } } });
    assert.equal(accepted.length, 1, "duplicate Telegram updates must not execute twice");
  } finally { database.close(); }
});

test("unpaired users cannot reach Assistant Intake", async () => {
  const { database, accepted, api, service } = fixture();
  try {
    await service.processUpdate({ update_id: 20, message: { message_id: 1, text: "執行任務",
      chat: { id: 999, type: "private" }, from: { id: 888, first_name: "Unknown" } } });
    assert.equal(accepted.length, 0);
    assert.match(api.sent[0]?.text ?? "", /尚未與 Agent-OS 配對/u);
  } finally { database.close(); }
});

test("Telegram notifications remain durable and retry transient send failures", async () => {
  const { database, owner, api, service, advance } = fixture();
  try {
    const pairing = service.createPairing(owner.id);
    await service.processUpdate({ update_id: 30, message: { message_id: 1, text: `/start ${pairing.code}`,
      chat: { id: 456, type: "private" }, from: { id: 123, first_name: "Jay" } } });
    api.failNextSend = true;
    service.notify(owner.id, { id: "weather-1", title: "每日天氣", detail: "今天可能下雨。" });
    await new Promise((resolve) => setImmediate(resolve));
    const failed = database.db.prepare("SELECT status, attempts FROM telegram_deliveries WHERE idempotency_key = ?")
      .get("telegram:notification:weather-1") as { status: string; attempts: number };
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.attempts, 1);

    advance(6_000);
    await service.flushDeliveries();
    const sent = database.db.prepare("SELECT status, attempts FROM telegram_deliveries WHERE idempotency_key = ?")
      .get("telegram:notification:weather-1") as { status: string; attempts: number };
    assert.equal(sent.status, "SENT");
    assert.equal(sent.attempts, 2);
    assert.match(api.sent.at(-1)?.text ?? "", /每日天氣/u);
  } finally { database.close(); }
});
