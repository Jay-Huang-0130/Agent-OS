import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentDatabase } from "./database.js";
import { KernelError, ResponsibilityKernel } from "./responsibilityKernel.js";

function fixture(name: string) {
  const stateDir = mkdtempSync(join(tmpdir(), `agent-os-${name}-`));
  const path = join(stateDir, "agent-os.db");
  const database = new AgentDatabase(path);
  const owner = database.createOwner("Owner", "hash", "salt");
  const kernel = new ResponsibilityKernel(database, { reconcileOnStart: false });
  return { database, kernel, owner, path };
}

function goalInput(projectId?: string) {
  return {
    ...(projectId ? { projectId } : {}),
    title: "Ship the responsibility kernel",
    desiredOutcome: "A restart-safe Phase 3 kernel is running.",
    agentCommitment: ["Persist every accepted responsibility."],
    completionCriteria: ["The durable-state acceptance tests pass."],
    autonomy: "ACT_WITHIN_POLICY" as const,
  };
}

test("migration upgrades a pre-migration Phase 0–2 database without losing owner data", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agent-os-legacy-migration-"));
  const path = join(stateDir, "agent-os.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  legacy.prepare(`INSERT INTO users
    (id, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("legacy-owner", "Legacy Owner", "hash", "salt", "2026-08-28T00:00:00.000Z");
  legacy.close();

  const upgraded = new AgentDatabase(path);
  assert.equal(upgraded.getOwner()?.displayName, "Legacy Owner");
  assert.deepEqual(upgraded.migrationVersions(), [1, 2]);
  const tables = upgraded.db.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name IN ('projects', 'goals', 'events', 'outbox') ORDER BY name`).all() as Array<{
    name: string;
  }>;
  assert.deepEqual(tables.map((row) => row.name), ["events", "goals", "outbox", "projects"]);
  upgraded.close();
});

test("Phase 3 migration is repeatable and preserves durable Goal state", () => {
  const { database, kernel, owner, path } = fixture("migration");
  database.addActivity("system", "Before restart", "Baseline data must survive.");
  const project = kernel.createProject(owner.id, { name: "Agent-OS" }, "project-1");
  const goal = kernel.createGoal(owner.id, goalInput(project.id), "goal-1");
  assert.deepEqual(database.migrationVersions(), [1, 2]);
  database.close();

  const reopened = new AgentDatabase(path);
  const restartedKernel = new ResponsibilityKernel(reopened);
  assert.deepEqual(reopened.migrationVersions(), [1, 2]);
  assert.equal(reopened.listActivity()[0]?.title, "Before restart");
  assert.equal(restartedKernel.getGoal(goal.id, owner.id).status, "ACTIVE");
  assert.equal(restartedKernel.getGoal(goal.id, owner.id).contract.completionCriteria.length, 1);
  reopened.close();
});

test("accepting a Goal atomically creates its version, event, first Wake and outbox intent", () => {
  const { database, kernel, owner } = fixture("atomic-goal");
  const goal = kernel.createGoal(owner.id, goalInput(), "accept-goal-1");

  const counts = database.db.prepare(`SELECT
    (SELECT COUNT(*) FROM goals WHERE id = ?) AS goals,
    (SELECT COUNT(*) FROM goal_versions WHERE goal_id = ?) AS versions,
    (SELECT COUNT(*) FROM events WHERE goal_id = ?) AS events,
    (SELECT COUNT(*) FROM wake_conditions WHERE goal_id = ?) AS wakes,
    (SELECT COUNT(*) FROM outbox o JOIN events e ON e.id = o.event_id WHERE e.goal_id = ?) AS outbox`
  ).get(goal.id, goal.id, goal.id, goal.id, goal.id) as Record<string, number>;
  assert.deepEqual(
    Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])),
    { goals: 1, versions: 1, events: 1, wakes: 1, outbox: 1 },
  );
  assert.equal(kernel.listGoalEvents(goal.id, owner.id)[0]?.type, "goal.accepted");
  assert.equal(kernel.listGoalWakes(goal.id, owner.id)[0]?.status, "PENDING");
  assert.equal(kernel.listPendingOutbox()[0]?.topic, "goal.accepted");
  assert.throws(
    () => database.db.prepare("UPDATE events SET type = 'tampered' WHERE goal_id = ?").run(goal.id),
    /append-only/u,
  );
  database.close();
});

test("idempotency replays the same side effect and rejects key reuse with a different request", () => {
  const { database, kernel, owner } = fixture("idempotency");
  const first = kernel.createGoal(owner.id, goalInput(), "same-request");
  const replay = kernel.createGoal(owner.id, goalInput(), "same-request");
  assert.equal(replay.id, first.id);
  assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM goals").get() as { count: number }).count), 1);
  assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count), 1);

  assert.throws(
    () => kernel.createGoal(owner.id, { ...goalInput(), title: "A different request" }, "same-request"),
    (error) => error instanceof KernelError && error.code === "conflict",
  );
  assert.throws(
    () => kernel.createGoal(owner.id, { ...goalInput(), projectId: "00000000-0000-4000-8000-000000000000" }),
    (error) => error instanceof KernelError && error.code === "not_found",
  );
  assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM goals").get() as { count: number }).count), 1);
  database.close();
});

test("Goal and Task state machines reject invalid transitions and terminal Goals stay terminal", () => {
  const { database, kernel, owner } = fixture("states");
  const goal = kernel.createGoal(owner.id, goalInput());
  const paused = kernel.pauseGoal(goal.id, owner.id, "Maintenance", "pause-1");
  assert.equal(paused.status, "WAITING");
  assert.equal(kernel.pauseGoal(goal.id, owner.id, "Maintenance", "pause-1").status, "WAITING");
  assert.equal(kernel.resumeGoal(goal.id, owner.id).status, "ACTIVE");
  assert.throws(
    () => kernel.completeGoal(goal.id, owner.id, [], "No evidence"),
    (error) => error instanceof KernelError && error.code === "completion_evidence_required",
  );
  assert.equal(kernel.completeGoal(goal.id, owner.id, ["artifact:test-report"], "Verified").status, "COMPLETED");
  assert.throws(
    () => kernel.cancelGoal(goal.id, owner.id),
    (error) => error instanceof KernelError && error.code === "invalid_transition",
  );

  const taskGoal = kernel.createGoal(owner.id, { ...goalInput(), title: "Task state Goal" });
  const task = kernel.createTask({ goalId: taskGoal.id, title: "Run tests", kind: "DETERMINISTIC" }, "test");
  assert.throws(
    () => kernel.transitionTask(task.id, "RUNNING", "test"),
    (error) => error instanceof KernelError && error.code === "invalid_transition",
  );
  assert.equal(kernel.transitionTask(task.id, "READY", "test").status, "READY");
  database.close();
});

test("only one worker acquires a lease and startup reconciliation recovers abandoned work", () => {
  const { database, kernel, owner, path } = fixture("leases");
  const goal = kernel.createGoal(owner.id, goalInput());
  const task = kernel.createTask({ goalId: goal.id, title: "Durable work", kind: "TOOL" }, "test");
  kernel.transitionTask(task.id, "READY", "test");
  const lease = kernel.acquireLease("task", task.id, "worker-a", 1_000);
  assert.ok(lease);
  assert.equal(kernel.transitionTask(task.id, "LEASED", "worker-a").status, "LEASED");
  assert.equal(kernel.transitionTask(task.id, "RUNNING", "worker-a").status, "RUNNING");

  const competingDatabase = new AgentDatabase(path);
  const competingKernel = new ResponsibilityKernel(competingDatabase, { reconcileOnStart: false });
  assert.equal(competingKernel.acquireLease("task", task.id, "worker-b", 1_000), undefined);
  assert.ok(competingKernel.renewLease(lease.token, "worker-a", 1_000));
  competingDatabase.close();
  database.close();

  const restartedDatabase = new AgentDatabase(path);
  const restartedKernel = new ResponsibilityKernel(restartedDatabase, { reconcileOnStart: false });
  const recovered = restartedKernel.reconcileStartup(new Date(Date.now() + 2_000));
  assert.equal(recovered, 1);
  assert.equal(restartedKernel.getTask(task.id).status, "READY");
  assert.equal(
    restartedKernel.listGoalEvents(goal.id, owner.id).some((event) => event.type === "task.recovered"),
    true,
  );
  restartedDatabase.close();
});
