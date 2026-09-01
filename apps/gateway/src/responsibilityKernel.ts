import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentDatabase } from "./database.js";

export const goalStatuses = [
  "INBOX",
  "CLARIFYING",
  "PLANNING",
  "ACTIVE",
  "WAITING",
  "WAITING_AUTH",
  "NEEDS_APPROVAL",
  "RETRYING",
  "BLOCKED",
  "COMPLETED",
  "CANCELLED",
] as const;

export const taskStatuses = [
  "PENDING",
  "READY",
  "LEASED",
  "RUNNING",
  "WAITING",
  "WAITING_AUTH",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
] as const;

export const autonomyLevels = [
  "OBSERVE",
  "PREPARE",
  "ASK_BEFORE_ACT",
  "ACT_WITHIN_POLICY",
  "FULLY_AUTOMATED",
] as const;

export type GoalStatus = typeof goalStatuses[number];
export type TaskStatus = typeof taskStatuses[number];
export type AutonomyLevel = typeof autonomyLevels[number];

export interface ProjectRecord {
  id: string;
  ownerUserId: string;
  name: string;
  description: string;
  status: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}

export interface GoalContract {
  desiredOutcome: string;
  agentCommitment: string[];
  completionCriteria: string[];
  cancellationCriteria: string[];
  externalDependencies: string[];
  constraints: Record<string, unknown>;
  priority: Record<string, unknown>;
  attentionPolicy: Record<string, unknown>;
  budget: Record<string, unknown>;
  autonomy: AutonomyLevel;
}

