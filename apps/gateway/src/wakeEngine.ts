import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDatabase } from "./database.js";

export const executionModes = ["DETERMINISTIC_AUTOMATION", "AI_EXECUTION"] as const;
export const misfirePolicies = ["RUN_ONCE_NOW", "RUN_LATEST_ONLY", "RUN_ALL", "SKIP_AND_RESUME", "REPLAN"] as const;
export type ExecutionMode = typeof executionModes[number];
export type MisfirePolicy = typeof misfirePolicies[number];
export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
};

export interface CapabilityRecord {
  id: string;
  ownerUserId: string;
  name: string;
  version: number;
  description: string;
  runtime: "PYTHON_JSON";
  sourceSha256: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permissions: string[];
  risk: "LOW" | "MEDIUM" | "HIGH";
  timeoutMs: number;
  status: "VALIDATED" | "DISABLED";
  createdAt: string;
  updatedAt: string;
}

export type AutomationSchedule =
  | { kind: "ONCE"; at: string }
  | { kind: "INTERVAL"; startAt: string; everySeconds: number };

export interface AutomationRecord {
  id: string;
  goalId: string;
  capabilityId: string | null;
  executionMode: ExecutionMode;
  input: unknown;
  schedule: AutomationSchedule;
  timezone: string;
  notificationTemplate: string | null;
  misfirePolicy: MisfirePolicy;
  status: "ACTIVE" | "PAUSED" | "CANCELLED";
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityExecutor {
  execute(capability: CapabilitySource, input: unknown): Promise<unknown>;
}

export interface AiWakeExecutor {
  execute(input: { goalId: string; automationId: string; input: unknown }): Promise<{ output: unknown; usage: { modelCalls: number; inputTokens: number; outputTokens: number; toolCalls: number } }>;
}

interface CapabilitySource extends CapabilityRecord { sourceCode: string }
interface ClaimedOccurrence {
  occurrenceId: string;
  wakeId: string;
  automation: AutomationRecord;
  scheduledFor: string;
  attempts: number;
}

export class Phase5Error extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "Phase5Error";
  }
}

export class PythonJsonExecutor implements CapabilityExecutor {
  constructor(private readonly executable = process.platform === "win32" ? "python" : "python3") {}

