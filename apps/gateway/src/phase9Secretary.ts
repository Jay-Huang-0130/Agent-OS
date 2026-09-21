import { createHash, randomUUID } from "node:crypto";
import type { AgentDatabase } from "./database.js";
import type { ResponsibilityKernel } from "./responsibilityKernel.js";

export type AttentionKind = "URGENT" | "CONFLICT" | "STALLED" | "DIGEST" | "DAILY_BRIEF" | "WEEKLY_REVIEW";
export type AttentionSeverity = "LOW" | "NORMAL" | "URGENT";

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string;
  source: string;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilityWindow {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  timezone: string;
  enabled: boolean;
}

export interface AttentionSettings {
  timezone: string;
  quietStartMinute: number;
  quietEndMinute: number;
  dailyBriefMinute: number;
  weeklyReviewWeekday: number;
  weeklyReviewMinute: number;
  digestMode: "IMMEDIATE" | "DIGEST";
  stalledAfterHours: number;
}

export interface AgendaConflict {
  id: string;
  kind: "CALENDAR_OVERLAP" | "DEADLINE_COLLISION" | "OUTSIDE_AVAILABILITY";
  title: string;
  detail: string;
  itemIds: string[];
  startsAt: string;
}

export interface UrgentAlert {
  id: string;
  kind: "OVERDUE" | "DUE_SOON" | "BROKEN_COMMITMENT";
  title: string;
  detail: string;
  goalId: string;
  dueAt: string | null;
}

export interface AgendaItem {
  id: string;
  type: "CALENDAR" | "GOAL" | "DECISION";
  title: string;
  projectId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  dueAt: string | null;
  status: string;
  attention: "URGENT" | "TODAY" | "WAITING" | "NORMAL";
}

export interface AgendaSnapshot {
  generatedAt: string;
  date: string;
  timezone: string;
  items: AgendaItem[];
  conflicts: AgendaConflict[];
  urgentAlerts: UrgentAlert[];
  waitingOnYou: Array<{ id: string; title: string; status: string }>;
  waitingOnOthers: Array<{ id: string; title: string; status: string }>;
  decisionQueue: Array<{ id: string; title: string; status: string }>;
  stalled: Array<{ id: string; title: string; status: string; updatedAt: string }>;
}

export interface Briefing {
  id: string;
  kind: "DAILY" | "WEEKLY";
  periodKey: string;
  content: Record<string, unknown>;
  meaningful: boolean;
  createdAt: string;
  deliveredAt: string | null;
}

export interface SecretaryNotification {
  id: string;
  title: string;
  detail: string;
  kind: string;
  createdAt: string;
  read: boolean;
}

type NotificationSink = (notification: SecretaryNotification) => void | Promise<void>;

const asString = (value: unknown): string => typeof value === "string" ? value : String(value ?? "");
const optionalString = (value: unknown): string | null => value === null || value === undefined ? null : asString(value);
const parseObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") return {};
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
};

