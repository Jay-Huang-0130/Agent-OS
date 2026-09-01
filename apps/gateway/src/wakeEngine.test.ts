import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentDatabase } from "./database.js";
import { ResponsibilityKernel } from "./responsibilityKernel.js";
import {
  AutomationService,
  CapabilityService,
  Phase5Error,
  PythonJsonExecutor,
  WakeEngine,
  type CapabilityExecutor,
} from "./wakeEngine.js";

function fixture(executor: CapabilityExecutor) {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-os-wake-engine-"));
  const database = new AgentDatabase(join(stateDir, "agent-os.db"));
  const owner = database.createOwner("Owner", "hash", "salt");
  const kernel = new ResponsibilityKernel(database, { reconcileOnStart: false });
  const goal = kernel.createGoal(owner.id, {
    title: "Generated recurring responsibility",
    desiredOutcome: "Execute the method selected by the AI Router.",
    completionCriteria: ["Occurrences remain durable and observable."],
  });
  const capabilities = new CapabilityService(database, executor);
  const automations = new AutomationService(database, capabilities);
  return { database, owner, goal, capabilities, automations };
}

const schema = {
  type: "object" as const,
  required: ["value"],
  properties: { value: { type: "string" as const } },
  additionalProperties: false,
};

test("generated deterministic automation executes with zero model calls and deduplicated notification", async () => {
  const executor: CapabilityExecutor = { async execute(_capability, input) { return input; } };
  const { database, owner, goal, capabilities, automations } = fixture(executor);
  const now = new Date("2026-09-01T01:00:00.000Z");
  try {
    const capability = await capabilities.register(owner.id, {
      name: "generated.simple-json", version: 1, sourceCode: "def main(payload):\n    return payload",
      inputSchema: schema, outputSchema: schema, permissions: ["notification:send"], risk: "LOW",
      timeoutMs: 1_000, testInput: { value: "self-test" },
    });
    automations.create(owner.id, {
      goalId: goal.id, capabilityId: capability.id, executionMode: "DETERMINISTIC_AUTOMATION",
      input: { value: "daily result" }, schedule: { kind: "ONCE", at: "2026-09-01T00:59:00.000Z" },
      timezone: "Asia/Taipei", notificationTemplate: "Result: {{value}}", misfirePolicy: "RUN_ONCE_NOW",
    });
    const delivered: string[] = [];
    const engine = new WakeEngine(database, capabilities, executor, {
      clock: () => now, notify: (item) => { delivered.push(item.detail); },
    });
    await engine.tick();
    await engine.tick();

    const usage = database.db.prepare("SELECT * FROM usage_ledger").get() as Record<string, unknown>;
    assert.equal(usage.model_calls, 0);
    assert.equal(usage.tool_calls, 1);
    assert.equal(usage.success, 1);
    assert.deepEqual(delivered, ["Result: daily result"]);
    assert.equal((database.db.prepare("SELECT status FROM goals WHERE id = ?").get(goal.id) as { status: string }).status, "ACTIVE");
  } finally { database.close(); }
});

test("RUN_LATEST_ONLY recovers one latest occurrence after downtime", async () => {
  const executor: CapabilityExecutor = { async execute(_capability, input) { return input; } };
  const { database, owner, goal, capabilities, automations } = fixture(executor);
  const now = new Date("2026-09-01T12:00:00.000Z");
  try {
    const capability = await capabilities.register(owner.id, {
      name: "generated.interval", version: 1, sourceCode: "def main(payload):\n    return payload",
      inputSchema: schema, outputSchema: schema, permissions: [], risk: "LOW", timeoutMs: 1_000,
      testInput: { value: "test" },
    });
    const automation = automations.create(owner.id, {
      goalId: goal.id, capabilityId: capability.id, executionMode: "DETERMINISTIC_AUTOMATION",
      input: { value: "latest" }, schedule: { kind: "INTERVAL", startAt: "2026-09-01T08:00:00.000Z", everySeconds: 3_600 },
      timezone: "UTC", misfirePolicy: "RUN_LATEST_ONLY",
    });
    database.db.prepare("UPDATE wake_conditions SET due_at = ? WHERE json_extract(payload_json, '$.automationId') = ?")
      .run("2026-09-01T08:00:00.000Z", automation.id);
    const engine = new WakeEngine(database, capabilities, executor, { clock: () => now, misfireGraceMs: 1_000 });
    await engine.tick();

    const occurrence = database.db.prepare("SELECT scheduled_for, status FROM wake_occurrences").get() as Record<string, unknown>;
    assert.equal(occurrence.scheduled_for, "2026-09-01T12:00:00.000Z");
    assert.equal(occurrence.status, "COMPLETED");
    const wake = database.db.prepare("SELECT due_at, status FROM wake_conditions WHERE json_extract(payload_json, '$.automationId') = ?")
      .get(automation.id) as Record<string, unknown>;
    assert.equal(wake.due_at, "2026-09-01T13:00:00.000Z");
    assert.equal(wake.status, "PENDING");
  } finally { database.close(); }
});

