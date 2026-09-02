import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentDatabase } from "./database.js";
import type { ModelRunRequest, ModelRunResult, ModelRuntime } from "./modelRuntime.js";
import type { ModelOption } from "./modelRuntime.js";
import { TrackedModelRuntime } from "./modelRuntime.js";
import {
  BoundedAgentWorker,
  GoalCompiler,
  Phase6RequestRouter,
  PlanManager,
  PlanRuntime,
  buildManagerContext,
  resultEnvelopeSchema,
  type CompiledGoal,
} from "./phase6Runtime.js";
import { ResponsibilityKernel } from "./responsibilityKernel.js";

class FakeRuntime implements ModelRuntime {
  readonly calls: string[] = [];
  constructor(private readonly outputs: unknown[]) {}
  async run<T>(request: ModelRunRequest<T>): Promise<ModelRunResult<T>> {
    this.calls.push(request.purpose);
    const raw = this.outputs.shift();
    const output = request.parse(raw);
    request.onDelta?.("{", `turn-${this.calls.length}`);
    return { runId: `run-${this.calls.length}`, provider: "fake", model: "fake-model",
      threadId: `thread-${this.calls.length}`, turnId: `turn-${this.calls.length}`, output,
      usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 0 }, durationMs: 5 };
  }
  async interrupt(): Promise<boolean> { return true; }
  async listModels(): Promise<ModelOption[]> { return []; }
}

function compiledGoal(): CompiledGoal {
  return {
    title: "整理每日摘要", desiredOutcome: "每天產生可驗證摘要。", agentCommitment: ["依排程執行並回報。"],
    completionCriteria: ["摘要包含來源。"], cancellationCriteria: [], externalDependencies: [], deadline: null,
    constraints: {}, priority: { urgency: "normal" }, attentionPolicy: {},
    budget: { maxTokens: 2000 }, autonomy: "ACT_WITHIN_POLICY",
    plan: { version: 1, nodes: [{ id: "collect", title: "收集資料", kind: "ANALYSIS", dependsOn: [],
      completionCriteria: ["取得資料來源"], allowedTools: ["fetch"], maxTokens: 1000, maxDurationMs: 30_000, maxAttempts: 2 }] },
    automation: null,
  };
}

test("request router classifies question, fixed schedule, watcher and high-risk clarification without domain hardcoding", async () => {
  const runtime = new FakeRuntime([]);
  const router = new Phase6RequestRouter(runtime);
  assert.equal((await router.route({ requestId: "1", ownerUserId: "owner", message: "這是什麼？" })).executionMode, "DIRECT_RESPONSE");
  assert.equal((await router.route({ requestId: "2", ownerUserId: "owner", message: "每天九點整理一份摘要" })).executionMode, "DETERMINISTIC_AUTOMATION");
  assert.equal((await router.route({ requestId: "3", ownerUserId: "owner", message: "內容有變更時通知我" })).executionMode, "CHANGE_WATCHER");
  const risky = await router.route({ requestId: "4", ownerUserId: "owner", message: "幫我刪除所有資料" });
  assert.equal(risky.state, "NEEDS_CLARIFICATION");
  assert.equal(runtime.calls.length, 0);
});

test("ambiguous requests use structured classifier and low confidence asks instead of guessing", async () => {
  const runtime = new FakeRuntime([{ executionMode: "MULTI_TASK_PLAN", confidence: 0.55,
    reason: "Scope is ambiguous.", requiresClarification: false, clarificationQuestion: "你希望先完成哪個成果？" }]);
  const result = await new Phase6RequestRouter(runtime).route({ requestId: "r", ownerUserId: "owner", message: "處理一下這個專案" });
  assert.equal(result.state, "NEEDS_CLARIFICATION");
  assert.match(result.reason, /哪個成果/u);
  assert.deepEqual(runtime.calls, ["ROUTER"]);
});

