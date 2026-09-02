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
  deadline: string | null;
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

export interface PlanRecord {
  id: string;
  goalId: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "SUPERSEDED" | "COMPLETED" | "CANCELLED";
  plan: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GoalDetail {
  goal: GoalRecord;
  plans: PlanRecord[];
  tasks: TaskRecord[];
  wakes: WakeConditionRecord[];
  timeline: EventRecord[];
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
  deadline?: string | undefined;
  constraints?: Record<string, unknown> | undefined;
  priority?: Record<string, unknown> | undefined;
  attentionPolicy?: Record<string, unknown> | undefined;
  budget?: Record<string, unknown> | undefined;
  autonomy?: AutonomyLevel | undefined;
}

export const commitmentOwners = ["USER", "AGENT_OS", "EXTERNAL_PARTY"] as const;
export const commitmentStatuses = ["OPEN", "WAITING", "FULFILLED", "BROKEN", "CANCELLED"] as const;
export type CommitmentOwner = typeof commitmentOwners[number];
export type CommitmentStatus = typeof commitmentStatuses[number];

export interface CommitmentRecord {
  id: string;
  goalId: string;
  owner: CommitmentOwner;
  owedTo: CommitmentOwner;
  promise: string;
  dueAt: string | null;
  status: CommitmentStatus;
  followUpPolicy: string | null;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateCommitmentInput {
  goalId: string;
  owner: CommitmentOwner;
  owedTo: CommitmentOwner;
  promise: string;
  dueAt?: string | undefined;
  followUpPolicy?: string | undefined;
}

export interface ProjectDetail {
  project: ProjectRecord;
  goals: GoalRecord[];
  commitments: CommitmentRecord[];
  timeline: EventRecord[];
  artifacts: Array<{
    id: string;
    goalId: string | null;
    taskId: string | null;
    kind: string;
    uri: string;
    sha256: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface PortfolioSnapshot {
  generatedAt: string;
  today: GoalRecord[];
  waitingOnYou: GoalRecord[];
  waitingOnOthers: GoalRecord[];
  upcoming: GoalRecord[];
  activeProjects: Array<ProjectRecord & { activeGoalCount: number; openCommitmentCount: number }>;
  needsDecision: GoalRecord[];
  recentlyCompleted: GoalRecord[];
  commitments: CommitmentRecord[];
  approvals: ApprovalRecord[];
}

export interface ApprovalRecord {
  id: string;
  goalId: string;
  taskId: string | null;
  action: Record<string, unknown>;
  risk: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
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
  const fallback: GoalContract = {
    desiredOutcome: "",
    agentCommitment: [],
    completionCriteria: [],
    cancellationCriteria: [],
    externalDependencies: [],
    deadline: null,
    constraints: {},
    priority: {},
    attentionPolicy: {},
    budget: {},
    autonomy: "ASK_BEFORE_ACT",
  };
  const parsed = parseJson<Partial<GoalContract>>(value, {});
  return {
    ...fallback,
    ...parsed,
    deadline: typeof parsed.deadline === "string" ? parsed.deadline : null,
    agentCommitment: Array.isArray(parsed.agentCommitment) ? parsed.agentCommitment : [],
    completionCriteria: Array.isArray(parsed.completionCriteria) ? parsed.completionCriteria : [],
    cancellationCriteria: Array.isArray(parsed.cancellationCriteria) ? parsed.cancellationCriteria : [],
    externalDependencies: Array.isArray(parsed.externalDependencies) ? parsed.externalDependencies : [],
  };
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

function commitmentFromRow(row: Record<string, unknown>): CommitmentRecord {
  return {
    id: asString(row.id),
    goalId: asString(row.goal_id),
    owner: asString(row.owner) as CommitmentOwner,
    owedTo: asString(row.owed_to) as CommitmentOwner,
    promise: asString(row.promise),
    dueAt: nullableString(row.due_at),
    status: asString(row.status) as CommitmentStatus,
    followUpPolicy: nullableString(row.follow_up_policy),
    evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function approvalFromRow(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: asString(row.id),
    goalId: asString(row.goal_id),
    taskId: nullableString(row.task_id),
    action: parseJson<Record<string, unknown>>(row.action_json, {}),
    risk: asString(row.risk),
    status: asString(row.status) as ApprovalRecord["status"],
    requestedAt: asString(row.requested_at),
    decidedAt: nullableString(row.decided_at),
    decidedBy: nullableString(row.decided_by),
    decisionReason: nullableString(row.decision_reason),
  };
}

function dateKey(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
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
      deadline: string | null;
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
      deadline: input.deadline ?? null,
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
        deadline: normalized.deadline,
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

  getGoalDetail(id: string, ownerUserId: string): GoalDetail {
    const goal = this.requireGoal(id, ownerUserId);
    const planRows = this.db.prepare("SELECT * FROM plans WHERE goal_id = ? ORDER BY version DESC")
      .all(id) as Array<Record<string, unknown>>;
    const taskRows = this.db.prepare("SELECT * FROM tasks WHERE goal_id = ? ORDER BY position, created_at")
      .all(id) as Array<Record<string, unknown>>;
    return {
      goal,
      plans: planRows.map((row) => ({
        id: asString(row.id),
        goalId: asString(row.goal_id),
        version: Number(row.version),
        status: asString(row.status) as PlanRecord["status"],
        plan: parseJson<Record<string, unknown>>(row.plan_json, {}),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      })),
      tasks: taskRows.map(taskFromRow),
      wakes: this.listGoalWakes(id, ownerUserId),
      timeline: this.listGoalEvents(id, ownerUserId, 500),
    };
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

  blockGoal(id: string, ownerUserId: string, reason: string, idempotencyKey?: string): GoalRecord {
    return this.transitionGoal(id, ownerUserId, "BLOCKED", "goal.blocked", reason, idempotencyKey);
  }

  recordGoalProgress(
    id: string,
    ownerUserId: string,
    detail: string,
    progress?: number,
    idempotencyKey?: string,
  ): GoalRecord {
    const normalizedProgress = progress === undefined ? undefined : Math.max(0, Math.min(100, progress));
    const hash = requestHash({ id, detail, progress: normalizedProgress });
    return this.transaction(() => {
      const scope = `goal:progress:${id}`;
      const replayId = this.assertIdempotency(scope, idempotencyKey, hash);
      if (replayId) return this.requireGoal(replayId, ownerUserId);
      const goal = this.requireGoal(id, ownerUserId);
      if (["COMPLETED", "CANCELLED"].includes(goal.status)) {
        throw new KernelError("invalid_transition", `A terminal Goal cannot record progress from ${goal.status}.`);
      }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE goals SET updated_at = ? WHERE id = ?").run(now, id);
      this.appendEvent({
        projectId: goal.projectId,
        goalId: id,
        aggregateType: "goal",
        aggregateId: id,
        type: "goal.progressed",
        data: { detail, ...(normalizedProgress === undefined ? {} : { progress: normalizedProgress }) },
        actor: ownerUserId,
        occurredAt: now,
      });
      this.rememberIdempotency(scope, idempotencyKey, hash, "goal", id, now);
      return this.requireGoal(id, ownerUserId);
    });
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

  createCommitment(
    ownerUserId: string,
    input: CreateCommitmentInput,
    idempotencyKey?: string,
  ): CommitmentRecord {
    const normalized = {
      ...input,
      dueAt: input.dueAt ?? null,
      followUpPolicy: input.followUpPolicy ?? (input.dueAt ? "remind_24h_before" : null),
    };
    const hash = requestHash(normalized);
    return this.transaction(() => {
      const scope = `commitment:create:${ownerUserId}`;
      const replayId = this.assertIdempotency(scope, idempotencyKey, hash);
      if (replayId) return this.requireCommitment(replayId, ownerUserId);
      const goal = this.requireGoal(input.goalId, ownerUserId);
      const now = new Date().toISOString();
      const id = randomUUID();
      this.db.prepare(`INSERT INTO commitments
        (id, goal_id, owner, owed_to, promise, due_at, status, follow_up_policy,
         evidence_refs_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, '[]', ?, ?)`)
        .run(
          id,
          input.goalId,
          input.owner,
          input.owedTo,
          input.promise,
          normalized.dueAt,
          normalized.followUpPolicy,
          now,
          now,
        );
      if (normalized.dueAt) {
        const dueAtMs = new Date(normalized.dueAt).getTime();
        const remindAt = normalized.followUpPolicy === "remind_24h_before"
          ? new Date(dueAtMs - 24 * 60 * 60_000)
          : new Date(dueAtMs);
        this.db.prepare(`INSERT INTO wake_conditions
          (id, goal_id, task_id, type, status, due_at, payload_json, misfire_policy,
           idempotency_key, created_at)
          VALUES (?, ?, NULL, 'TIME', 'PENDING', ?, ?, 'RUN_ONCE_NOW', ?, ?)`)
          .run(
            randomUUID(),
            input.goalId,
            remindAt.toISOString(),
            JSON.stringify({ event: "commitment.reminder_due", commitmentId: id }),
            `commitment:${id}:reminder`,
            now,
          );
      }
      this.appendEvent({
        projectId: goal.projectId,
        goalId: goal.id,
        aggregateType: "commitment",
        aggregateId: id,
        type: normalized.dueAt ? "commitment.reminder_scheduled" : "commitment.created",
        data: {
          owner: input.owner,
          owedTo: input.owedTo,
          promise: input.promise,
          dueAt: normalized.dueAt,
          followUpPolicy: normalized.followUpPolicy,
        },
        actor: ownerUserId,
        occurredAt: now,
      });
      this.rememberIdempotency(scope, idempotencyKey, hash, "commitment", id, now);
      return this.requireCommitment(id, ownerUserId);
    });
  }

  private requireCommitment(id: string, ownerUserId: string): CommitmentRecord {
    const row = this.db.prepare(`SELECT c.* FROM commitments c
      JOIN goals g ON g.id = c.goal_id
      WHERE c.id = ? AND g.owner_user_id = ?`).get(id, ownerUserId) as Record<string, unknown> | undefined;
    if (!row) throw new KernelError("not_found", "Commitment not found.");
    return commitmentFromRow(row);
  }

  listCommitments(
    ownerUserId: string,
    filters: { goalId?: string | undefined; projectId?: string | undefined; status?: CommitmentStatus | undefined } = {},
  ): CommitmentRecord[] {
    const clauses = ["g.owner_user_id = ?"];
    const values = [ownerUserId];
    if (filters.goalId) {
      clauses.push("c.goal_id = ?");
      values.push(filters.goalId);
    }
    if (filters.projectId) {
      clauses.push("g.project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      clauses.push("c.status = ?");
      values.push(filters.status);
    }
    const rows = this.db.prepare(`SELECT c.* FROM commitments c
      JOIN goals g ON g.id = c.goal_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY CASE WHEN c.due_at IS NULL THEN 1 ELSE 0 END, c.due_at, c.created_at DESC`)
      .all(...values) as Array<Record<string, unknown>>;
    return rows.map(commitmentFromRow);
  }

  transitionCommitment(
    id: string,
    ownerUserId: string,
    target: "FULFILLED" | "CANCELLED",
    evidenceRefs: string[] = [],
    idempotencyKey?: string,
  ): CommitmentRecord {
    const hash = requestHash({ id, target, evidenceRefs });
    return this.transaction(() => {
      const scope = `commitment:${target.toLowerCase()}:${id}`;
      const replayId = this.assertIdempotency(scope, idempotencyKey, hash);
      if (replayId) return this.requireCommitment(replayId, ownerUserId);
      const current = this.requireCommitment(id, ownerUserId);
      if (!["OPEN", "WAITING", "BROKEN"].includes(current.status)) {
        throw new KernelError("invalid_transition", `Commitment cannot transition from ${current.status} to ${target}.`);
      }
      const goal = this.requireGoal(current.goalId, ownerUserId);
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE commitments SET status = ?, evidence_refs_json = ?, updated_at = ? WHERE id = ?`)
        .run(target, JSON.stringify(evidenceRefs), now, id);
      this.db.prepare(`UPDATE wake_conditions SET status = 'CANCELLED'
        WHERE goal_id = ? AND idempotency_key = ? AND status IN ('PENDING', 'CLAIMED')`)
        .run(current.goalId, `commitment:${id}:reminder`);
      this.appendEvent({
        projectId: goal.projectId,
        goalId: goal.id,
        aggregateType: "commitment",
        aggregateId: id,
        type: target === "FULFILLED" ? "commitment.fulfilled" : "commitment.cancelled",
        data: { from: current.status, to: target, evidenceRefs },
        actor: ownerUserId,
        occurredAt: now,
      });
      this.rememberIdempotency(scope, idempotencyKey, hash, "commitment", id, now);
      return this.requireCommitment(id, ownerUserId);
    });
  }

  getProjectDetail(id: string, ownerUserId: string): ProjectDetail {
    const project = this.requireProject(id, ownerUserId);
    const goals = this.listGoals(ownerUserId, { projectId: id });
    const commitments = this.listCommitments(ownerUserId, { projectId: id });
    const timelineRows = this.db.prepare(`SELECT * FROM events WHERE project_id = ?
      ORDER BY occurred_at DESC, sequence DESC LIMIT 300`).all(id) as Array<Record<string, unknown>>;
    const artifactRows = this.db.prepare(`SELECT * FROM artifact_refs WHERE project_id = ?
      OR goal_id IN (SELECT id FROM goals WHERE project_id = ?) ORDER BY created_at DESC`)
      .all(id, id) as Array<Record<string, unknown>>;
    return {
      project,
      goals,
      commitments,
      timeline: timelineRows.map(eventFromRow),
      artifacts: artifactRows.map((row) => ({
        id: asString(row.id),
        goalId: nullableString(row.goal_id),
        taskId: nullableString(row.task_id),
        kind: asString(row.kind),
        uri: asString(row.uri),
        sha256: nullableString(row.sha256),
        metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
        createdAt: asString(row.created_at),
      })),
    };
  }

  requestApproval(
    ownerUserId: string,
    input: { goalId: string; taskId?: string | undefined; action: Record<string, unknown>; risk: string },
    actor = "kernel:decision-gate",
  ): ApprovalRecord {
    return this.transaction(() => {
      const goal = this.requireGoal(input.goalId, ownerUserId);
      if (!["ACTIVE", "RETRYING", "WAITING"].includes(goal.status)) {
        throw new KernelError("invalid_transition", `Goal cannot request approval from ${goal.status}.`);
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      this.db.prepare(`INSERT INTO approvals
        (id, goal_id, task_id, action_json, risk, status, requested_at)
        VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`)
        .run(id, input.goalId, input.taskId ?? null, JSON.stringify(input.action), input.risk, now);
      this.db.prepare(`UPDATE goals SET status = 'NEEDS_APPROVAL', state_reason = ?, updated_at = ? WHERE id = ?`)
        .run(`Approval ${id} is waiting for the owner.`, now, input.goalId);
      this.appendEvent({
        projectId: goal.projectId,
        goalId: goal.id,
        aggregateType: "approval",
        aggregateId: id,
        type: "approval.requested",
        data: { action: input.action, risk: input.risk, from: goal.status, to: "NEEDS_APPROVAL" },
        actor,
        occurredAt: now,
      });
      return this.requireApproval(id, ownerUserId);
    });
  }

  private requireApproval(id: string, ownerUserId: string): ApprovalRecord {
    const row = this.db.prepare(`SELECT a.* FROM approvals a JOIN goals g ON g.id = a.goal_id
      WHERE a.id = ? AND g.owner_user_id = ?`).get(id, ownerUserId) as Record<string, unknown> | undefined;
    if (!row) throw new KernelError("not_found", "Approval not found.");
    return approvalFromRow(row);
  }

  listApprovals(ownerUserId: string, status?: ApprovalRecord["status"]): ApprovalRecord[] {
    const rows = this.db.prepare(`SELECT a.* FROM approvals a JOIN goals g ON g.id = a.goal_id
      WHERE g.owner_user_id = ? AND (? IS NULL OR a.status = ?)
      ORDER BY a.requested_at DESC`).all(ownerUserId, status ?? null, status ?? null) as Array<Record<string, unknown>>;
    return rows.map(approvalFromRow);
  }

  decideApproval(
    id: string,
    ownerUserId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string,
  ): ApprovalRecord {
    return this.transaction(() => {
      const approval = this.requireApproval(id, ownerUserId);
      if (approval.status !== "PENDING") {
        throw new KernelError("invalid_transition", `Approval has already reached ${approval.status}.`);
      }
      const goal = this.requireGoal(approval.goalId, ownerUserId);
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ?`)
        .run(decision, now, ownerUserId, reason, id);
      if (goal.status === "NEEDS_APPROVAL") {
        this.db.prepare(`UPDATE goals SET status = 'ACTIVE', state_reason = NULL, updated_at = ? WHERE id = ?`)
          .run(now, goal.id);
      }
      if (decision === "APPROVED") {
        this.db.prepare(`INSERT INTO wake_conditions
          (id, goal_id, task_id, type, status, due_at, payload_json, misfire_policy, idempotency_key, created_at)
          VALUES (?, ?, ?, 'APPROVAL_GRANTED', 'PENDING', ?, ?, 'RUN_ONCE_NOW', ?, ?)`)
          .run(
            randomUUID(),
            goal.id,
            approval.taskId,
            now,
            JSON.stringify({ approvalId: id }),
            `approval:${id}:granted`,
            now,
          );
      }
      this.appendEvent({
        projectId: goal.projectId,
        goalId: goal.id,
        aggregateType: "approval",
        aggregateId: id,
        type: decision === "APPROVED" ? "approval.approved" : "approval.rejected",
        data: { reason, goalStatus: "ACTIVE" },
        actor: ownerUserId,
        occurredAt: now,
      });
      return this.requireApproval(id, ownerUserId);
    });
  }

  portfolio(ownerUserId: string, timezone: string, now = new Date()): PortfolioSnapshot {
    const goals = this.listGoals(ownerUserId);
    const projects = this.listProjects(ownerUserId);
    const commitments = this.listCommitments(ownerUserId);
    const pendingApprovals = this.listApprovals(ownerUserId, "PENDING");
    const approvalGoalIds = new Set(pendingApprovals.map((approval) => approval.goalId));
    const todayKey = dateKey(now, timezone);
    const terminal = new Set<GoalStatus>(["COMPLETED", "CANCELLED"]);
    const active = goals.filter((goal) => !terminal.has(goal.status));
    const deadlineFor = (goal: GoalRecord): string | null => {
      if (goal.contract.deadline) return goal.contract.deadline;
      const value = goal.contract.priority.deadline;
      return typeof value === "string" ? value : null;
    };
    const isHighPriority = (goal: GoalRecord): boolean => {
      const urgency = goal.contract.priority.urgency;
      const rank = goal.contract.priority.userRank;
      return urgency === "high" || (typeof rank === "number" && rank <= 2);
    };
    const commitmentGoalIds = (owner: CommitmentOwner) => new Set(
      commitments
        .filter((item) => item.owner === owner && ["OPEN", "WAITING", "BROKEN"].includes(item.status))
        .map((item) => item.goalId),
    );
    const userCommitmentGoals = commitmentGoalIds("USER");
    const externalCommitmentGoals = commitmentGoalIds("EXTERNAL_PARTY");
    const waitingYouStatuses = new Set<GoalStatus>(["CLARIFYING", "WAITING_AUTH", "NEEDS_APPROVAL"]);
    const waitingOthersStatuses = new Set<GoalStatus>(["WAITING"]);
    const sortByDeadline = (left: GoalRecord, right: GoalRecord) => {
      const a = deadlineFor(left) ?? "9999";
      const b = deadlineFor(right) ?? "9999";
      return a.localeCompare(b) || right.updatedAt.localeCompare(left.updatedAt);
    };
    const today = active.filter((goal) => {
      if (!["ACTIVE", "RETRYING"].includes(goal.status)) return false;
      const deadline = deadlineFor(goal);
      return isHighPriority(goal) || Boolean(deadline && dateKey(new Date(deadline), timezone) <= todayKey);
    }).sort(sortByDeadline);
    const upcoming = active.filter((goal) => {
      const deadline = deadlineFor(goal);
      return Boolean(deadline && dateKey(new Date(deadline as string), timezone) > todayKey);
    }).sort(sortByDeadline);
    const waitingOnYou = active.filter((goal) => waitingYouStatuses.has(goal.status) || userCommitmentGoals.has(goal.id));
    const waitingOnOthers = active.filter(
      (goal) => waitingOthersStatuses.has(goal.status) || externalCommitmentGoals.has(goal.id),
    );
    const activeProjects = projects.filter((project) => project.status === "ACTIVE").map((project) => ({
      ...project,
      activeGoalCount: active.filter((goal) => goal.projectId === project.id).length,
      openCommitmentCount: commitments.filter((item) =>
        ["OPEN", "WAITING", "BROKEN"].includes(item.status)
        && goals.some((goal) => goal.id === item.goalId && goal.projectId === project.id)).length,
    })).filter((project) => project.activeGoalCount > 0 || project.openCommitmentCount > 0);
    return {
      generatedAt: now.toISOString(),
      today,
      waitingOnYou,
      waitingOnOthers,
      upcoming,
      activeProjects,
      needsDecision: active.filter((goal) => goal.status === "NEEDS_APPROVAL" || approvalGoalIds.has(goal.id)),
      recentlyCompleted: goals.filter((goal) => goal.status === "COMPLETED").slice(0, 10),
      commitments,
      approvals: pendingApprovals,
    };
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

  createPlan(goalId: string, ownerUserId: string, plan: Record<string, unknown>): PlanRecord {
    return this.transaction(() => {
      const goal = this.requireGoal(goalId, ownerUserId);
      const previous = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM plans WHERE goal_id = ?")
        .get(goalId) as Record<string, unknown>;
      const version = Number(previous.version) + 1;
      const now = new Date().toISOString();
      const id = randomUUID();
      this.db.prepare("UPDATE plans SET status = 'SUPERSEDED', updated_at = ? WHERE goal_id = ? AND status = 'ACTIVE'")
        .run(now, goalId);
      this.db.prepare(`INSERT INTO plans (id, goal_id, version, status, plan_json, created_at, updated_at)
        VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`)
        .run(id, goalId, version, JSON.stringify(plan), now, now);
      this.appendEvent({
        projectId: goal.projectId,
        goalId,
        aggregateType: "plan",
        aggregateId: id,
        type: "plan.activated",
        data: { version, nodeCount: Array.isArray(plan.nodes) ? plan.nodes.length : 0 },
        actor: ownerUserId,
        occurredAt: now,
      });
      return { id, goalId, version, status: "ACTIVE", plan, createdAt: now, updatedAt: now };
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