export interface GoalRecord {
  id: string;
  projectId: string | null;
  ownerUserId: string;
  title: string;
  desiredOutcome: string;
  status: GoalStatus;
  stateReason: string | null;
  autonomy: AutonomyLevel;
  currentVersion: number;
  contract: GoalContract;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface EventRecord {
  id: string;
  projectId: string | null;
  goalId: string | null;
  aggregateType: string;
  aggregateId: string;
  sequence: number;
  type: string;
  data: Record<string, unknown>;
  actor: string;
  occurredAt: string;
}

export interface WakeConditionRecord {
  id: string;
  goalId: string;
  taskId: string | null;
  type: string;
  status: string;
  dueAt: string | null;
  payload: Record<string, unknown>;
  misfirePolicy: string;
  idempotencyKey: string;
  createdAt: string;
  consumedAt: string | null;
}

export interface TaskRecord {
  id: string;
  goalId: string;
  planId: string | null;
  title: string;
  kind: string;
  status: TaskStatus;
  position: number;
  specification: Record<string, unknown>;
  result: unknown;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeaseRecord {
  resourceType: string;
  resourceId: string;
  holderId: string;
  token: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface OutboxRecord {
  id: string;
  eventId: string;
  topic: string;
  payload: Record<string, unknown>;
  status: "PENDING" | "PUBLISHED" | "FAILED";
  attempts: number;
  availableAt: string;
  createdAt: string;
  publishedAt: string | null;
  lastError: string | null;
  idempotencyKey: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string | undefined;
}

export interface CreateGoalInput {
  projectId?: string | undefined;
  title: string;
  desiredOutcome: string;
  agentCommitment?: string[] | undefined;
  completionCriteria: string[];
  cancellationCriteria?: string[] | undefined;
  externalDependencies?: string[] | undefined;
  constraints?: Record<string, unknown> | undefined;
  priority?: Record<string, unknown> | undefined;
  attentionPolicy?: Record<string, unknown> | undefined;
  budget?: Record<string, unknown> | undefined;
  autonomy?: AutonomyLevel | undefined;
}

export class KernelError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid_transition" | "completion_evidence_required",
    message: string,
  ) {
    super(message);
    this.name = "KernelError";
  }
}

const goalTransitions: Record<GoalStatus, ReadonlySet<GoalStatus>> = {
  INBOX: new Set(["CLARIFYING", "PLANNING", "CANCELLED"]),
  CLARIFYING: new Set(["INBOX", "PLANNING", "CANCELLED"]),
  PLANNING: new Set(["ACTIVE", "BLOCKED", "CANCELLED"]),
  ACTIVE: new Set([
    "WAITING", "WAITING_AUTH", "NEEDS_APPROVAL", "RETRYING", "BLOCKED", "COMPLETED", "CANCELLED",
  ]),
  WAITING: new Set(["ACTIVE", "BLOCKED", "CANCELLED"]),
  WAITING_AUTH: new Set(["ACTIVE", "BLOCKED", "CANCELLED"]),
  NEEDS_APPROVAL: new Set(["ACTIVE", "BLOCKED", "CANCELLED"]),
  RETRYING: new Set(["ACTIVE", "WAITING", "BLOCKED", "CANCELLED"]),
  BLOCKED: new Set(["ACTIVE", "CANCELLED"]),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
};

const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  PENDING: new Set(["READY", "BLOCKED", "CANCELLED"]),
  READY: new Set(["LEASED", "BLOCKED", "CANCELLED"]),
  LEASED: new Set(["RUNNING", "READY", "FAILED", "CANCELLED"]),
  RUNNING: new Set(["WAITING", "WAITING_AUTH", "VERIFYING", "COMPLETED", "FAILED", "CANCELLED"]),
  WAITING: new Set(["READY", "RUNNING", "BLOCKED", "CANCELLED"]),
  WAITING_AUTH: new Set(["READY", "RUNNING", "BLOCKED", "CANCELLED"]),
  VERIFYING: new Set(["COMPLETED", "FAILED", "RUNNING"]),
  COMPLETED: new Set(),
  FAILED: new Set(["READY", "BLOCKED", "CANCELLED"]),
  BLOCKED: new Set(["READY", "CANCELLED"]),
  CANCELLED: new Set(),
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function projectFromRow(row: Record<string, unknown>): ProjectRecord {
  return {
    id: asString(row.id),
    ownerUserId: asString(row.owner_user_id),
    name: asString(row.name),
    description: asString(row.description),
    status: asString(row.status) as ProjectRecord["status"],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function contractFromJson(value: unknown): GoalContract {
  return parseJson<GoalContract>(value, {
    desiredOutcome: "",
    agentCommitment: [],
    completionCriteria: [],
    cancellationCriteria: [],
    externalDependencies: [],
    constraints: {},
    priority: {},
    attentionPolicy: {},
    budget: {},
    autonomy: "ASK_BEFORE_ACT",
  });
}

function goalFromRow(row: Record<string, unknown>): GoalRecord {
  return {
    id: asString(row.id),
    projectId: nullableString(row.project_id),
    ownerUserId: asString(row.owner_user_id),
    title: asString(row.title),
    desiredOutcome: asString(row.desired_outcome),
    status: asString(row.status) as GoalStatus,
    stateReason: nullableString(row.state_reason),
    autonomy: asString(row.autonomy) as AutonomyLevel,
    currentVersion: Number(row.current_version),
    contract: contractFromJson(row.contract_json),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    completedAt: nullableString(row.completed_at),
    cancelledAt: nullableString(row.cancelled_at),
  };
}

function eventFromRow(row: Record<string, unknown>): EventRecord {
  return {
    id: asString(row.id),
    projectId: nullableString(row.project_id),
    goalId: nullableString(row.goal_id),
    aggregateType: asString(row.aggregate_type),
    aggregateId: asString(row.aggregate_id),
    sequence: Number(row.sequence),
    type: asString(row.type),
    data: parseJson<Record<string, unknown>>(row.data_json, {}),
    actor: asString(row.actor),
    occurredAt: asString(row.occurred_at),
  };
}

function taskFromRow(row: Record<string, unknown>): TaskRecord {
  return {
    id: asString(row.id),
    goalId: asString(row.goal_id),
    planId: nullableString(row.plan_id),
    title: asString(row.title),
    kind: asString(row.kind),
    status: asString(row.status) as TaskStatus,
    position: Number(row.position),
    specification: parseJson<Record<string, unknown>>(row.specification_json, {}),
    result: parseJson<unknown>(row.result_json, null),
    attempts: Number(row.attempts),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function leaseFromRow(row: Record<string, unknown>): LeaseRecord {
  return {
    resourceType: asString(row.resource_type),
    resourceId: asString(row.resource_id),
    holderId: asString(row.holder_id),
    token: asString(row.token),
    acquiredAt: asString(row.acquired_at),
    renewedAt: asString(row.renewed_at),
    expiresAt: asString(row.expires_at),
  };
}

export class ResponsibilityKernel {
  private readonly db: DatabaseSync;

  constructor(database: AgentDatabase, options: { reconcileOnStart?: boolean } = {}) {
    this.db = database.db;
    if (options.reconcileOnStart ?? true) this.reconcileStartup();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertIdempotency(scope: string, key: string | undefined, hash: string): string | undefined {
    if (!key) return undefined;
    const row = this.db
      .prepare("SELECT request_hash, resource_id FROM idempotency_records WHERE scope = ? AND key = ?")
      .get(scope, key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (asString(row.request_hash) !== hash) {
      throw new KernelError("conflict", "This idempotency key was already used for a different request.");
    }
    return asString(row.resource_id);
  }

  private rememberIdempotency(
    scope: string,
    key: string | undefined,
    hash: string,
    resourceType: string,
    resourceId: string,
    now: string,
  ): void {
    if (!key) return;
    this.db
      .prepare(`INSERT INTO idempotency_records
        (scope, key, request_hash, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(scope, key, hash, resourceType, resourceId, now);
  }

  private appendEvent(input: {
    projectId?: string | null;
    goalId?: string | null;
    aggregateType: string;
    aggregateId: string;
    type: string;
    data: Record<string, unknown>;
    actor: string;
    occurredAt: string;
  }): EventRecord {
    const sequenceRow = this.db
      .prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events
        WHERE aggregate_type = ? AND aggregate_id = ?`)
      .get(input.aggregateType, input.aggregateId) as { sequence: number };
    const event: EventRecord = {
      id: randomUUID(),
      projectId: input.projectId ?? null,
      goalId: input.goalId ?? null,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      sequence: Number(sequenceRow.sequence),
      type: input.type,
      data: input.data,
      actor: input.actor,
      occurredAt: input.occurredAt,
    };
    this.db.prepare(`INSERT INTO events
      (id, project_id, goal_id, aggregate_type, aggregate_id, sequence, type, data_json, actor, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        event.id,
        event.projectId,
        event.goalId,
        event.aggregateType,
        event.aggregateId,
        event.sequence,
        event.type,
        JSON.stringify(event.data),
        event.actor,
        event.occurredAt,
      );
    this.db.prepare(`INSERT INTO outbox
      (id, event_id, topic, payload_json, status, attempts, available_at, created_at, idempotency_key)
      VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)`)
      .run(
        randomUUID(),
        event.id,
        event.type,
        JSON.stringify(event),
        event.occurredAt,
        event.occurredAt,
        `event:${event.id}`,
      );
    return event;
  }

  createProject(ownerUserId: string, input: CreateProjectInput, idempotencyKey?: string): ProjectRecord {
    const hash = requestHash(input);
    return this.transaction(() => {
      const replayId = this.assertIdempotency(`project:create:${ownerUserId}`, idempotencyKey, hash);
      if (replayId) return this.requireProject(replayId, ownerUserId);
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: randomUUID(),
        ownerUserId,
        name: input.name,
        description: input.description ?? "",
        status: "ACTIVE",
        createdAt: now,
        updatedAt: now,
      };
      this.db.prepare(`INSERT INTO projects
        (id, owner_user_id, name, description, status, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          project.id,
          project.ownerUserId,
          project.name,
          project.description,
          project.status,
          idempotencyKey ?? null,
          project.createdAt,
          project.updatedAt,
        );
      this.appendEvent({
        projectId: project.id,
        aggregateType: "project",
        aggregateId: project.id,
        type: "project.created",
        data: { name: project.name },
        actor: ownerUserId,
        occurredAt: now,
      });
      this.rememberIdempotency(
        `project:create:${ownerUserId}`,
        idempotencyKey,
        hash,
        "project",
        project.id,
        now,
      );
      return project;
    });
  }

  listProjects(ownerUserId: string): ProjectRecord[] {
    const rows = this.db.prepare(`SELECT * FROM projects WHERE owner_user_id = ?
      ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, updated_at DESC`)
      .all(ownerUserId) as Array<Record<string, unknown>>;
    return rows.map(projectFromRow);
  }

  private requireProject(id: string, ownerUserId: string): ProjectRecord {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ? AND owner_user_id = ?")
      .get(id, ownerUserId) as Record<string, unknown> | undefined;
    if (!row) throw new KernelError("not_found", "Project not found.");
    return projectFromRow(row);
  }

  createGoal(ownerUserId: string, input: CreateGoalInput, idempotencyKey?: string): GoalRecord {
    const normalized: {
      projectId: string | undefined;
      title: string;
      desiredOutcome: string;
      agentCommitment: string[];
      completionCriteria: string[];
      cancellationCriteria: string[];
      externalDependencies: string[];
      constraints: Record<string, unknown>;
      priority: Record<string, unknown>;
      attentionPolicy: Record<string, unknown>;
      budget: Record<string, unknown>;
      autonomy: AutonomyLevel;
    } = {
      projectId: input.projectId,
      title: input.title,
      desiredOutcome: input.desiredOutcome,
      agentCommitment: input.agentCommitment ?? [],
      completionCriteria: input.completionCriteria,
      cancellationCriteria: input.cancellationCriteria ?? [],
      externalDependencies: input.externalDependencies ?? [],
      constraints: input.constraints ?? {},
      priority: input.priority ?? {},
      attentionPolicy: input.attentionPolicy ?? {},
      budget: input.budget ?? {},
      autonomy: input.autonomy ?? "ASK_BEFORE_ACT",
    };
    const hash = requestHash(normalized);
    return this.transaction(() => {
      const replayId = this.assertIdempotency(`goal:create:${ownerUserId}`, idempotencyKey, hash);
      if (replayId) return this.requireGoal(replayId, ownerUserId);
      if (normalized.projectId) this.requireProject(normalized.projectId, ownerUserId);
      const now = new Date().toISOString();
      const id = randomUUID();
      const contract: GoalContract = {
        desiredOutcome: normalized.desiredOutcome,
        agentCommitment: normalized.agentCommitment,
        completionCriteria: normalized.completionCriteria,
        cancellationCriteria: normalized.cancellationCriteria,
        externalDependencies: normalized.externalDependencies,
        constraints: normalized.constraints,
        priority: normalized.priority,
        attentionPolicy: normalized.attentionPolicy,
        budget: normalized.budget,
        autonomy: normalized.autonomy,
      };
      this.db.prepare(`INSERT INTO goals
        (id, project_id, owner_user_id, title, desired_outcome, status, autonomy, current_version,
         idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, 1, ?, ?, ?)`)
        .run(
          id,
          normalized.projectId ?? null,
          ownerUserId,
          normalized.title,
          normalized.desiredOutcome,
          normalized.autonomy,
          idempotencyKey ?? null,
          now,
          now,
        );
      this.db.prepare(`INSERT INTO goal_versions
        (id, goal_id, version, contract_json, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?)`)
        .run(randomUUID(), id, JSON.stringify(contract), ownerUserId, now);
      this.db.prepare(`INSERT INTO wake_conditions
        (id, goal_id, task_id, type, status, due_at, payload_json, misfire_policy,
         idempotency_key, created_at)
        VALUES (?, ?, NULL, 'EVENT', 'PENDING', ?, ?, 'RUN_ONCE_NOW', 'goal.accepted', ?)`)
        .run(randomUUID(), id, now, JSON.stringify({ event: "goal.accepted" }), now);
      this.appendEvent({
        projectId: normalized.projectId ?? null,
        goalId: id,
        aggregateType: "goal",
        aggregateId: id,
        type: "goal.accepted",
        data: { status: "ACTIVE", version: 1 },
        actor: ownerUserId,
        occurredAt: now,
      });
      this.rememberIdempotency(`goal:create:${ownerUserId}`, idempotencyKey, hash, "goal", id, now);
      return this.requireGoal(id, ownerUserId);
    });
  }

  listGoals(
    ownerUserId: string,
    filters: { projectId?: string | undefined; status?: GoalStatus | undefined } = {},
  ): GoalRecord[] {
    const clauses = ["g.owner_user_id = ?"];
    const values: Array<string> = [ownerUserId];
    if (filters.projectId) {
      clauses.push("g.project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      clauses.push("g.status = ?");
      values.push(filters.status);
    }
    const rows = this.db.prepare(`SELECT g.*, gv.contract_json FROM goals g
      JOIN goal_versions gv ON gv.goal_id = g.id AND gv.version = g.current_version
      WHERE ${clauses.join(" AND ")}
      ORDER BY g.updated_at DESC`).all(...values) as Array<Record<string, unknown>>;
    return rows.map(goalFromRow);
  }

  getGoal(id: string, ownerUserId: string): GoalRecord {
    return this.requireGoal(id, ownerUserId);
  }

  private requireGoal(id: string, ownerUserId: string): GoalRecord {
    const row = this.db.prepare(`SELECT g.*, gv.contract_json FROM goals g
      JOIN goal_versions gv ON gv.goal_id = g.id AND gv.version = g.current_version
      WHERE g.id = ? AND g.owner_user_id = ?`).get(id, ownerUserId) as Record<string, unknown> | undefined;
    if (!row) throw new KernelError("not_found", "Goal not found.");
    return goalFromRow(row);
  }

  private transitionGoal(
    id: string,
    ownerUserId: string,
    target: GoalStatus,
    eventType: string,
    reason: string,
    idempotencyKey?: string,
    evidenceRefs: string[] = [],
  ): GoalRecord {
    const hash = requestHash({ id, target, reason, evidenceRefs });
    return this.transaction(() => {
      const scope = `goal:${eventType}:${id}`;
      const replayId = this.assertIdempotency(scope, idempotencyKey, hash);
      if (replayId) return this.requireGoal(replayId, ownerUserId);
      const goal = this.requireGoal(id, ownerUserId);
      if (!goalTransitions[goal.status].has(target)) {
        throw new KernelError("invalid_transition", `Goal cannot transition from ${goal.status} to ${target}.`);
      }
      if (target === "COMPLETED" && evidenceRefs.length === 0) {
        throw new KernelError("completion_evidence_required", "A Goal needs verification evidence before completion.");
      }
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE goals SET status = ?, state_reason = ?, updated_at = ?,
        completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END,
        cancelled_at = CASE WHEN ? = 'CANCELLED' THEN ? ELSE cancelled_at END
        WHERE id = ?`).run(target, reason, now, target, now, target, now, id);
      if (target === "CANCELLED" || target === "COMPLETED") {
        this.db.prepare(`UPDATE wake_conditions SET status = 'CANCELLED'
          WHERE goal_id = ? AND status IN ('PENDING', 'CLAIMED')`).run(id);
      }
      this.appendEvent({
        projectId: goal.projectId,
        goalId: id,
        aggregateType: "goal",
        aggregateId: id,
        type: eventType,
        data: { from: goal.status, to: target, reason, evidenceRefs },
        actor: ownerUserId,
        occurredAt: now,
      });
      this.rememberIdempotency(scope, idempotencyKey, hash, "goal", id, now);
      return this.requireGoal(id, ownerUserId);
    });
  }

  pauseGoal(id: string, ownerUserId: string, reason = "Paused by the owner.", idempotencyKey?: string): GoalRecord {
    return this.transitionGoal(id, ownerUserId, "WAITING", "goal.paused", reason, idempotencyKey);
  }

  resumeGoal(id: string, ownerUserId: string, reason = "Resumed by the owner.", idempotencyKey?: string): GoalRecord {
    return this.transitionGoal(id, ownerUserId, "ACTIVE", "goal.resumed", reason, idempotencyKey);
  }

  cancelGoal(id: string, ownerUserId: string, reason = "Cancelled by the owner.", idempotencyKey?: string): GoalRecord {
    const goal = this.getGoal(id, ownerUserId);
    if (goal.status === "COMPLETED" || goal.status === "CANCELLED") {
      throw new KernelError("invalid_transition", `Goal cannot be cancelled from ${goal.status}.`);
    }
    return this.transitionGoal(id, ownerUserId, "CANCELLED", "goal.cancelled", reason, idempotencyKey);
  }

  completeGoal(id: string, ownerUserId: string, evidenceRefs: string[], reason: string): GoalRecord {
    return this.transitionGoal(id, ownerUserId, "COMPLETED", "goal.completed", reason, undefined, evidenceRefs);
  }

  listGoalEvents(id: string, ownerUserId: string, limit = 100): EventRecord[] {
    this.requireGoal(id, ownerUserId);
    const safeLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db.prepare(`SELECT * FROM events WHERE goal_id = ?
      ORDER BY occurred_at ASC, sequence ASC LIMIT ?`).all(id, safeLimit) as Array<Record<string, unknown>>;
    return rows.map(eventFromRow);
  }

  listGoalWakes(id: string, ownerUserId: string): WakeConditionRecord[] {
    this.requireGoal(id, ownerUserId);
    const rows = this.db.prepare("SELECT * FROM wake_conditions WHERE goal_id = ? ORDER BY created_at")
      .all(id) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row.id),
      goalId: asString(row.goal_id),
      taskId: nullableString(row.task_id),
      type: asString(row.type),
      status: asString(row.status),
      dueAt: nullableString(row.due_at),
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      misfirePolicy: asString(row.misfire_policy),
      idempotencyKey: asString(row.idempotency_key),
      createdAt: asString(row.created_at),
      consumedAt: nullableString(row.consumed_at),
    }));
  }

  createTask(input: {
    goalId: string;
    planId?: string;
    title: string;
    kind: string;
    specification?: Record<string, unknown>;
    position?: number;
  }, actor: string): TaskRecord {
    return this.transaction(() => {
      const goalRow = this.db.prepare("SELECT project_id FROM goals WHERE id = ?").get(input.goalId) as
        | Record<string, unknown>
        | undefined;
      if (!goalRow) throw new KernelError("not_found", "Goal not found.");
      const now = new Date().toISOString();
      const id = randomUUID();
      this.db.prepare(`INSERT INTO tasks
        (id, goal_id, plan_id, title, kind, status, position, specification_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`)
        .run(
          id,
          input.goalId,
          input.planId ?? null,
          input.title,
          input.kind,
          input.position ?? 0,
          JSON.stringify(input.specification ?? {}),
          now,
          now,
        );
      this.appendEvent({
        projectId: nullableString(goalRow.project_id),
        goalId: input.goalId,
        aggregateType: "task",
        aggregateId: id,
        type: "task.created",
        data: { status: "PENDING" },
        actor,
        occurredAt: now,
      });
      return this.requireTask(id);
    });
  }

  getTask(id: string): TaskRecord {
    return this.requireTask(id);
  }

  private requireTask(id: string): TaskRecord {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new KernelError("not_found", "Task not found.");
    return taskFromRow(row);
  }

  transitionTask(id: string, target: TaskStatus, actor: string, result?: unknown): TaskRecord {
    return this.transaction(() => {
      const task = this.requireTask(id);
      if (!taskTransitions[task.status].has(target)) {
        throw new KernelError("invalid_transition", `Task cannot transition from ${task.status} to ${target}.`);
      }
      const goal = this.db.prepare("SELECT project_id FROM goals WHERE id = ?").get(task.goalId) as Record<string, unknown>;
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE tasks SET status = ?, result_json = COALESCE(?, result_json),
        attempts = attempts + CASE WHEN ? = 'RUNNING' THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?`)
        .run(target, result === undefined ? null : JSON.stringify(result), target, now, id);
      this.appendEvent({
        projectId: nullableString(goal.project_id),
        goalId: task.goalId,
        aggregateType: "task",
        aggregateId: id,
        type: "task.transitioned",
        data: { from: task.status, to: target },
        actor,
        occurredAt: now,
      });
      return this.requireTask(id);
    });
  }

  acquireLease(resourceType: string, resourceId: string, holderId: string, ttlMs: number): LeaseRecord | undefined {
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000) throw new RangeError("Lease TTL must be at least one second.");
    return this.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const token = randomUUID();
      const result = this.db.prepare(`INSERT INTO leases
        (resource_type, resource_id, holder_id, token, acquired_at, renewed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(resource_type, resource_id) DO UPDATE SET
          holder_id = excluded.holder_id,
          token = excluded.token,
          acquired_at = excluded.acquired_at,
          renewed_at = excluded.renewed_at,
          expires_at = excluded.expires_at
        WHERE leases.expires_at <= ? OR leases.holder_id = ?`)
        .run(resourceType, resourceId, holderId, token, nowIso, nowIso, expiresAt, nowIso, holderId);
      if (Number(result.changes) === 0) return undefined;
      const row = this.db.prepare("SELECT * FROM leases WHERE resource_type = ? AND resource_id = ?")
        .get(resourceType, resourceId) as Record<string, unknown>;
      return leaseFromRow(row);
    });
  }

  renewLease(token: string, holderId: string, ttlMs: number): LeaseRecord | undefined {
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000) throw new RangeError("Lease TTL must be at least one second.");
    return this.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const result = this.db.prepare(`UPDATE leases SET renewed_at = ?, expires_at = ?
        WHERE token = ? AND holder_id = ? AND expires_at > ?`)
        .run(nowIso, expiresAt, token, holderId, nowIso);
      if (Number(result.changes) === 0) return undefined;
      const row = this.db.prepare("SELECT * FROM leases WHERE token = ?").get(token) as Record<string, unknown>;
      return leaseFromRow(row);
    });
  }