test("failed capability uses exponential backoff instead of a hot retry loop", async () => {
  let calls = 0;
  const executor: CapabilityExecutor = {
    async execute(_capability, input) {
      calls += 1;
      if (calls === 1) return input;
      throw new Phase5Error("network_unavailable", "temporary outage");
    },
  };
  const { database, owner, goal, capabilities, automations } = fixture(executor);
  const now = new Date("2026-09-01T01:00:00.000Z");
  try {
    const capability = await capabilities.register(owner.id, {
      name: "generated.network", version: 1, sourceCode: "def main(payload):\n    return payload",
      inputSchema: schema, outputSchema: schema, permissions: [], risk: "LOW", timeoutMs: 1_000,
      testInput: { value: "test" },
    });
    automations.create(owner.id, {
      goalId: goal.id, capabilityId: capability.id, executionMode: "DETERMINISTIC_AUTOMATION",
      input: { value: "run" }, schedule: { kind: "ONCE", at: "2026-09-01T00:59:00.000Z" },
      timezone: "UTC", misfirePolicy: "RUN_ONCE_NOW",
    });
    const engine = new WakeEngine(database, capabilities, executor, { clock: () => now, random: () => 0.5 });
    await engine.tick();
    await engine.tick();

    assert.equal(calls, 2);
    const occurrence = database.db.prepare("SELECT status, attempts, next_retry_at FROM wake_occurrences").get() as Record<string, unknown>;
    assert.equal(occurrence.status, "RETRYING");
    assert.equal(occurrence.attempts, 1);
    assert.equal(occurrence.next_retry_at, "2026-09-01T01:00:30.000Z");
  } finally { database.close(); }
});

test("unsafe generated Python is rejected before registration", async () => {
  const executor: CapabilityExecutor = { async execute() { return {}; } };
  const { database, owner, capabilities } = fixture(executor);
  try {
    await assert.rejects(() => capabilities.register(owner.id, {
      name: "generated.unsafe", version: 1,
      sourceCode: "import subprocess\ndef main(payload):\n    return subprocess.run(['sh'])",
      inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissions: [], risk: "LOW",
      timeoutMs: 1_000, testInput: {},
    }), (error: unknown) => error instanceof Phase5Error && error.code === "unsafe_capability_source");
  } finally { database.close(); }
});

test("Python JSON runner executes a validated generated script", { skip: process.platform === "win32" }, async () => {
  const executor = new PythonJsonExecutor("python3");
  const { database, owner, capabilities } = fixture(executor);
  try {
    const capability = await capabilities.register(owner.id, {
      name: "generated.real-python", version: 1,
      sourceCode: "def main(payload):\n    return {'value': payload['value'].upper()}",
      inputSchema: schema, outputSchema: schema, permissions: [], risk: "LOW", timeoutMs: 2_000,
      testInput: { value: "python" },
    });
    assert.equal(capability.status, "VALIDATED");
    const source = capabilities.getSource(capability.id, owner.id);
    assert.deepEqual(await executor.execute(source, { value: "phase five" }), { value: "PHASE FIVE" });
  } finally { database.close(); }
});
