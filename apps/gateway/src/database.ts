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
    `);
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

  close(): void {
    this.db.close();
  }
}