test("Goal Compiler converts strict JSON-string metadata into a versioned Responsibility Contract", async () => {
  const runtime = new FakeRuntime([{
    title: "完成 Phase 6", desiredOutcome: "Phase 6 通過驗收。", agentCommitment: ["執行測試"],
    completionCriteria: ["所有測試通過"], cancellationCriteria: [], externalDependencies: [], deadline: null,
    constraintsJson: JSON.stringify({ scope: "phase6" }), priorityJson: JSON.stringify({ urgency: "high" }),
    attentionPolicyJson: "{}", budgetJson: JSON.stringify({ maxTokens: 3000 }), autonomy: "ASK_BEFORE_ACT",
    plan: { version: 1, nodes: [{ id: "verify", title: "執行驗收", kind: "VERIFY", dependsOn: [],
      completionCriteria: ["測試通過"], allowedTools: ["test"], maxTokens: 1000, maxDurationMs: 30_000, maxAttempts: 2 }] },
    automationJson: "",
  }]);
  const result = await new GoalCompiler(runtime).compile({ ownerUserId: "owner", requestId: "request", message: "完成 Phase 6",
    mode: "MULTI_TASK_PLAN", conversationContext: "", timezone: "Asia/Taipei" });
  assert.equal(result.plan.version, 1);
  assert.equal(result.priority.urgency, "high");
  assert.equal(result.automation, null);
});

test("Goal Compiler normalizes an incomplete automationJson for a relative reminder instead of failing", async () => {
  const timerRoute = await new Phase6RequestRouter(new FakeRuntime([])).route({
    requestId: "timer-route", ownerUserId: "owner", message: "可以幫我計時30秒嗎",
  });
  assert.equal(timerRoute.executionMode, "DETERMINISTIC_AUTOMATION");
  const runtime = new FakeRuntime([{
    title: "十秒提醒", desiredOutcome: "十秒後提醒使用者。", agentCommitment: ["按時提醒"],
    completionCriteria: ["提醒已送出"], cancellationCriteria: [], externalDependencies: [], deadline: null,
    constraintsJson: "{}", priorityJson: "{}", attentionPolicyJson: "{}", budgetJson: "{}", autonomy: "ACT_WITHIN_POLICY",
    plan: { version: 1, nodes: [{ id: "remind", title: "送出提醒", kind: "NOTIFY", dependsOn: [],
      completionCriteria: ["提醒已送出"], allowedTools: [], maxTokens: 50, maxDurationMs: 500, maxAttempts: 0 }] },
    automationJson: JSON.stringify({ executionMode: "DETERMINISTIC_AUTOMATION", schedule: { kind: "ONCE", at: "later" } }),
  }]);
  const now = new Date("2026-09-01T12:00:00.000Z");
  const result = await new GoalCompiler(runtime).compile({ ownerUserId: "owner", requestId: "reminder", message: "可以幫我計時30秒嗎",
    mode: "DETERMINISTIC_AUTOMATION", conversationContext: "", timezone: "Asia/Taipei", now });
  assert.equal(result.automation?.executionMode, "AI_EXECUTION");
  assert.deepEqual(result.automation?.schedule, { kind: "ONCE", at: "2026-09-01T12:00:30.000Z" });
  assert.equal(result.plan.nodes[0]?.maxTokens, 100);
  assert.equal(result.plan.nodes[0]?.maxDurationMs, 1_000);
  assert.equal(result.plan.nodes[0]?.maxAttempts, 1);
});