  releaseLease(token: string, holderId: string): boolean {
    const result = this.db.prepare("DELETE FROM leases WHERE token = ? AND holder_id = ?").run(token, holderId);
    return Number(result.changes) === 1;
  }

  expireLeases(at = new Date()): number {
    const result = this.db.prepare("DELETE FROM leases WHERE expires_at <= ?").run(at.toISOString());
    return Number(result.changes);
  }

  reconcileStartup(at = new Date()): number {
    return this.transaction(() => {
      const atIso = at.toISOString();
      const orphaned = this.db.prepare(`SELECT t.id, t.goal_id, t.status, g.project_id
        FROM tasks t JOIN goals g ON g.id = t.goal_id
        WHERE t.status IN ('LEASED', 'RUNNING')
          AND NOT EXISTS (
            SELECT 1 FROM leases l
            WHERE l.resource_type = 'task' AND l.resource_id = t.id AND l.expires_at > ?
          )`).all(atIso) as Array<Record<string, unknown>>;
      for (const row of orphaned) {
        const taskId = asString(row.id);
        this.db.prepare("UPDATE tasks SET status = 'READY', updated_at = ? WHERE id = ?").run(atIso, taskId);
        this.db.prepare(`UPDATE runs SET status = 'INTERRUPTED', completed_at = ?, updated_at = ?
          WHERE task_id = ? AND status = 'RUNNING'`).run(atIso, atIso, taskId);
        this.appendEvent({
          projectId: nullableString(row.project_id),
          goalId: asString(row.goal_id),
          aggregateType: "task",
          aggregateId: taskId,
          type: "task.recovered",
          data: { from: asString(row.status), to: "READY", reason: "lease_missing_or_expired" },
          actor: "kernel:startup-reconciliation",
          occurredAt: atIso,
        });
      }
      this.db.prepare("DELETE FROM leases WHERE expires_at <= ?").run(atIso);
      return orphaned.length;
    });
  }

