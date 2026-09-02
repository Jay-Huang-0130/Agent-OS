import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentDatabase } from "./database.js";
import { TrackedModelRuntime, type ModelOption, type ModelRunRequest, type ModelRunResult, type ModelRuntime } from "./modelRuntime.js";
import { PublicHttpWatcherFetcher, WatcherError, WatcherService, type WatcherFetcher } from "./phase7Runtime.js";
import { ResponsibilityKernel } from "./responsibilityKernel.js";

class SequenceFetcher implements WatcherFetcher {
  calls = 0;
  constructor(private readonly contents: Array<string | Error>) {}
  async fetch(url: string) {
    this.calls += 1;
    const value = this.contents.shift();
    if (value instanceof Error) throw value;
    return { content: value ?? "", contentType: "application/json", finalUrl: url };
  }
}

class SemanticRuntime implements ModelRuntime {
  calls = 0;
  async run<T>(request: ModelRunRequest<T>): Promise<ModelRunResult<T>> {
    this.calls += 1;
    const output = request.parse({ summary: "價格欄位有實質變更。", material: true });
    return { runId: `semantic-${this.calls}`, provider: "fake", model: "fake", threadId: "thread", turnId: "turn",
      output, usage: { inputTokens: 40, outputTokens: 10, cachedInputTokens: 0, reasoningTokens: 0 }, durationMs: 2 };
  }
  async interrupt(): Promise<boolean> { return false; }
  async listModels(): Promise<ModelOption[]> { return []; }
}

function fixture(fetcher: WatcherFetcher, runtime?: ModelRuntime, notify?: (value: unknown) => void) {
  const database = new AgentDatabase(":memory:");
  const owner = database.createOwner("Owner", "hash", "salt");
  const kernel = new ResponsibilityKernel(database, { reconcileOnStart: false });
  const goal = kernel.createGoal(owner.id, { title: "監看公開資料", desiredOutcome: "來源變更時通知",
    completionCriteria: ["變更有 Evidence"], autonomy: "ACT_WITHIN_POLICY" });
  let now = new Date("2026-09-02T00:00:00.000Z");
  const service = new WatcherService(database, kernel, fetcher, runtime ? new TrackedModelRuntime(database, runtime) : undefined, notify as never, () => now);
  return { database, owner, kernel, goal, service, setNow: (value: string) => { now = new Date(value); } };
}

test("Phase 7 migration creates durable watcher storage", () => {
  const database = new AgentDatabase(":memory:");
  try {
    assert.deepEqual(database.migrationVersions(), [1, 2, 3, 4, 5, 6, 7]);
    const tables = database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'watcher%'").all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((item) => item.name).sort(), ["watcher_checkpoints", "watcher_notifications", "watcher_observations", "watchers"]);
  } finally { database.close(); }
});

test("public HTTP fetcher blocks loopback sources before making a request", async () => {
  await assert.rejects(() => new PublicHttpWatcherFetcher().fetch("http://127.0.0.1/private"),
    (error: unknown) => error instanceof WatcherError && error.code === "invalid_source");
});

test("unchanged watcher checks persist observations with zero model calls and zero notifications", async () => {
  const fetcher = new SequenceFetcher(['{"price":100,"name":"item"}', '{"name":"item","price":100}']);
  const runtime = new SemanticRuntime();
  const notifications: unknown[] = [];
  const { database, owner, goal, service, setNow } = fixture(fetcher, runtime, (value) => notifications.push(value));
  try {
    const watcher = service.create(owner.id, { goalId: goal.id, sourceUrl: "https://example.com/feed.json",
      intervalSeconds: 60, semanticReview: true, modelTokenBudget: 1_000 });
    assert.equal((await service.runNow(watcher.id, owner.id)).status, "INITIAL");
    setNow("2026-09-02T00:01:00.000Z");
    const unchanged = await service.runNow(watcher.id, owner.id);
    assert.equal(unchanged.status, "UNCHANGED");
    assert.equal(runtime.calls, 0);
    assert.equal(notifications.length, 0);
    assert.equal(service.detail(watcher.id, owner.id).checkpoints.length, 1);
    assert.equal(service.detail(watcher.id, owner.id).observations.length, 2);
  } finally { database.close(); }
});