  async execute(capability: CapabilitySource, input: unknown): Promise<unknown> {
    validatePythonSource(capability.sourceCode, capability.permissions);
    const allowedHosts = capability.permissions
      .filter((item) => item.startsWith("network:https:"))
      .map((item) => item.slice("network:https:".length));
    const directory = mkdtempSync(join(tmpdir(), "agent-os-capability-"));
    const scriptPath = join(directory, "capability.py");
    const wrapper = `${capability.sourceCode}\n\n${pythonWrapper(allowedHosts)}\n`;
    writeFileSync(scriptPath, wrapper, { encoding: "utf8", mode: 0o600 });
    try {
      return await runPython(this.executable, scriptPath, directory, input, capability.timeoutMs);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function pythonWrapper(allowedHosts: string[]): string {
  return `if __name__ == "__main__":
    import json as _agent_json
    import sys as _agent_sys
    import urllib.parse as _agent_urlparse
    import urllib.request as _agent_urlrequest
    _agent_allowed_hosts = set(${JSON.stringify(allowedHosts)})
    _agent_original_urlopen = _agent_urlrequest.urlopen
    def _agent_safe_urlopen(url, *args, **kwargs):
        target = url.full_url if hasattr(url, "full_url") else str(url)
        parsed = _agent_urlparse.urlparse(target)
        if parsed.scheme != "https" or parsed.hostname not in _agent_allowed_hosts:
            raise PermissionError("network host is not granted by the capability manifest")
        return _agent_original_urlopen(url, *args, **kwargs)
    _agent_urlrequest.urlopen = _agent_safe_urlopen
    _agent_payload = _agent_json.load(_agent_sys.stdin)
    _agent_result = main(_agent_payload)
    _agent_json.dump(_agent_result, _agent_sys.stdout, ensure_ascii=False)`;
}

function runPython(executable: string, scriptPath: string, cwd: string, input: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-I", scriptPath], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: Object.fromEntries(Object.entries({
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        SSL_CERT_DIR: process.env.SSL_CERT_DIR,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Phase5Error("capability_timeout", `Capability exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) {
        child.kill("SIGKILL");
        finish(new Phase5Error("capability_output_too_large", "Capability output exceeded 1 MB."));
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.on("error", (error) => finish(new Phase5Error("capability_runtime_unavailable", error.message)));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Phase5Error("capability_failed", stderr || `Python exited with code ${code}.`));
      try { finish(undefined, JSON.parse(stdout)); }
      catch { finish(new Phase5Error("invalid_capability_output", "Capability did not return one JSON value.")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function validatePythonSource(source: string, permissions: string[]): void {
  if (!source.includes("def main(") || source.length > 64_000) {
    throw new Phase5Error("invalid_capability_source", "Python capability must define main(payload) and stay below 64 KB.");
  }
  const blocked = [
    /\b(?:exec|eval|compile|open|input)\s*\(/u,
    /__import__|__builtins__|importlib|subprocess|pathlib|shutil|socket|ctypes|pickle|marshal|multiprocessing/u,
    /\b(?:os|sys)\s*\./u,
  ];
  if (blocked.some((pattern) => pattern.test(source))) {
    throw new Phase5Error("unsafe_capability_source", "Capability requests Python features outside the Phase 5 policy.");
  }
  const allowedModules = new Set(["json", "datetime", "math", "re", "statistics", "urllib.request", "urllib.parse"]);
  for (const match of source.matchAll(/^\s*(?:from|import)\s+([a-zA-Z0-9_.]+)/gmu)) {
    const moduleName = match[1] as string;
    if (!allowedModules.has(moduleName)) {
      throw new Phase5Error("unsafe_capability_source", `Python module is not allowed in Phase 5: ${moduleName}`);
    }
  }
  const networkUsed = /urllib\.(?:request|parse)/u.test(source);
  if (networkUsed && !permissions.some((item) => item.startsWith("network:https:"))) {
    throw new Phase5Error("missing_network_permission", "Network code needs an explicit network:https:<host> permission.");
  }
  for (const permission of permissions) {
    if (permission === "notification:send") continue;
    if (/^network:https:[a-z0-9.-]+$/iu.test(permission)) continue;
    throw new Phase5Error("unsupported_permission", `Unsupported Phase 5 permission: ${permission}`);
  }
}

export function validateJsonSchema(schema: JsonSchema, value: unknown, path = "$"): void {
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    throw new Phase5Error("schema_validation_failed", `${path} is not one of the allowed values.`);
  }
  if (!schema.type) return;
  const valid = schema.type === "null" ? value === null
    : schema.type === "array" ? Array.isArray(value)
      : schema.type === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
        : schema.type === "integer" ? Number.isInteger(value)
          : typeof value === schema.type;
  if (!valid) throw new Phase5Error("schema_validation_failed", `${path} must be ${schema.type}.`);
  if (schema.type === "array" && schema.items) {
    (value as unknown[]).forEach((item, index) => validateJsonSchema(schema.items as JsonSchema, item, `${path}[${index}]`));
  }
  if (schema.type === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) throw new Phase5Error("schema_validation_failed", `${path}.${key} is required.`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in object) validateJsonSchema(child, object[key], `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      const extra = Object.keys(object).find((key) => !allowed.has(key));
      if (extra) throw new Phase5Error("schema_validation_failed", `${path}.${extra} is not allowed.`);
    }
  }
}

export class CapabilityService {
  constructor(private readonly database: AgentDatabase, private readonly executor: CapabilityExecutor) {}

  async register(ownerUserId: string, input: {
    name: string; version: number; description?: string | undefined; sourceCode: string;
    inputSchema: JsonSchema; outputSchema: JsonSchema; permissions: string[];
    risk: "LOW" | "MEDIUM" | "HIGH"; timeoutMs: number; testInput?: unknown;
  }): Promise<CapabilityRecord> {
    if (input.risk !== "LOW") throw new Phase5Error("approval_required", "Phase 5 only auto-validates LOW risk generated capabilities.");
    validatePythonSource(input.sourceCode, input.permissions);
    validateJsonSchema(input.inputSchema, input.testInput);
    const provisional: CapabilitySource = {
      id: randomUUID(), ownerUserId, name: input.name, version: input.version,
      description: input.description ?? "", runtime: "PYTHON_JSON", sourceCode: input.sourceCode,
      sourceSha256: createHash("sha256").update(input.sourceCode).digest("hex"),
      inputSchema: input.inputSchema, outputSchema: input.outputSchema, permissions: input.permissions,
      risk: input.risk, timeoutMs: input.timeoutMs, status: "VALIDATED",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const existing = this.database.db.prepare("SELECT * FROM capabilities WHERE owner_user_id = ? AND name = ? AND version = ?")
      .get(ownerUserId, input.name, input.version) as Record<string, unknown> | undefined;
    if (existing) {
      const current = capabilityFromRow(existing);
      const same = current.sourceSha256 === provisional.sourceSha256
        && JSON.stringify(current.inputSchema) === JSON.stringify(input.inputSchema)
        && JSON.stringify(current.outputSchema) === JSON.stringify(input.outputSchema)
        && JSON.stringify(current.permissions) === JSON.stringify(input.permissions)
        && current.risk === input.risk && current.timeoutMs === input.timeoutMs;
      if (!same) throw new Phase5Error("capability_version_conflict", "Capability name/version already identifies a different manifest.");
      return withoutSource(current);
    }
    const testOutput = await this.executor.execute(provisional, input.testInput);
    validateJsonSchema(input.outputSchema, testOutput);
    const db = this.database.db;
    db.prepare(`INSERT INTO capabilities
      (id, owner_user_id, name, version, description, runtime, source_code, source_sha256,
       input_schema_json, output_schema_json, permissions_json, risk, timeout_ms, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'PYTHON_JSON', ?, ?, ?, ?, ?, ?, ?, 'VALIDATED', ?, ?)`)
      .run(provisional.id, ownerUserId, input.name, input.version, provisional.description, input.sourceCode,
        provisional.sourceSha256, JSON.stringify(input.inputSchema), JSON.stringify(input.outputSchema),
        JSON.stringify(input.permissions), input.risk, input.timeoutMs, provisional.createdAt, provisional.updatedAt);
    return withoutSource(provisional);
  }

  list(ownerUserId: string): CapabilityRecord[] {
    const rows = this.database.db.prepare("SELECT * FROM capabilities WHERE owner_user_id = ? ORDER BY name, version DESC")
      .all(ownerUserId) as Array<Record<string, unknown>>;
    return rows.map((row) => withoutSource(capabilityFromRow(row)));
  }

  getSource(id: string, ownerUserId?: string): CapabilitySource {
    const row = ownerUserId
      ? this.database.db.prepare("SELECT * FROM capabilities WHERE id = ? AND owner_user_id = ?").get(id, ownerUserId)
      : this.database.db.prepare("SELECT * FROM capabilities WHERE id = ?").get(id);
    if (!row) throw new Phase5Error("not_found", "Capability not found.");
    return capabilityFromRow(row as Record<string, unknown>);
  }
}

export class AutomationService {
  constructor(private readonly database: AgentDatabase, private readonly capabilities: CapabilityService) {}

  create(ownerUserId: string, input: {
    goalId: string; capabilityId?: string | undefined; executionMode: ExecutionMode; input?: unknown;
    schedule: AutomationSchedule; timezone: string; notificationTemplate?: string | undefined; misfirePolicy: MisfirePolicy;
  }, idempotencyKey?: string): AutomationRecord {
    validateSchedule(input.schedule);
    const goal = this.database.db.prepare("SELECT id FROM goals WHERE id = ? AND owner_user_id = ? AND status NOT IN ('COMPLETED', 'CANCELLED')")
      .get(input.goalId, ownerUserId);
    if (!goal) throw new Phase5Error("not_found", "Active Goal not found.");
    if (idempotencyKey) {
      const existing = this.database.db.prepare("SELECT * FROM automations WHERE goal_id = ? AND idempotency_key = ?")
        .get(input.goalId, idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        const current = automationFromRow(existing);
        const same = current.capabilityId === (input.capabilityId ?? null)
          && current.executionMode === input.executionMode
          && JSON.stringify(current.input) === JSON.stringify(input.input)
          && JSON.stringify(current.schedule) === JSON.stringify(input.schedule)
          && current.timezone === input.timezone
          && current.notificationTemplate === (input.notificationTemplate ?? null)
          && current.misfirePolicy === input.misfirePolicy;
        if (!same) throw new Phase5Error("idempotency_conflict", "Idempotency-Key was reused for a different automation.");
        return current;
      }
    }
    if (input.executionMode === "DETERMINISTIC_AUTOMATION") {
      if (!input.capabilityId) throw new Phase5Error("capability_required", "Deterministic automation needs a Capability.");
      const capability = this.capabilities.getSource(input.capabilityId, ownerUserId);
      if (capability.status !== "VALIDATED") throw new Phase5Error("capability_disabled", "Capability is not validated.");
      validateJsonSchema(capability.inputSchema, input.input);
    } else if (input.capabilityId) {
      throw new Phase5Error("capability_not_allowed", "AI execution does not use a deterministic Capability.");
    }
    const now = new Date().toISOString();
    const dueAt = firstDue(input.schedule, new Date());
    const record: AutomationRecord = {
      id: randomUUID(), goalId: input.goalId, capabilityId: input.capabilityId ?? null,
      executionMode: input.executionMode, input: input.input, schedule: input.schedule,
      timezone: input.timezone, notificationTemplate: input.notificationTemplate ?? null,
      misfirePolicy: input.misfirePolicy, status: "ACTIVE", createdAt: now, updatedAt: now,
    };
    const db = this.database.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO automations
        (id, goal_id, capability_id, execution_mode, input_json, schedule_json, timezone,
         notification_template, misfire_policy, status, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`)
        .run(record.id, record.goalId, record.capabilityId, record.executionMode, JSON.stringify(record.input),
          JSON.stringify(record.schedule), record.timezone, record.notificationTemplate, record.misfirePolicy, idempotencyKey ?? null, now, now);
      db.prepare(`INSERT INTO wake_conditions
        (id, goal_id, task_id, type, status, due_at, payload_json, misfire_policy, idempotency_key, created_at)
        VALUES (?, ?, NULL, ?, 'PENDING', ?, ?, ?, ?, ?)`)
        .run(randomUUID(), record.goalId, record.schedule.kind === "ONCE" ? "TIME" : "INTERVAL", dueAt,
          JSON.stringify({ automationId: record.id }), record.misfirePolicy, `automation:${record.id}`, now);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return record;
  }

  list(ownerUserId: string): AutomationRecord[] {
    const rows = this.database.db.prepare(`SELECT a.* FROM automations a JOIN goals g ON g.id = a.goal_id
      WHERE g.owner_user_id = ? ORDER BY a.created_at DESC`).all(ownerUserId) as Array<Record<string, unknown>>;
    return rows.map(automationFromRow);
  }

  cancel(id: string, ownerUserId: string): AutomationRecord {
    const row = this.database.db.prepare(`SELECT a.* FROM automations a JOIN goals g ON g.id = a.goal_id
      WHERE a.id = ? AND g.owner_user_id = ?`).get(id, ownerUserId) as Record<string, unknown> | undefined;
    if (!row) throw new Phase5Error("not_found", "Automation not found.");
    const now = new Date().toISOString();
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.database.db.prepare("UPDATE automations SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, id);
      this.database.db.prepare(`UPDATE wake_conditions SET status = 'CANCELLED'
        WHERE json_extract(payload_json, '$.automationId') = ? AND status IN ('PENDING', 'CLAIMED')`).run(id);
      this.database.db.exec("COMMIT");
    } catch (error) { this.database.db.exec("ROLLBACK"); throw error; }
    return { ...automationFromRow(row), status: "CANCELLED", updatedAt: now };
  }
}

export interface WakeEngineOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  misfireGraceMs?: number;
  maxAttempts?: number;
  clock?: () => Date;
  random?: () => number;
  notify?: (item: { id: string; title: string; detail: string; kind: "task"; createdAt: string; read: false }) => Promise<void> | void;
  aiExecutor?: AiWakeExecutor;
}

export class WakeEngine {
  private readonly workerId = randomUUID();
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly misfireGraceMs: number;
  private readonly maxAttempts: number;
  private readonly clock: () => Date;
  private readonly random: () => number;
  private readonly notify?: WakeEngineOptions["notify"];
  private readonly aiExecutor: AiWakeExecutor | undefined;
  private timer: NodeJS.Timeout | undefined;
  private active = 0;
  private readonly jobs = new Set<Promise<void>>();
  private flushingNotifications = false;

  constructor(
    private readonly database: AgentDatabase,
    private readonly capabilities: CapabilityService,
    private readonly capabilityExecutor: CapabilityExecutor,
    options: WakeEngineOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 2;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.misfireGraceMs = options.misfireGraceMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.clock = options.clock ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.notify = options.notify;
    this.aiExecutor = options.aiExecutor;
  }

  start(): void {
    if (this.timer) return;
    this.reconcile();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.jobs]);
  }

  reconcile(): void {
    const now = this.clock().toISOString();
    const db = this.database.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE wake_conditions SET status = 'PENDING' WHERE status = 'CLAIMED'
        AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.resource_type = 'wake' AND l.resource_id = wake_conditions.id AND l.expires_at > ?)`)
        .run(now);
      db.prepare(`UPDATE wake_occurrences SET status = 'RETRYING', next_retry_at = ?, updated_at = ?
        WHERE status IN ('CLAIMED', 'RUNNING') AND wake_id IN
          (SELECT w.id FROM wake_conditions w WHERE w.status = 'PENDING')`).run(now, now);
      db.prepare("DELETE FROM leases WHERE expires_at <= ?").run(now);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  async tick(): Promise<void> {
    await this.flushNotifications();
    const jobs: Array<Promise<void>> = [];
    while (this.active < this.concurrency) {
      const claimed = this.claimOne();
      if (!claimed) break;
      this.active += 1;
      let job: Promise<void>;
      job = this.execute(claimed).finally(() => {
        this.active -= 1;
        this.jobs.delete(job);
      });
      this.jobs.add(job);
      jobs.push(job);
    }
    await Promise.all(jobs);
    await this.flushNotifications();
  }

  private claimOne(): ClaimedOccurrence | undefined {
    const now = this.clock();
    const nowIso = now.toISOString();
    const db = this.database.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`SELECT w.*, a.*, w.id AS wake_id, w.status AS wake_status,
        a.id AS automation_id, a.status AS automation_status, g.status AS goal_status
        FROM wake_conditions w
        JOIN automations a ON json_extract(w.payload_json, '$.automationId') = a.id
        JOIN goals g ON g.id = a.goal_id
        WHERE w.status = 'PENDING' AND w.due_at <= ? AND a.status = 'ACTIVE'
          AND g.status NOT IN ('COMPLETED', 'CANCELLED')
        ORDER BY w.due_at LIMIT 1`).get(nowIso) as Record<string, unknown> | undefined;
      if (!row) { db.exec("COMMIT"); return undefined; }
      const wakeId = String(row.wake_id);
      const automation = automationFromRow(row);
      const retry = db.prepare(`SELECT * FROM wake_occurrences
        WHERE wake_id = ? AND status = 'RETRYING' AND next_retry_at <= ?
        ORDER BY updated_at DESC LIMIT 1`).get(wakeId, nowIso) as Record<string, unknown> | undefined;
      if (retry) {
        db.prepare("UPDATE wake_conditions SET status = 'CLAIMED' WHERE id = ? AND status = 'PENDING'").run(wakeId);
        db.prepare(`INSERT INTO leases
          (resource_type, resource_id, holder_id, token, acquired_at, renewed_at, expires_at)
          VALUES ('wake', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(resource_type, resource_id) DO UPDATE SET holder_id=excluded.holder_id,
            token=excluded.token, acquired_at=excluded.acquired_at, renewed_at=excluded.renewed_at, expires_at=excluded.expires_at
          WHERE leases.expires_at <= ?`)
          .run(wakeId, this.workerId, randomUUID(), nowIso, nowIso, new Date(now.getTime() + this.leaseMs).toISOString(), nowIso);
        db.prepare("UPDATE wake_occurrences SET status = 'CLAIMED', updated_at = ? WHERE id = ?")
          .run(nowIso, String(retry.id));
        db.exec("COMMIT");
        return {
          occurrenceId: String(retry.id), wakeId, automation,
          scheduledFor: String(retry.scheduled_for), attempts: Number(retry.attempts),
        };
      }
      let scheduledFor = String(row.due_at);
      const late = now.getTime() - new Date(scheduledFor).getTime() > this.misfireGraceMs;
      if (late && automation.misfirePolicy === "RUN_LATEST_ONLY") scheduledFor = latestDue(automation.schedule, now).toISOString();
      const occurrenceKey = `${automation.id}:${scheduledFor}`;
      const existing = db.prepare("SELECT * FROM wake_occurrences WHERE occurrence_key = ?").get(occurrenceKey) as Record<string, unknown> | undefined;
      if (existing) {
        rescheduleWake(db, wakeId, automation, scheduledFor, now);
        db.exec("COMMIT");
        return undefined;
      }
      if (late && ["SKIP_AND_RESUME", "REPLAN"].includes(automation.misfirePolicy)) {
        const occurrenceId = randomUUID();
        const status = automation.misfirePolicy === "REPLAN" ? "REPLAN_REQUIRED" : "SKIPPED";
        db.prepare(`INSERT INTO wake_occurrences
          (id, wake_id, automation_id, occurrence_key, scheduled_for, status, attempts, claimed_at, completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
          .run(occurrenceId, wakeId, automation.id, occurrenceKey, scheduledFor, status, nowIso, nowIso, nowIso);
        rescheduleWake(db, wakeId, automation, scheduledFor, now);
        db.exec("COMMIT");
        return undefined;
      }
      const occurrenceId = randomUUID();
      const leaseToken = randomUUID();
      db.prepare("UPDATE wake_conditions SET status = 'CLAIMED' WHERE id = ? AND status = 'PENDING'").run(wakeId);
      db.prepare(`INSERT INTO leases
        (resource_type, resource_id, holder_id, token, acquired_at, renewed_at, expires_at)
        VALUES ('wake', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(resource_type, resource_id) DO UPDATE SET holder_id=excluded.holder_id,
          token=excluded.token, acquired_at=excluded.acquired_at, renewed_at=excluded.renewed_at, expires_at=excluded.expires_at
        WHERE leases.expires_at <= ?`)
        .run(wakeId, this.workerId, leaseToken, nowIso, nowIso, new Date(now.getTime() + this.leaseMs).toISOString(), nowIso);
      db.prepare(`INSERT INTO wake_occurrences
        (id, wake_id, automation_id, occurrence_key, scheduled_for, status, attempts, claimed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'CLAIMED', 0, ?, ?)`)
        .run(occurrenceId, wakeId, automation.id, occurrenceKey, scheduledFor, nowIso, nowIso);
      db.exec("COMMIT");
      return { occurrenceId, wakeId, automation, scheduledFor, attempts: 0 };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private async execute(claimed: ClaimedOccurrence): Promise<void> {
    const started = this.clock();
    const db = this.database.db;
    db.prepare(`UPDATE wake_occurrences SET status = 'RUNNING', attempts = attempts + 1,
      started_at = ?, updated_at = ? WHERE id = ?`).run(started.toISOString(), started.toISOString(), claimed.occurrenceId);
    let output: unknown;
    let modelCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls = 0;
    try {
      if (claimed.automation.executionMode === "DETERMINISTIC_AUTOMATION") {
        const capability = this.capabilities.getSource(claimed.automation.capabilityId as string);
        validateJsonSchema(capability.inputSchema, claimed.automation.input);
        output = await this.capabilityExecutor.execute(capability, claimed.automation.input);
        validateJsonSchema(capability.outputSchema, output);
        toolCalls = 1;
      } else {
        if (!this.aiExecutor) throw new Phase5Error("ai_runtime_unavailable", "AI execution waits for the Phase 6 runtime.");
        const result = await this.aiExecutor.execute({ goalId: claimed.automation.goalId, automationId: claimed.automation.id, input: claimed.automation.input });
        output = result.output;
        ({ modelCalls, inputTokens, outputTokens, toolCalls } = result.usage);
      }
      this.complete(claimed, output, { modelCalls, inputTokens, outputTokens, toolCalls }, started);
    } catch (error) {
      this.fail(claimed, error, { modelCalls, inputTokens, outputTokens, toolCalls }, started);
    }
  }

  private complete(claimed: ClaimedOccurrence, output: unknown, usage: Usage, started: Date): void {
    const now = this.clock();
    const nowIso = now.toISOString();
    const db = this.database.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE wake_occurrences SET status = 'COMPLETED', output_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(output), nowIso, nowIso, claimed.occurrenceId);
      insertUsage(db, claimed, usage, started, now, true);
      if (claimed.automation.notificationTemplate) {
        const body = renderTemplate(claimed.automation.notificationTemplate, output);
        db.prepare(`INSERT OR IGNORE INTO notification_outbox
          (id, owner_user_id, goal_id, occurrence_id, title, body, status, attempts, available_at,
           idempotency_key, created_at) SELECT ?, g.owner_user_id, ?, ?, g.title, ?, 'PENDING', 0, ?, ?, ?
           FROM goals g WHERE g.id = ?`)
          .run(randomUUID(), claimed.automation.goalId, claimed.occurrenceId, body, nowIso,
            `notification:${claimed.occurrenceId}`, nowIso, claimed.automation.goalId);
      }
      rescheduleWake(db, claimed.wakeId, claimed.automation, claimed.scheduledFor, now);
      db.prepare("DELETE FROM leases WHERE resource_type = 'wake' AND resource_id = ?").run(claimed.wakeId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private fail(claimed: ClaimedOccurrence, error: unknown, usage: Usage, started: Date): void {
    const now = this.clock();
    const nowIso = now.toISOString();
    const message = error instanceof Error ? error.message.slice(0, 8_000) : String(error).slice(0, 8_000);
    const attempts = claimed.attempts + 1;
    const db = this.database.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      insertUsage(db, claimed, usage, started, now, false);
      if (attempts < this.maxAttempts) {
        const delay = Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));
        const retryAt = new Date(now.getTime() + Math.round(delay * (0.75 + this.random() * 0.5))).toISOString();
        db.prepare(`UPDATE wake_occurrences SET status = 'RETRYING', next_retry_at = ?, error_json = ?, updated_at = ? WHERE id = ?`)
          .run(retryAt, JSON.stringify({ message }), nowIso, claimed.occurrenceId);
        db.prepare("UPDATE wake_conditions SET status = 'PENDING', due_at = ? WHERE id = ?").run(retryAt, claimed.wakeId);
      } else {
        db.prepare(`UPDATE wake_occurrences SET status = 'FAILED', error_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify({ message }), nowIso, nowIso, claimed.occurrenceId);
        rescheduleWake(db, claimed.wakeId, claimed.automation, claimed.scheduledFor, now);
      }
      db.prepare("DELETE FROM leases WHERE resource_type = 'wake' AND resource_id = ?").run(claimed.wakeId);
      db.exec("COMMIT");
    } catch (transactionError) { db.exec("ROLLBACK"); throw transactionError; }
  }

  async flushNotifications(): Promise<void> {
    if (!this.notify || this.flushingNotifications) return;
    this.flushingNotifications = true;
    try {
    const now = this.clock().toISOString();
    const rows = this.database.db.prepare(`SELECT * FROM notification_outbox
      WHERE status IN ('PENDING', 'FAILED') AND available_at <= ? ORDER BY created_at LIMIT 20`)
      .all(now) as Array<Record<string, unknown>>;
    for (const row of rows) {
      try {
        await this.notify({ id: String(row.id), title: String(row.title), detail: String(row.body), kind: "task", createdAt: String(row.created_at), read: false });
        this.database.db.prepare(`UPDATE notification_outbox SET status = 'SENT', attempts = attempts + 1,
          sent_at = ?, last_error = NULL WHERE id = ? AND status != 'SENT'`).run(now, String(row.id));
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
        this.database.db.prepare(`UPDATE notification_outbox SET status = 'FAILED', attempts = attempts + 1,
          available_at = ?, last_error = ? WHERE id = ?`).run(new Date(new Date(now).getTime() + 60_000).toISOString(), message, String(row.id));
      }
    }
    } finally {
      this.flushingNotifications = false;
    }
  }
}

type Usage = { modelCalls: number; inputTokens: number; outputTokens: number; toolCalls: number };

function insertUsage(db: AgentDatabase["db"], claimed: ClaimedOccurrence, usage: Usage, started: Date, ended: Date, success: boolean): void {
  db.prepare(`INSERT INTO usage_ledger
    (id, goal_id, automation_id, occurrence_id, capability_id, model_calls, input_tokens,
     output_tokens, tool_calls, duration_ms, success, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), claimed.automation.goalId, claimed.automation.id, claimed.occurrenceId,
      claimed.automation.capabilityId, usage.modelCalls, usage.inputTokens, usage.outputTokens,
      usage.toolCalls, Math.max(0, ended.getTime() - started.getTime()), success ? 1 : 0, ended.toISOString());
}

function rescheduleWake(db: AgentDatabase["db"], wakeId: string, automation: AutomationRecord, scheduledFor: string, now: Date): void {
  const next = nextDue(automation.schedule, new Date(scheduledFor), now, automation.misfirePolicy);
  if (next) db.prepare("UPDATE wake_conditions SET status = 'PENDING', due_at = ?, consumed_at = NULL WHERE id = ?").run(next, wakeId);
  else db.prepare("UPDATE wake_conditions SET status = 'CONSUMED', consumed_at = ? WHERE id = ?").run(now.toISOString(), wakeId);
}

function firstDue(schedule: AutomationSchedule, now: Date): string {
  if (schedule.kind === "ONCE") return new Date(schedule.at).toISOString();
  const start = new Date(schedule.startAt);
  if (start.getTime() >= now.getTime()) return start.toISOString();
  const interval = schedule.everySeconds * 1_000;
  return new Date(start.getTime() + Math.ceil((now.getTime() - start.getTime()) / interval) * interval).toISOString();
}

function latestDue(schedule: AutomationSchedule, now: Date): Date {
  if (schedule.kind === "ONCE") return new Date(schedule.at);
  const start = new Date(schedule.startAt).getTime();
  const interval = schedule.everySeconds * 1_000;
  return new Date(start + Math.max(0, Math.floor((now.getTime() - start) / interval)) * interval);
}

function nextDue(schedule: AutomationSchedule, scheduled: Date, now: Date, policy: MisfirePolicy): string | null {
  if (schedule.kind === "ONCE") return null;
  const interval = schedule.everySeconds * 1_000;
  if (policy === "RUN_ALL") return new Date(scheduled.getTime() + interval).toISOString();
  const start = new Date(schedule.startAt).getTime();
  const nextIndex = Math.max(1, Math.floor((now.getTime() - start) / interval) + 1);
  return new Date(start + nextIndex * interval).toISOString();
}

function validateSchedule(schedule: AutomationSchedule): void {
  const date = new Date(schedule.kind === "ONCE" ? schedule.at : schedule.startAt);
  if (!Number.isFinite(date.getTime())) throw new Phase5Error("invalid_schedule", "Schedule timestamp is invalid.");
  if (schedule.kind === "INTERVAL" && (!Number.isInteger(schedule.everySeconds) || schedule.everySeconds < 60)) {
    throw new Phase5Error("invalid_schedule", "Interval must be at least 60 seconds.");
  }
}

function renderTemplate(template: string, output: unknown): string {
  const root = output && typeof output === "object" ? output as Record<string, unknown> : { value: output };
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/gu, (_match, path: string) => {
    let value: unknown = root;
    for (const segment of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined;
    return value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

function capabilityFromRow(row: Record<string, unknown>): CapabilitySource {
  return {
    id: String(row.id), ownerUserId: String(row.owner_user_id), name: String(row.name), version: Number(row.version),
    description: String(row.description), runtime: "PYTHON_JSON", sourceCode: String(row.source_code),
    sourceSha256: String(row.source_sha256), inputSchema: JSON.parse(String(row.input_schema_json)) as JsonSchema,
    outputSchema: JSON.parse(String(row.output_schema_json)) as JsonSchema,
    permissions: JSON.parse(String(row.permissions_json)) as string[], risk: String(row.risk) as CapabilitySource["risk"],
    timeoutMs: Number(row.timeout_ms), status: String(row.status) as CapabilitySource["status"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function withoutSource(record: CapabilitySource): CapabilityRecord {
  const { sourceCode: _sourceCode, ...safe } = record;
  return safe;
}

function automationFromRow(row: Record<string, unknown>): AutomationRecord {
  return {
    id: String(row.automation_id ?? row.id), goalId: String(row.goal_id),
    capabilityId: row.capability_id === null || row.capability_id === undefined ? null : String(row.capability_id),
    executionMode: String(row.execution_mode) as ExecutionMode, input: JSON.parse(String(row.input_json)),
    schedule: JSON.parse(String(row.schedule_json)) as AutomationSchedule, timezone: String(row.timezone),
    notificationTemplate: row.notification_template === null ? null : String(row.notification_template),
    misfirePolicy: String(row.misfire_policy) as MisfirePolicy,
    status: String(row.automation_status ?? row.status) as AutomationRecord["status"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