test("Plan Runtime persists versioned Plan IR and manager receives envelopes instead of worker transcripts", () => {
  const database = new AgentDatabase(":memory:");
  const owner = database.createOwner("Owner", "hash", "salt");
  const kernel = new ResponsibilityKernel(database, { reconcileOnStart: false });
  try {
    const materialized = new PlanRuntime(kernel).materialize(owner.id, "request-1", compiledGoal());
    assert.equal(materialized.plan.version, 1);
    assert.equal(materialized.tasks.length, 1);
    const detail = kernel.getGoalDetail(materialized.goal.id, owner.id);
    assert.equal(detail.plans[0]?.id, materialized.plan.id);
    assert.equal(detail.tasks[0]?.id, materialized.tasks[0]?.id);
    assert.equal(detail.wakes.length, 1);
    assert.equal(detail.timeline.some((event) => event.type === "plan.activated"), true);
    kernel.transitionTask(materialized.tasks[0]!.id, "READY", owner.id);
    kernel.transitionTask(materialized.tasks[0]!.id, "LEASED", owner.id);
    kernel.transitionTask(materialized.tasks[0]!.id, "RUNNING", owner.id);
    kernel.transitionTask(materialized.tasks[0]!.id, "VERIFYING", owner.id, { summary: "done", evidence: ["source:1"] });
    const context = buildManagerContext(database, materialized.goal.id);
    assert.equal(JSON.stringify(context).includes("transcript"), false);
    assert.equal((context.taskEnvelopes as unknown[]).length, 1);
    assert.equal(kernel.getGoal(materialized.goal.id, owner.id).status, "ACTIVE");
  } finally { database.close(); }
});

test("bounded worker rejects prose-only completion and accepts a Result Envelope with evidence", async () => {
  const runtime = new FakeRuntime([
    { status: "COMPLETED", summary: "done", outputs: [], evidence: [], nextActions: [] },
    { status: "COMPLETED", summary: "verified", outputs: [{ name: "report", value: "ok" }],
      evidence: [{ kind: "TEST", reference: "test:phase6", summary: "Acceptance test passed." }], nextActions: [] },
  ]);
  const result = await new BoundedAgentWorker(runtime).execute({ ownerUserId: "owner", goalId: "goal", taskId: "task",
    objective: "Verify the output", context: {}, allowedTools: [], budget: { maxTokens: 1000, maxDurationMs: 30_000, maxAttempts: 2 } });
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(runtime.calls, ["WORKER", "WORKER"]);
});

test("Plan Manager runs a Task Packet through verification and persists only the Result Envelope", async () => {
  const database = new AgentDatabase(":memory:");
  const owner = database.createOwner("Owner", "hash", "salt");
  const kernel = new ResponsibilityKernel(database, { reconcileOnStart: false });
  const runtime = new FakeRuntime([{ status: "COMPLETED", summary: "verified", outputs: [{ name: "report", value: "ok" }],
    evidence: [{ kind: "TEST", reference: "test:manager", summary: "Manager test passed." }], nextActions: [] }]);
  try {
    const materialized = new PlanRuntime(kernel).materialize(owner.id, "manager-request", compiledGoal());
    await new PlanManager(database, kernel, runtime).executeTask(owner.id, materialized.tasks[0]!.id);
    const task = kernel.getTask(materialized.tasks[0]!.id);
    assert.equal(task.status, "COMPLETED");
    assert.equal(resultEnvelopeSchema.parse(task.result).evidence[0]?.reference, "test:manager");
    assert.equal(kernel.getGoal(materialized.goal.id, owner.id).status, "ACTIVE");
  } finally { database.close(); }
});

test("tracked model runtime records normalized usage without changing Goal ownership", async () => {
  const database = new AgentDatabase(":memory:");
  const owner = database.createOwner("Owner", "hash", "salt");
  const runtime = new TrackedModelRuntime(database, new FakeRuntime([{ message: "hello" }]));
  try {
    const result = await runtime.run({ purpose: "DIRECT_RESPONSE", ownerUserId: owner.id, instructions: "reply", input: "hello",
      outputSchema: { type: "object" }, parse: (value) => value as { message: string } });
    const row = database.db.prepare("SELECT status, usage_json FROM model_runs WHERE id = ?").get(result.runId) as Record<string, unknown>;
    assert.equal(row.status, "COMPLETED");
    assert.equal(JSON.parse(String(row.usage_json)).outputTokens, 20);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM goals").get()!.count, 0);
  } finally { database.close(); }
});
