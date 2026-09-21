import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentDatabase } from "./database.js";
import { Phase9SecretaryService, type SecretaryNotification } from "./phase9Secretary.js";
import { ResponsibilityKernel } from "./responsibilityKernel.js";

function fixture() {
  const database = new AgentDatabase(":memory:");
  const owner = database.createOwner("Owner", "hash", "salt");
  database.setSettings({ timezone: "Asia/Taipei" });
  const kernel = new ResponsibilityKernel(database, { reconcileOnStart: false });
  const delivered: SecretaryNotification[] = [];
  const secretary = new Phase9SecretaryService(database, kernel, (item) => { delivered.push(item); });
  return { database, owner, kernel, secretary, delivered };
}

const goalInput = (title: string, projectId: string, deadline: string) => ({
  projectId, title, desiredOutcome: `${title} outcome`, completionCriteria: [`${title} verified`], deadline,
  priority: { urgency: "high", userRank: 1 }, autonomy: "ASK_BEFORE_ACT" as const,
});

test("Phase 9 migration creates durable attention and calendar stores", () => {
  const { database } = fixture();
  try {
    assert.equal(database.migrationVersions().at(-1), 10);
    const tables = database.db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name IN ('calendar_events', 'availability_windows', 'attention_settings', 'briefings', 'attention_notifications')
      ORDER BY name`).all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((row) => row.name), ["attention_notifications", "attention_settings",
      "availability_windows", "briefings", "calendar_events"]);
  } finally { database.close(); }
});

test("Agenda sorts cross-project urgent work and reports calendar, deadline and availability conflicts", () => {
  const { database, owner, kernel, secretary } = fixture();
  try {
    const alpha = kernel.createProject(owner.id, { name: "Alpha" });
    const beta = kernel.createProject(owner.id, { name: "Beta" });
    const later = kernel.createGoal(owner.id, goalInput("Later", alpha.id, "2026-09-21T15:45:00.000Z"));
    const sooner = kernel.createGoal(owner.id, goalInput("Sooner", beta.id, "2026-09-21T15:00:00.000Z"));
    secretary.replaceAvailability(owner.id, [{ weekday: 1, startMinute: 540, endMinute: 1_020,
      timezone: "Asia/Taipei", enabled: true }]);
    secretary.createEvent(owner.id, { title: "Late meeting", description: "", startsAt: "2026-09-21T14:00:00.000Z",
      endsAt: "2026-09-21T16:00:00.000Z", allDay: false, location: "", source: "TEST" });
    secretary.createEvent(owner.id, { title: "Overlap", description: "", startsAt: "2026-09-21T14:30:00.000Z",
      endsAt: "2026-09-21T15:30:00.000Z", allDay: false, location: "", source: "TEST" });

    const agenda = secretary.agenda(owner.id, new Date("2026-09-21T14:45:00.000Z"));
    assert.equal(agenda.items.find((item) => item.type === "GOAL")?.id, sooner.id);
    assert.ok(agenda.items.some((item) => item.id === later.id));
    assert.ok(agenda.conflicts.some((item) => item.kind === "CALENDAR_OVERLAP"));
    assert.ok(agenda.conflicts.some((item) => item.kind === "DEADLINE_COLLISION" && item.itemIds.includes(sooner.id)));
    assert.ok(agenda.conflicts.some((item) => item.kind === "OUTSIDE_AVAILABILITY"));
    assert.ok(agenda.urgentAlerts.some((item) => item.goalId === sooner.id && item.kind === "DUE_SOON"));
  } finally { database.close(); }
});

test("Waiting on You and Waiting on Others remain distinct in the agenda", () => {
  const { database, owner, kernel, secretary } = fixture();
  try {
    const project = kernel.createProject(owner.id, { name: "Delegation" });
    const userGoal = kernel.createGoal(owner.id, goalInput("User action", project.id, "2026-09-28T00:00:00.000Z"));
    const externalGoal = kernel.createGoal(owner.id, goalInput("External action", project.id, "2026-09-28T00:00:00.000Z"));
    kernel.createCommitment(owner.id, { goalId: userGoal.id, owner: "USER", owedTo: "AGENT_OS", promise: "Provide input" });
    kernel.createCommitment(owner.id, { goalId: externalGoal.id, owner: "EXTERNAL_PARTY", owedTo: "USER", promise: "Vendor reply" });
    const agenda = secretary.agenda(owner.id, new Date("2026-09-21T00:00:00.000Z"));
    assert.ok(agenda.waitingOnYou.some((item) => item.id === userGoal.id));
    assert.ok(!agenda.waitingOnYou.some((item) => item.id === externalGoal.id));
    assert.ok(agenda.waitingOnOthers.some((item) => item.id === externalGoal.id));
  } finally { database.close(); }
});

test("Quiet hours hold normal alerts, urgent deadlines bypass quiet hours, and repeated scans dedupe", async () => {
  const { database, owner, kernel, secretary, delivered } = fixture();
  try {
    const project = kernel.createProject(owner.id, { name: "Attention" });
    kernel.createGoal(owner.id, goalInput("Urgent work", project.id, "2026-09-21T16:00:00.000Z"));
    secretary.createEvent(owner.id, { title: "A", description: "", startsAt: "2026-09-21T15:00:00.000Z",
      endsAt: "2026-09-21T16:30:00.000Z", allDay: false, location: "", source: "TEST" });
    secretary.createEvent(owner.id, { title: "B", description: "", startsAt: "2026-09-21T15:30:00.000Z",
      endsAt: "2026-09-21T17:00:00.000Z", allDay: false, location: "", source: "TEST" });
    const now = new Date("2026-09-21T15:30:00.000Z"); // 23:30 in Asia/Taipei
    await secretary.scan(owner.id, now);
    await secretary.scan(owner.id, now);
    assert.equal(delivered.filter((item) => item.kind === "urgent").length, 1);
    assert.equal(delivered.filter((item) => item.kind === "conflict").length, 0);
    const rows = database.db.prepare("SELECT status, kind, COUNT(*) AS count FROM attention_notifications GROUP BY status, kind").all() as Array<Record<string, unknown>>;
    assert.ok(rows.some((row) => row.kind === "CONFLICT" && row.status === "HELD"));
    assert.ok(rows.every((row) => Number(row.count) === 1 || row.kind === "CONFLICT"));
  } finally { database.close(); }
});

test("Empty Daily Brief is neither persisted nor notified", async () => {
  const { database, owner, secretary, delivered } = fixture();
  try {
    const brief = secretary.dailyBrief(owner.id, new Date("2026-09-21T01:00:00.000Z"), true);
    await secretary.flush(owner.id, new Date("2026-09-21T01:00:00.000Z"));
    assert.equal(brief.meaningful, false);
    assert.equal(delivered.length, 0);
    assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM briefings").get() as { count: number }).count), 0);
    assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM attention_notifications").get() as { count: number }).count), 0);
  } finally { database.close(); }
});

test("Weekly Review exposes completed, stalled, blocked and next priorities", () => {
  const { database, owner, kernel, secretary } = fixture();
  try {
    const project = kernel.createProject(owner.id, { name: "Review" });
    const done = kernel.createGoal(owner.id, goalInput("Done", project.id, "2026-09-20T00:00:00.000Z"));
    kernel.completeGoal(done.id, owner.id, ["artifact:test"], "Verified");
    const stalled = kernel.createGoal(owner.id, goalInput("Stalled", project.id, "2026-09-30T00:00:00.000Z"));
    const blocked = kernel.createGoal(owner.id, goalInput("Blocked", project.id, "2026-09-30T00:00:00.000Z"));
    kernel.blockGoal(blocked.id, owner.id, "Dependency unavailable");
    database.db.prepare("UPDATE goals SET updated_at = ? WHERE id IN (?, ?)")
      .run("2026-09-01T00:00:00.000Z", stalled.id, blocked.id);
    const review = secretary.weeklyReview(owner.id, new Date("2026-09-21T02:00:00.000Z"));
    assert.equal(review.meaningful, true);
    assert.ok((review.content.completed as unknown[]).length >= 1);
    assert.ok((review.content.stalled as unknown[]).length >= 2);
    assert.ok((review.content.blocked as unknown[]).length >= 1);
    assert.ok((review.content.nextPriorities as unknown[]).length >= 1);
  } finally { database.close(); }
});
