import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentDatabase } from "./database.js";

export type ModelPurpose = "ROUTER" | "DIRECT_RESPONSE" | "GOAL_COMPILER" | "WORKER" | "VERIFIER" | "WAKE";
export type ModelRunStatus = "RUNNING" | "COMPLETED" | "FAILED" | "TIMED_OUT" | "INTERRUPTED";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export interface ModelRunRequest<T> {
  purpose: ModelPurpose;
  ownerUserId: string;
  requestId?: string;
  goalId?: string;
  taskId?: string;
  instructions: string;
  input: string;
  outputSchema: Record<string, unknown>;
  parse(output: unknown): T;
  timeoutMs?: number;
  maxOutputTokens?: number;
  onDelta?: (delta: string, runId: string) => void;
}

export interface ModelRunResult<T> {
  runId: string;
  provider: string;
  model: string;
  threadId: string;
  turnId: string;
  output: T;
  usage: ModelUsage;
  durationMs: number;
}

export interface ModelRuntime {
  run<T>(request: ModelRunRequest<T>): Promise<ModelRunResult<T>>;
  interrupt(runId: string): Promise<boolean>;
}

export class ModelRuntimeError extends Error {
  constructor(
    readonly code: "unavailable" | "unauthenticated" | "timeout" | "interrupted" | "invalid_output" | "provider_error",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ModelRuntimeError";
  }
}

export function normalizeModelError(error: unknown): ModelRuntimeError {
  if (error instanceof ModelRuntimeError) return error;
  const message = error instanceof Error ? error.message : String(error ?? "Model runtime failed.");
  if (/timed? out|timeout/iu.test(message)) return new ModelRuntimeError("timeout", message, true);
  if (/interrupt|cancel/iu.test(message)) return new ModelRuntimeError("interrupted", message, false);
  if (/login|auth|credential/iu.test(message)) return new ModelRuntimeError("unauthenticated", message, false);
  if (/not installed|not running|unavailable/iu.test(message)) return new ModelRuntimeError("unavailable", message, true);
  return new ModelRuntimeError("provider_error", message.replace(/[\r\n]+/gu, " ").slice(0, 500), true);
}

export class UnavailableModelRuntime implements ModelRuntime {
  async run<T>(): Promise<ModelRunResult<T>> {
    throw new ModelRuntimeError("unavailable", "The Codex model runtime is unavailable.", true);
  }
  async interrupt(): Promise<boolean> { return false; }
}

/** Persists normalized runs without granting the model authority over Goal state. */
export class TrackedModelRuntime implements ModelRuntime {
  private readonly activeDelegateIds = new Map<string, string>();
  constructor(private readonly database: AgentDatabase, private readonly delegate: ModelRuntime) {}

  async run<T>(request: ModelRunRequest<T>): Promise<ModelRunResult<T>> {
    const runId = randomUUID();
    const startedAt = new Date();
    this.database.db.prepare(`INSERT INTO model_runs
      (id, owner_user_id, request_id, goal_id, task_id, purpose, provider, model, status,
       budget_json, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'codex_app_server', 'pending', 'RUNNING', ?, ?, ?, ?)`)
      .run(runId, request.ownerUserId, request.requestId ?? null, request.goalId ?? null, request.taskId ?? null,
        request.purpose, JSON.stringify({ timeoutMs: request.timeoutMs ?? 60_000, maxOutputTokens: request.maxOutputTokens ?? null }),
        startedAt.toISOString(), startedAt.toISOString(), startedAt.toISOString());
    try {
      const result = await this.delegate.run({ ...request, onDelta: (delta, delegateId) => {
        this.activeDelegateIds.set(runId, delegateId);
        request.onDelta?.(delta, runId);
      } });
      const now = new Date().toISOString();
      this.database.db.prepare(`UPDATE model_runs SET provider = ?, model = ?, thread_id = ?, turn_id = ?,
        status = 'COMPLETED', output_json = ?, usage_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(result.provider, result.model, result.threadId, result.turnId, JSON.stringify(result.output),
          JSON.stringify(result.usage), now, now, runId);
      this.activeDelegateIds.delete(runId);
      return { ...result, runId };
    } catch (cause) {
      const error = normalizeModelError(cause);
      const status: ModelRunStatus = error.code === "timeout" ? "TIMED_OUT"
        : error.code === "interrupted" ? "INTERRUPTED" : "FAILED";
      const now = new Date().toISOString();
      this.database.db.prepare(`UPDATE model_runs SET status = ?, error_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(status, JSON.stringify({ code: error.code, message: error.message, retryable: error.retryable }), now, now, runId);
      this.activeDelegateIds.delete(runId);
      throw error;
    }
  }

  interrupt(runId: string): Promise<boolean> {
    const delegateId = this.activeDelegateIds.get(runId);
    return delegateId ? this.delegate.interrupt(delegateId) : Promise.resolve(false);
  }
}

export const jsonObjectSchema = z.record(z.unknown());
