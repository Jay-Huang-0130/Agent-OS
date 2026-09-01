import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface UserRecord {
  id: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface ActivityRecord {
  id: string;
  type: string;
  title: string;
  detail: string;
  severity: string;
  createdAt: string;
}

export type AssistantRequestStatus = "PENDING_ROUTING" | "ROUTED" | "NEEDS_CLARIFICATION" | "CANCELLED";

export interface AssistantRequestRecord {
  id: string;
  ownerUserId: string;
  message: string;
  status: AssistantRequestStatus;
  executionMode: string | null;
  confidence: number | null;
  routingReason: string | null;
  requiresClarification: boolean | null;
  goalId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "phase_0_2_foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        severity TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS activity_created_at_idx ON activity_events(created_at DESC);
    `,
  },
  {
    version: 2,
    name: "phase_3_responsibility_kernel",
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_user_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        desired_outcome TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'INBOX', 'CLARIFYING', 'PLANNING', 'ACTIVE', 'WAITING', 'WAITING_AUTH',
          'NEEDS_APPROVAL', 'RETRYING', 'BLOCKED', 'COMPLETED', 'CANCELLED'
        )),
        state_reason TEXT,
        autonomy TEXT NOT NULL CHECK (autonomy IN (
          'OBSERVE', 'PREPARE', 'ASK_BEFORE_ACT', 'ACT_WITHIN_POLICY', 'FULLY_AUTOMATED'
        )),
        current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        cancelled_at TEXT,
        UNIQUE(owner_user_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS goal_versions (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        contract_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(goal_id, version)
      );

      CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        owner TEXT NOT NULL CHECK (owner IN ('USER', 'AGENT_OS', 'EXTERNAL_PARTY')),
        owed_to TEXT NOT NULL CHECK (owed_to IN ('USER', 'AGENT_OS', 'EXTERNAL_PARTY')),
        promise TEXT NOT NULL,
        due_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'WAITING', 'FULFILLED', 'BROKEN', 'CANCELLED')),
        follow_up_policy TEXT,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'COMPLETED', 'CANCELLED')),
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(goal_id, version)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'PENDING', 'READY', 'LEASED', 'RUNNING', 'WAITING', 'WAITING_AUTH',
          'VERIFYING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'
        )),
        position INTEGER NOT NULL DEFAULT 0,
        specification_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(goal_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        worker_id TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'QUEUED', 'RUNNING', 'WAITING', 'VERIFYING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED'
        )),
        attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
        checkpoint_json TEXT,
        result_json TEXT,
        error_json TEXT,
        usage_json TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE(aggregate_type, aggregate_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS wake_conditions (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN (
          'TIME', 'INTERVAL', 'EVENT', 'WEBHOOK', 'USER_INPUT', 'APPROVAL_GRANTED',
          'AUTH_COMPLETED', 'NETWORK_RECOVERED', 'DEADLINE_NEAR'
        )),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'CONSUMED', 'CANCELLED')),
        due_at TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        misfire_policy TEXT NOT NULL CHECK (misfire_policy IN (
          'RUN_ONCE_NOW', 'RUN_LATEST_ONLY', 'RUN_ALL', 'SKIP_AND_RESUME', 'REPLAN'
        )),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        UNIQUE(goal_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS leases (
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL,
        renewed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(resource_type, resource_id)
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT,
        last_error TEXT,
        idempotency_key TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        action_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS artifact_refs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        uri TEXT NOT NULL,
        sha256 TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        CHECK (project_id IS NOT NULL OR goal_id IS NOT NULL OR task_id IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS idempotency_records (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(scope, key)
      );

      CREATE INDEX IF NOT EXISTS projects_owner_status_idx ON projects(owner_user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS goals_owner_status_idx ON goals(owner_user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS goals_project_idx ON goals(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS commitments_goal_status_idx ON commitments(goal_id, status, due_at);
      CREATE INDEX IF NOT EXISTS tasks_goal_status_idx ON tasks(goal_id, status, position);
      CREATE INDEX IF NOT EXISTS runs_task_created_idx ON runs(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS events_goal_sequence_idx ON events(goal_id, sequence);
      CREATE INDEX IF NOT EXISTS events_aggregate_idx ON events(aggregate_type, aggregate_id, sequence);
      CREATE INDEX IF NOT EXISTS wakes_due_idx ON wake_conditions(status, due_at);
      CREATE INDEX IF NOT EXISTS leases_expires_idx ON leases(expires_at);
      CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS approvals_goal_status_idx ON approvals(goal_id, status);
      CREATE INDEX IF NOT EXISTS artifacts_goal_idx ON artifact_refs(goal_id, created_at);

      CREATE TRIGGER IF NOT EXISTS events_append_only_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS events_append_only_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS goal_versions_immutable_update
      BEFORE UPDATE ON goal_versions
      BEGIN
        SELECT RAISE(ABORT, 'goal versions are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS goal_versions_immutable_delete
      BEFORE DELETE ON goal_versions
      BEGIN
        SELECT RAISE(ABORT, 'goal versions are immutable');
      END;
    `,
  },
  {
    version: 3,
    name: "phase_4_unified_assistant_intake",
    sql: `
      CREATE TABLE IF NOT EXISTS assistant_requests (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        message TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'PENDING_ROUTING', 'ROUTED', 'NEEDS_CLARIFICATION', 'CANCELLED'
        )),
        execution_mode TEXT,
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        routing_reason TEXT,
        requires_clarification INTEGER CHECK (requires_clarification IS NULL OR requires_clarification IN (0, 1)),
        goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_user_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS assistant_requests_owner_created_idx
      ON assistant_requests(owner_user_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS assistant_requests_status_created_idx
      ON assistant_requests(status, created_at);
    `,
  },
];

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export class AgentDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      COMMIT;
    `);

    for (const migration of migrations) {
      const applied = this.db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(migration.version);
      if (applied) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString());
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  migrationVersions(): number[] {
    const rows = this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    return rows.map((row) => Number(row.version));
  }

  hasOwner(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    return Number(row.count) > 0;
  }

  createOwner(displayName: string, passwordHash: string, passwordSalt: string): UserRecord {
    if (this.hasOwner()) throw new Error("Agent-OS already has an owner");
    const user: UserRecord = {
      id: randomUUID(),
      displayName,
      passwordHash,
      passwordSalt,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO users (id, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(user.id, user.displayName, user.passwordHash, user.passwordSalt, user.createdAt);
    return user;
  }

  getOwner(): UserRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id, display_name, password_hash, password_salt, created_at FROM users ORDER BY created_at LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: asString(row.id),
      displayName: asString(row.display_name),
      passwordHash: asString(row.password_hash),
      passwordSalt: asString(row.password_salt),
      createdAt: asString(row.created_at),
    };
  }

  createSession(session: SessionRecord): void {
    this.deleteExpiredSessions();
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(session.tokenHash, session.userId, session.csrfToken, session.createdAt, session.expiresAt);
  }

  getSession(tokenHash: string): (SessionRecord & { displayName: string }) | undefined {
    const row = this.db
      .prepare(
        `SELECT s.token_hash, s.user_id, s.csrf_token, s.created_at, s.expires_at, u.display_name
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, new Date().toISOString()) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      tokenHash: asString(row.token_hash),
      userId: asString(row.user_id),
      csrfToken: asString(row.csrf_token),
      createdAt: asString(row.created_at),
      expiresAt: asString(row.expires_at),
      displayName: asString(row.display_name),
    };
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteExpiredSessions(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
  }

  getSettings<T extends object>(defaults: T): T {
    const rows = this.db.prepare("SELECT key, value_json FROM settings").all() as Array<{
      key: string;
      value_json: string;
    }>;
    const output = Object.assign({}, defaults) as Record<string, unknown>;
    for (const row of rows) {
      try {
        output[row.key] = JSON.parse(row.value_json) as unknown;
      } catch {
        // Ignore invalid legacy values and preserve the safe default.
      }
    }
    return output as T;
  }

  setSettings(values: Record<string, unknown>): void {
    const statement = this.db.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of Object.entries(values)) {
        statement.run(key, JSON.stringify(value), now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  addActivity(type: string, title: string, detail: string, severity = "info"): ActivityRecord {
    const event: ActivityRecord = {
      id: randomUUID(),
      type,
      title,
      detail,
      severity,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO activity_events (id, type, title, detail, severity, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(event.id, event.type, event.title, event.detail, event.severity, event.createdAt);
    return event;
  }

  listActivity(limit = 20): ActivityRecord[] {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const rows = this.db
      .prepare(
        "SELECT id, type, title, detail, severity, created_at FROM activity_events ORDER BY created_at DESC LIMIT ?",
      )
      .all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row.id),
      type: asString(row.type),
      title: asString(row.title),
      detail: asString(row.detail),
      severity: asString(row.severity),
      createdAt: asString(row.created_at),
    }));
  }

  createAssistantRequest(ownerUserId: string, message: string, idempotencyKey?: string): AssistantRequestRecord {
    if (idempotencyKey) {
      const existing = this.db.prepare(
        "SELECT * FROM assistant_requests WHERE owner_user_id = ? AND idempotency_key = ?",
      ).get(ownerUserId, idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return assistantRequestFromRow(existing);
    }
    const now = new Date().toISOString();
    const record: AssistantRequestRecord = {
      id: randomUUID(),
      ownerUserId,
      message,
      status: "PENDING_ROUTING",
      executionMode: null,
      confidence: null,
      routingReason: null,
      requiresClarification: null,
      goalId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`INSERT INTO assistant_requests
      (id, owner_user_id, message, status, execution_mode, confidence, routing_reason,
       requires_clarification, goal_id, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`)
      .run(record.id, ownerUserId, message, record.status, idempotencyKey ?? null, now, now);
    return record;
  }

  listAssistantRequests(ownerUserId: string, limit = 50): AssistantRequestRecord[] {
    const safeLimit = Math.max(1, Math.min(200, limit));
    const rows = this.db.prepare(
      "SELECT * FROM assistant_requests WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(ownerUserId, safeLimit) as Array<Record<string, unknown>>;
    return rows.map(assistantRequestFromRow);
  }

  recordAssistantRouting(
    id: string,
    ownerUserId: string,
    result: {
      state: "ROUTED" | "NEEDS_CLARIFICATION";
      executionMode: string;
      confidence: number;
      reason: string;
      requiresClarification: boolean;
    },
  ): AssistantRequestRecord {
    const now = new Date().toISOString();
    const changed = this.db.prepare(`UPDATE assistant_requests SET
      status = ?, execution_mode = ?, confidence = ?, routing_reason = ?,
      requires_clarification = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'PENDING_ROUTING'`)
      .run(
        result.state,
        result.executionMode,
        result.confidence,
        result.reason,
        result.requiresClarification ? 1 : 0,
        now,
        id,
        ownerUserId,
      );
    if (Number(changed.changes) !== 1) throw new Error("Assistant request is missing or has already been routed.");
    const row = this.db.prepare("SELECT * FROM assistant_requests WHERE id = ? AND owner_user_id = ?")
      .get(id, ownerUserId) as Record<string, unknown>;
    return assistantRequestFromRow(row);
  }

  close(): void {
    this.db.close();
  }
}

function assistantRequestFromRow(row: Record<string, unknown>): AssistantRequestRecord {
  return {
    id: asString(row.id),
    ownerUserId: asString(row.owner_user_id),
    message: asString(row.message),
    status: asString(row.status) as AssistantRequestStatus,
    executionMode: row.execution_mode === null ? null : asString(row.execution_mode),
    confidence: row.confidence === null ? null : Number(row.confidence),
    routingReason: row.routing_reason === null ? null : asString(row.routing_reason),
    requiresClarification: row.requires_clarification === null ? null : Number(row.requires_clarification) === 1,
    goalId: row.goal_id === null ? null : asString(row.goal_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}