  listPendingOutbox(limit = 100, at = new Date()): OutboxRecord[] {
    const safeLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db.prepare(`SELECT * FROM outbox
      WHERE status IN ('PENDING', 'FAILED') AND available_at <= ?
      ORDER BY created_at LIMIT ?`).all(at.toISOString(), safeLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row.id),
      eventId: asString(row.event_id),
      topic: asString(row.topic),
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      status: asString(row.status) as OutboxRecord["status"],
      attempts: Number(row.attempts),
      availableAt: asString(row.available_at),
      createdAt: asString(row.created_at),
      publishedAt: nullableString(row.published_at),
      lastError: nullableString(row.last_error),
      idempotencyKey: asString(row.idempotency_key),
    }));
  }

  markOutboxPublished(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE outbox SET status = 'PUBLISHED', attempts = attempts + 1,
      published_at = ?, last_error = NULL WHERE id = ? AND status != 'PUBLISHED'`).run(now, id);
    return Number(result.changes) === 1;
  }

  markOutboxFailed(id: string, error: string, retryAt: Date): boolean {
    const result = this.db.prepare(`UPDATE outbox SET status = 'FAILED', attempts = attempts + 1,
      available_at = ?, last_error = ? WHERE id = ? AND status != 'PUBLISHED'`)
      .run(retryAt.toISOString(), error.slice(0, 2_000), id);
    return Number(result.changes) === 1;
  }
}