function zonedParts(date: Date, timezone: string): { date: string; weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function isQuiet(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function dateKey(date: Date, timezone: string): string {
  return zonedParts(date, timezone).date;
}

function eventFromRow(row: Record<string, unknown>): CalendarEvent {
  return {
    id: asString(row.id), title: asString(row.title), description: asString(row.description),
    startsAt: asString(row.starts_at), endsAt: asString(row.ends_at), allDay: Number(row.all_day) === 1,
    location: asString(row.location), source: asString(row.source), status: asString(row.status) as CalendarEvent["status"],
    createdAt: asString(row.created_at), updatedAt: asString(row.updated_at),
  };
}

function briefingFromRow(row: Record<string, unknown>): Briefing {
  return {
    id: asString(row.id), kind: asString(row.kind) as Briefing["kind"], periodKey: asString(row.period_key),
    content: parseObject(row.content_json), meaningful: Number(row.meaningful) === 1,
    createdAt: asString(row.created_at), deliveredAt: optionalString(row.delivered_at),
  };
}

export class Phase9SecretaryService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: AgentDatabase,
    private readonly kernel: ResponsibilityKernel,
    private readonly notify: NotificationSink = () => undefined,
  ) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const owner = this.database.getOwner();
      if (owner) void this.scan(owner.id).catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  settings(ownerUserId: string): AttentionSettings {
    const row = this.database.db.prepare("SELECT * FROM attention_settings WHERE owner_user_id = ?")
      .get(ownerUserId) as Record<string, unknown> | undefined;
    if (!row) {
      const global = this.database.getSettings({ timezone: "Asia/Taipei" });
      return {
        timezone: global.timezone, quietStartMinute: 1_320, quietEndMinute: 480, dailyBriefMinute: 540,
        weeklyReviewWeekday: 1, weeklyReviewMinute: 540, digestMode: "DIGEST", stalledAfterHours: 72,
      };
    }
    return {
      timezone: asString(row.timezone), quietStartMinute: Number(row.quiet_start_minute),
      quietEndMinute: Number(row.quiet_end_minute), dailyBriefMinute: Number(row.daily_brief_minute),
      weeklyReviewWeekday: Number(row.weekly_review_weekday), weeklyReviewMinute: Number(row.weekly_review_minute),
      digestMode: asString(row.digest_mode) as AttentionSettings["digestMode"],
      stalledAfterHours: Number(row.stalled_after_hours),
    };
  }

  updateSettings(ownerUserId: string, input: AttentionSettings): AttentionSettings {
    const now = new Date().toISOString();
    this.database.db.prepare(`INSERT INTO attention_settings
      (owner_user_id, timezone, quiet_start_minute, quiet_end_minute, daily_brief_minute,
       weekly_review_weekday, weekly_review_minute, digest_mode, stalled_after_hours, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id) DO UPDATE SET timezone = excluded.timezone,
       quiet_start_minute = excluded.quiet_start_minute, quiet_end_minute = excluded.quiet_end_minute,
       daily_brief_minute = excluded.daily_brief_minute, weekly_review_weekday = excluded.weekly_review_weekday,
       weekly_review_minute = excluded.weekly_review_minute, digest_mode = excluded.digest_mode,
       stalled_after_hours = excluded.stalled_after_hours, updated_at = excluded.updated_at`)
      .run(ownerUserId, input.timezone, input.quietStartMinute, input.quietEndMinute, input.dailyBriefMinute,
        input.weeklyReviewWeekday, input.weeklyReviewMinute, input.digestMode, input.stalledAfterHours, now);
    return this.settings(ownerUserId);
  }

  createEvent(ownerUserId: string, input: Omit<CalendarEvent, "id" | "createdAt" | "updatedAt" | "status"> & {
    status?: CalendarEvent["status"];
  }, idempotencyKey?: string): CalendarEvent {
    if (new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) throw new Error("Event end must be after start.");
    if (idempotencyKey) {
      const existing = this.database.db.prepare("SELECT * FROM calendar_events WHERE owner_user_id = ? AND idempotency_key = ?")
        .get(ownerUserId, idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return eventFromRow(existing);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.db.prepare(`INSERT INTO calendar_events
      (id, owner_user_id, title, description, starts_at, ends_at, all_day, location, source, status,
       idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ownerUserId, input.title, input.description, input.startsAt, input.endsAt, input.allDay ? 1 : 0,
        input.location, input.source, input.status ?? "CONFIRMED", idempotencyKey ?? null, now, now);
    return eventFromRow(this.database.db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id) as Record<string, unknown>);
  }

  listEvents(ownerUserId: string, from?: string, to?: string): CalendarEvent[] {
    const rows = this.database.db.prepare(`SELECT * FROM calendar_events WHERE owner_user_id = ?
      AND status != 'CANCELLED' AND (? IS NULL OR ends_at >= ?) AND (? IS NULL OR starts_at <= ?)
      ORDER BY starts_at, ends_at`).all(ownerUserId, from ?? null, from ?? null, to ?? null, to ?? null) as Record<string, unknown>[];
    return rows.map(eventFromRow);
  }

  cancelEvent(ownerUserId: string, id: string): CalendarEvent | undefined {
    const now = new Date().toISOString();
    this.database.db.prepare("UPDATE calendar_events SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(now, id, ownerUserId);
    const row = this.database.db.prepare("SELECT * FROM calendar_events WHERE id = ? AND owner_user_id = ?")
      .get(id, ownerUserId) as Record<string, unknown> | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  availability(ownerUserId: string): AvailabilityWindow[] {
    const rows = this.database.db.prepare("SELECT * FROM availability_windows WHERE owner_user_id = ? ORDER BY weekday, start_minute")
      .all(ownerUserId) as Record<string, unknown>[];
    return rows.map((row) => ({ id: asString(row.id), weekday: Number(row.weekday), startMinute: Number(row.start_minute),
      endMinute: Number(row.end_minute), timezone: asString(row.timezone), enabled: Number(row.enabled) === 1 }));
  }

  replaceAvailability(ownerUserId: string, windows: Array<Omit<AvailabilityWindow, "id">>): AvailabilityWindow[] {
    const insert = this.database.db.prepare(`INSERT INTO availability_windows
      (id, owner_user_id, weekday, start_minute, end_minute, timezone, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.database.db.prepare("DELETE FROM availability_windows WHERE owner_user_id = ?").run(ownerUserId);
      for (const window of windows) insert.run(randomUUID(), ownerUserId, window.weekday, window.startMinute,
        window.endMinute, window.timezone, window.enabled ? 1 : 0, now, now);
      this.database.db.exec("COMMIT");
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
    return this.availability(ownerUserId);
  }

  agenda(ownerUserId: string, now = new Date()): AgendaSnapshot {
    const settings = this.settings(ownerUserId);
    const portfolio = this.kernel.portfolio(ownerUserId, settings.timezone, now);
    const today = dateKey(now, settings.timezone);
    const events = this.listEvents(ownerUserId).filter((event) => {
      const start = dateKey(new Date(event.startsAt), settings.timezone);
      const end = dateKey(new Date(event.endsAt), settings.timezone);
      return start <= today && end >= today;
    });
    const goals = this.database.db.prepare(`SELECT g.*, p.name AS project_name, gv.contract_json FROM goals g
      LEFT JOIN projects p ON p.id = g.project_id JOIN goal_versions gv ON gv.goal_id = g.id AND gv.version = g.current_version
      WHERE g.owner_user_id = ? AND g.status NOT IN ('COMPLETED', 'CANCELLED')`).all(ownerUserId) as Record<string, unknown>[];
    const deadline = (row: Record<string, unknown>): string | null => {
      const contract = parseObject(row.contract_json);
      if (typeof contract.deadline === "string") return contract.deadline;
      const priority = contract.priority && typeof contract.priority === "object" ? contract.priority as Record<string, unknown> : {};
      return typeof priority.deadline === "string" ? priority.deadline : null;
    };
    const urgentAlerts: UrgentAlert[] = [];
    const current = now.getTime();
    for (const goal of goals) {
      const dueAt = deadline(goal);
      if (!dueAt) continue;
      const delta = new Date(dueAt).getTime() - current;
      if (delta <= 24 * 60 * 60_000) urgentAlerts.push({ id: `deadline:${asString(goal.id)}`,
        kind: delta < 0 ? "OVERDUE" : "DUE_SOON", title: asString(goal.title),
        detail: delta < 0 ? "Deadline is overdue." : "Deadline is due within 24 hours.", goalId: asString(goal.id), dueAt });
    }
    const broken = this.database.db.prepare(`SELECT c.*, g.title FROM commitments c JOIN goals g ON g.id = c.goal_id
      WHERE g.owner_user_id = ? AND c.status = 'BROKEN'`).all(ownerUserId) as Record<string, unknown>[];
    for (const item of broken) urgentAlerts.push({ id: `commitment:${asString(item.id)}`, kind: "BROKEN_COMMITMENT",
      title: asString(item.title), detail: asString(item.promise), goalId: asString(item.goal_id), dueAt: optionalString(item.due_at) });

    const conflicts: AgendaConflict[] = [];
    for (let i = 0; i < events.length; i += 1) for (let j = i + 1; j < events.length; j += 1) {
      const left = events[i]!; const right = events[j]!;
      if (new Date(left.startsAt).getTime() < new Date(right.endsAt).getTime()
        && new Date(right.startsAt).getTime() < new Date(left.endsAt).getTime()) conflicts.push({
        id: `overlap:${left.id}:${right.id}`, kind: "CALENDAR_OVERLAP", title: "Calendar events overlap",
        detail: `${left.title} overlaps ${right.title}.`, itemIds: [left.id, right.id], startsAt: left.startsAt > right.startsAt ? left.startsAt : right.startsAt,
      });
    }
    for (const goal of goals) {
      const dueAt = deadline(goal);
      if (!dueAt || dateKey(new Date(dueAt), settings.timezone) !== today) continue;
      const dueTime = new Date(dueAt).getTime();
      for (const event of events.filter((item) => dueTime >= new Date(item.startsAt).getTime()
        && dueTime <= new Date(item.endsAt).getTime())) conflicts.push({
        id: `deadline:${asString(goal.id)}:${event.id}`, kind: "DEADLINE_COLLISION", title: "Deadline collides with calendar",
        detail: `${asString(goal.title)} is due during ${event.title}.`, itemIds: [asString(goal.id), event.id], startsAt: dueAt,
      });
    }
    const windows = this.availability(ownerUserId).filter((window) => window.enabled);
    for (const event of events) {
      const local = zonedParts(new Date(event.startsAt), settings.timezone);
      if (windows.length && !windows.some((window) => window.weekday === local.weekday && local.minute >= window.startMinute && local.minute < window.endMinute)) {
        conflicts.push({ id: `availability:${event.id}`, kind: "OUTSIDE_AVAILABILITY", title: "Event is outside availability",
          detail: `${event.title} begins outside the configured availability window.`, itemIds: [event.id], startsAt: event.startsAt });
      }
    }
    const cutoff = current - settings.stalledAfterHours * 60 * 60_000;
    const stalled = goals.filter((goal) => ["ACTIVE", "RETRYING", "BLOCKED"].includes(asString(goal.status))
      && new Date(asString(goal.updated_at)).getTime() < cutoff)
      .map((goal) => ({ id: asString(goal.id), title: asString(goal.title), status: asString(goal.status), updatedAt: asString(goal.updated_at) }));
    const urgentGoalIds = new Set(urgentAlerts.map((item) => item.goalId));
    const items: AgendaItem[] = [
      ...events.map((event): AgendaItem => ({ id: event.id, type: "CALENDAR", title: event.title, projectId: null,
        startsAt: event.startsAt, endsAt: event.endsAt, dueAt: null, status: event.status, attention: "TODAY" })),
      ...goals.filter((goal) => {
        const dueAt = deadline(goal);
        return urgentGoalIds.has(asString(goal.id)) || Boolean(dueAt && dateKey(new Date(dueAt), settings.timezone) === today)
          || portfolio.today.some((item) => item.id === asString(goal.id));
      }).map((goal): AgendaItem => ({ id: asString(goal.id), type: "GOAL", title: asString(goal.title),
        projectId: optionalString(goal.project_id), startsAt: null, endsAt: null, dueAt: deadline(goal), status: asString(goal.status),
        attention: urgentGoalIds.has(asString(goal.id)) ? "URGENT" : "TODAY" })),
      ...portfolio.needsDecision.map((goal): AgendaItem => ({ id: `decision:${goal.id}`, type: "DECISION", title: goal.title,
        projectId: goal.projectId, startsAt: null, endsAt: null, dueAt: deadline(goals.find((row) => asString(row.id) === goal.id) ?? {}),
        status: goal.status, attention: "WAITING" })),
    ].sort((left, right) => {
      const rank = { URGENT: 0, WAITING: 1, TODAY: 2, NORMAL: 3 };
      const leftTime = left.startsAt ?? left.dueAt;
      const rightTime = right.startsAt ?? right.dueAt;
      return rank[left.attention] - rank[right.attention]
        || (leftTime ? new Date(leftTime).getTime() : Number.MAX_SAFE_INTEGER)
          - (rightTime ? new Date(rightTime).getTime() : Number.MAX_SAFE_INTEGER)
        || left.title.localeCompare(right.title);
    });
    return { generatedAt: now.toISOString(), date: today, timezone: settings.timezone, items, conflicts, urgentAlerts,
      waitingOnYou: portfolio.waitingOnYou.map(({ id, title, status }) => ({ id, title, status })),
      waitingOnOthers: portfolio.waitingOnOthers.map(({ id, title, status }) => ({ id, title, status })),
      decisionQueue: portfolio.needsDecision.map(({ id, title, status }) => ({ id, title, status })), stalled };
  }

  dailyBrief(ownerUserId: string, now = new Date(), deliver = false): Briefing {
    const agenda = this.agenda(ownerUserId, now);
    const content = { date: agenda.date, items: agenda.items, urgentAlerts: agenda.urgentAlerts, conflicts: agenda.conflicts,
      waitingOnYou: agenda.waitingOnYou, waitingOnOthers: agenda.waitingOnOthers, decisionQueue: agenda.decisionQueue };
    const meaningful = agenda.items.length + agenda.urgentAlerts.length + agenda.conflicts.length
      + agenda.waitingOnYou.length + agenda.waitingOnOthers.length + agenda.decisionQueue.length > 0;
    if (!meaningful) return { id: "", kind: "DAILY", periodKey: agenda.date, content, meaningful: false,
      createdAt: now.toISOString(), deliveredAt: null };
    const briefing = this.saveBriefing(ownerUserId, "DAILY", agenda.date, content, meaningful, now);
    if (deliver && meaningful && !briefing.deliveredAt) {
      const lines = [`Today: ${agenda.items.length}`, `Urgent: ${agenda.urgentAlerts.length}`,
        `Conflicts: ${agenda.conflicts.length}`, `Waiting on you: ${agenda.waitingOnYou.length}`];
      this.queue(ownerUserId, "DAILY_BRIEF", "NORMAL", `Daily Brief · ${agenda.date}`, lines.join(" · "),
        `daily:${agenda.date}`, now);
    }
    return this.getBriefing(briefing.id)!;
  }

  weeklyReview(ownerUserId: string, now = new Date(), deliver = false): Briefing {
    const settings = this.settings(ownerUserId);
    const periodKey = `${dateKey(new Date(now.getTime() - 6 * 86_400_000), settings.timezone)}..${dateKey(now, settings.timezone)}`;
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const completed = this.database.db.prepare(`SELECT id, title, completed_at AS completedAt FROM goals
      WHERE owner_user_id = ? AND status = 'COMPLETED' AND completed_at >= ? ORDER BY completed_at DESC`).all(ownerUserId, since);
    const agenda = this.agenda(ownerUserId, now);
    const blocked = this.database.db.prepare(`SELECT id, title, state_reason AS reason, updated_at AS updatedAt FROM goals
      WHERE owner_user_id = ? AND status = 'BLOCKED' ORDER BY updated_at DESC`).all(ownerUserId);
    const nextPriorities = agenda.items.filter((item) => item.type !== "CALENDAR").slice(0, 5);
    const content = { period: periodKey, completed, stalled: agenda.stalled, blocked, nextPriorities };
    const meaningful = completed.length + agenda.stalled.length + blocked.length + nextPriorities.length > 0;
    const briefing = this.saveBriefing(ownerUserId, "WEEKLY", periodKey, content, meaningful, now);
    if (deliver && meaningful && !briefing.deliveredAt) this.queue(ownerUserId, "WEEKLY_REVIEW", "NORMAL",
      `Weekly Review · ${periodKey}`, `Completed: ${completed.length} · Stalled: ${agenda.stalled.length} · Blocked: ${blocked.length}`,
      `weekly:${periodKey}`, now);
    return this.getBriefing(briefing.id)!;
  }

  listBriefings(ownerUserId: string, kind?: Briefing["kind"]): Briefing[] {
    const rows = this.database.db.prepare(`SELECT * FROM briefings WHERE owner_user_id = ? AND (? IS NULL OR kind = ?)
      ORDER BY created_at DESC LIMIT 100`).all(ownerUserId, kind ?? null, kind ?? null) as Record<string, unknown>[];
    return rows.map(briefingFromRow);
  }

  private getBriefing(id: string): Briefing | undefined {
    const row = this.database.db.prepare("SELECT * FROM briefings WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? briefingFromRow(row) : undefined;
  }

  private saveBriefing(ownerUserId: string, kind: Briefing["kind"], periodKey: string,
    content: Record<string, unknown>, meaningful: boolean, now: Date): Briefing {
    const existing = this.database.db.prepare("SELECT * FROM briefings WHERE owner_user_id = ? AND kind = ? AND period_key = ?")
      .get(ownerUserId, kind, periodKey) as Record<string, unknown> | undefined;
    if (existing) return briefingFromRow(existing);
    const id = randomUUID();
    this.database.db.prepare(`INSERT INTO briefings
      (id, owner_user_id, kind, period_key, content_json, meaningful, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ownerUserId, kind, periodKey, JSON.stringify(content), meaningful ? 1 : 0, now.toISOString());
    return this.getBriefing(id)!;
  }

  private queue(ownerUserId: string, kind: AttentionKind, severity: AttentionSeverity, title: string,
    body: string, dedupeKey: string, now: Date): void {
    const settings = this.settings(ownerUserId);
    const local = zonedParts(now, settings.timezone);
    const quiet = isQuiet(local.minute, settings.quietStartMinute, settings.quietEndMinute);
    const held = severity !== "URGENT" && (quiet || (severity === "LOW" && settings.digestMode === "DIGEST"));
    this.database.db.prepare(`INSERT OR IGNORE INTO attention_notifications
      (id, owner_user_id, kind, severity, title, body, dedupe_key, status, available_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), ownerUserId, kind, severity, title, body, dedupeKey, held ? "HELD" : "PENDING", now.toISOString(), now.toISOString());
  }

  async scan(ownerUserId: string, now = new Date()): Promise<void> {
    const settings = this.settings(ownerUserId);
    const agenda = this.agenda(ownerUserId, now);
    for (const alert of agenda.urgentAlerts) this.queue(ownerUserId, "URGENT", "URGENT", alert.title, alert.detail,
      `urgent:${alert.id}:${alert.dueAt ?? "none"}`, now);
    for (const conflict of agenda.conflicts) this.queue(ownerUserId, "CONFLICT", "NORMAL", conflict.title, conflict.detail,
      `conflict:${conflict.id}:${dateKey(now, settings.timezone)}`, now);
    for (const stalled of agenda.stalled) this.queue(ownerUserId, "STALLED", "LOW", `Stalled: ${stalled.title}`,
      `No progress since ${stalled.updatedAt}.`, `stalled:${stalled.id}:${dateKey(now, settings.timezone)}`, now);
    const local = zonedParts(now, settings.timezone);
    if (local.minute >= settings.dailyBriefMinute) this.dailyBrief(ownerUserId, now, true);
    if (local.weekday === settings.weeklyReviewWeekday && local.minute >= settings.weeklyReviewMinute) this.weeklyReview(ownerUserId, now, true);
    await this.flush(ownerUserId, now);
  }

  async flush(ownerUserId: string, now = new Date()): Promise<void> {
    const settings = this.settings(ownerUserId);
    const local = zonedParts(now, settings.timezone);
    const quiet = isQuiet(local.minute, settings.quietStartMinute, settings.quietEndMinute);
    if (!quiet) {
      const held = this.database.db.prepare(`SELECT * FROM attention_notifications WHERE owner_user_id = ?
        AND status = 'HELD' ORDER BY created_at`).all(ownerUserId) as Record<string, unknown>[];
      if (held.length) {
        const key = `digest:${local.date}:${createHash("sha256").update(held.map((row) => asString(row.id)).join(",")).digest("hex").slice(0, 12)}`;
        this.database.db.prepare(`INSERT OR IGNORE INTO attention_notifications
          (id, owner_user_id, kind, severity, title, body, dedupe_key, status, available_at, created_at)
          VALUES (?, ?, 'DIGEST', 'NORMAL', ?, ?, ?, 'PENDING', ?, ?)`)
          .run(randomUUID(), ownerUserId, `Attention digest · ${local.date}`,
            held.map((row) => `• ${asString(row.title)} — ${asString(row.body)}`).join("\n"), key, now.toISOString(), now.toISOString());
        this.database.db.prepare(`UPDATE attention_notifications SET status = 'SUPPRESSED'
          WHERE owner_user_id = ? AND status = 'HELD'`).run(ownerUserId);
      }
    }
    const pending = this.database.db.prepare(`SELECT * FROM attention_notifications WHERE owner_user_id = ?
      AND status = 'PENDING' AND available_at <= ? ORDER BY created_at`).all(ownerUserId, now.toISOString()) as Record<string, unknown>[];
    for (const row of pending) {
      const notification: SecretaryNotification = { id: asString(row.id), title: asString(row.title), detail: asString(row.body),
        kind: asString(row.kind).toLowerCase(), createdAt: asString(row.created_at), read: false };
      await this.notify(notification);
      this.database.db.prepare("UPDATE attention_notifications SET status = 'SENT', sent_at = ? WHERE id = ? AND status = 'PENDING'")
        .run(now.toISOString(), notification.id);
      if (["DAILY_BRIEF", "WEEKLY_REVIEW"].includes(asString(row.kind))) {
        const briefingKind = asString(row.kind) === "DAILY_BRIEF" ? "DAILY" : "WEEKLY";
        this.database.db.prepare(`UPDATE briefings SET delivered_at = ? WHERE owner_user_id = ? AND kind = ?
          AND delivered_at IS NULL`).run(now.toISOString(), ownerUserId, briefingKind);
      }
    }
  }
}