test("changed watcher stores a Delta, spends bounded semantic tokens and notifies once", async () => {
  const fetcher = new SequenceFetcher(['{"price":100}', '{"price":90}']);
  const runtime = new SemanticRuntime();
  const notifications: unknown[] = [];
  const { database, owner, goal, service, setNow } = fixture(fetcher, runtime, (value) => notifications.push(value));
  try {
    const watcher = service.create(owner.id, { goalId: goal.id, sourceUrl: "https://example.com/feed.json",
      intervalSeconds: 60, semanticReview: true, modelTokenBudget: 100 });
    await service.runNow(watcher.id, owner.id);
    setNow("2026-09-02T00:01:00.000Z");
    const changed = await service.runNow(watcher.id, owner.id);
    assert.equal(changed.status, "CHANGED");
    assert.equal(changed.modelTokens, 50);
    assert.equal(changed.summary, "價格欄位有實質變更。");
    assert.equal(runtime.calls, 1);
    assert.equal(notifications.length, 1);
    const detail = service.detail(watcher.id, owner.id);
    assert.equal(detail.checkpoints.length, 2);
    assert.equal(detail.modelTokensUsed, 50);
    assert.equal(detail.notifications.length, 1);
    assert.equal(detail.observations[0]?.evidence[0]?.kind, "HTTP_SNAPSHOT");
  } finally { database.close(); }
});

test("fetch failures back off without losing or completing the Goal", async () => {
  const fetcher = new SequenceFetcher([new Error("network down"), new Error("still down"), new Error("still down")]);
  const notifications: unknown[] = [];
  const { database, owner, kernel, goal, service, setNow } = fixture(fetcher, undefined, (value) => notifications.push(value));
  try {
    const watcher = service.create(owner.id, { goalId: goal.id, sourceUrl: "https://example.com/feed",
      intervalSeconds: 60, semanticReview: false });
    await service.runNow(watcher.id, owner.id);
    setNow("2026-09-02T00:01:00.000Z");
    await service.runNow(watcher.id, owner.id);
    setNow("2026-09-02T00:03:00.000Z");
    await service.runNow(watcher.id, owner.id);
    const detail = service.detail(watcher.id, owner.id);
    assert.equal(detail.consecutiveFailures, 3);
    assert.equal(detail.status, "ACTIVE");
    assert.equal(kernel.getGoal(goal.id, owner.id).status, "ACTIVE");
    assert.equal(notifications.length, 1);
    assert.match(detail.notifications[0]?.detail ?? "", /Goal 仍保留/u);
  } finally { database.close(); }
});

test("finite hybrid watcher completes only at the horizon with durable evidence", async () => {
  const fetcher = new SequenceFetcher(["first", "second"]);
  const { database, owner, kernel, goal, service, setNow } = fixture(fetcher);
  try {
    const watcher = service.create(owner.id, { goalId: goal.id, sourceUrl: "https://example.com/report",
      intervalSeconds: 60, semanticReview: false, endAt: "2026-09-02T00:01:00.000Z" });
    await service.runNow(watcher.id, owner.id);
    assert.equal(kernel.getGoal(goal.id, owner.id).status, "ACTIVE");
    setNow("2026-09-02T00:01:00.000Z");
    await service.runNow(watcher.id, owner.id);
    assert.equal(service.detail(watcher.id, owner.id).status, "COMPLETED");
    assert.equal(kernel.getGoal(goal.id, owner.id).status, "COMPLETED");
    assert.equal(service.detail(watcher.id, owner.id).observations.some((item) => item.status === "FINAL_REVIEW"), true);
  } finally { database.close(); }
});
