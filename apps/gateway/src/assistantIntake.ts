import type { AgentDatabase, AssistantRequestRecord } from "./database.js";

export interface AssistantIntakeReceipt {
  request: AssistantRequestRecord;
  router: RouterResult;
  assistantMessage: string;
}

export interface AssistantExecutionResult {
  assistantMessage: string;
  goalId?: string;
  modelRunId?: string;
}

export interface AssistantExecution {
  execute(input: {
    requestId: string;
    ownerUserId: string;
    message: string;
    route: Exclude<RouterResult, { state: "PENDING_RUNTIME" }>;
  }): Promise<AssistantExecutionResult>;
}

export type ExecutionMode = "DIRECT_RESPONSE" | "SINGLE_ACTION" | "DETERMINISTIC_AUTOMATION"
  | "CHANGE_WATCHER" | "BOUNDED_AGENT" | "HYBRID_GOAL" | "MULTI_TASK_PLAN";

export type RouterResult = {
  state: "PENDING_RUNTIME";
  executionMode: null;
  confidence: null;
  reason: string;
  requiresClarification: null;
} | {
  state: "ROUTED" | "NEEDS_CLARIFICATION";
  executionMode: ExecutionMode;
  confidence: number;
  reason: string;
  requiresClarification: boolean;
};

export interface RequestRouter {
  route(input: { requestId: string; ownerUserId: string; message: string }): Promise<RouterResult>;
}

export class PendingRuntimeRouter implements RequestRouter {
  async route(): Promise<RouterResult> {
    return {
      state: "PENDING_RUNTIME",
      executionMode: null,
      confidence: null,
      reason: "The Phase 6 Request Router is not connected yet.",
      requiresClarification: null,
    };
  }
}

/**
 * Stable boundary between the conversation UI and the future Phase 6 Router.
 * Intake records raw user intent; it must never infer or create a Goal itself.
 */
export class AssistantIntakeService {
  constructor(
    private readonly database: AgentDatabase,
    private readonly router: RequestRouter = new PendingRuntimeRouter(),
    private readonly execution?: AssistantExecution,
  ) {}

  async accept(ownerUserId: string, message: string, idempotencyKey?: string): Promise<AssistantIntakeReceipt> {
    let request = this.database.createAssistantRequest(ownerUserId, message, idempotencyKey);
    if (request.message !== message) {
      throw new AssistantIntakeError(
        "idempotency_conflict",
        "This Idempotency-Key was already used for a different assistant request.",
      );
    }
    if (request.status !== "PENDING_ROUTING") {
      const result: Exclude<RouterResult, { state: "PENDING_RUNTIME" }> = {
        state: request.status === "NEEDS_CLARIFICATION" ? "NEEDS_CLARIFICATION" : "ROUTED",
        executionMode: request.executionMode as ExecutionMode,
        confidence: request.confidence ?? 0,
        reason: request.routingReason ?? "Previously routed.",
        requiresClarification: request.requiresClarification ?? false,
      };
      if (request.assistantMessage || !this.execution) {
        return { request, router: result, assistantMessage: request.assistantMessage ?? assistantMessageFor(result) };
      }
      const outcome = await this.execution.execute({ requestId: request.id, ownerUserId, message, route: result });
      request = this.database.recordAssistantOutcome(request.id, ownerUserId, outcome);
      return { request, router: result, assistantMessage: outcome.assistantMessage };
    }
    const result = await this.router.route({ requestId: request.id, ownerUserId, message });
    if (result.state !== "PENDING_RUNTIME") {
      request = this.database.recordAssistantRouting(request.id, ownerUserId, result);
      const outcome = this.execution
        ? await this.execution.execute({ requestId: request.id, ownerUserId, message, route: result })
        : { assistantMessage: assistantMessageFor(result) };
      request = this.database.recordAssistantOutcome(request.id, ownerUserId, outcome);
      return { request, router: result, assistantMessage: outcome.assistantMessage };
    }
    return { request, router: result, assistantMessage: assistantMessageFor(result) };
  }

  list(ownerUserId: string, limit?: number): AssistantRequestRecord[] {
    return this.database.listAssistantRequests(ownerUserId, limit);
  }
}

function assistantMessageFor(result: RouterResult): string {
  if (result.state === "PENDING_RUNTIME") {
    return "我已保存這則訊息。Request Router 接入後會自動判斷這是問答、單次工作、自動化、Watcher 或長期 Goal；目前不會要求你先分類，也不會擅自建立 Goal。";
  }
  if (result.state === "NEEDS_CLARIFICATION") return `我需要先確認一件事：${result.reason}`;
  return `已判斷處理方式為 ${result.executionMode}。${result.reason}`;
}

export class AssistantIntakeError extends Error {
  constructor(readonly code: "idempotency_conflict", message: string) {
    super(message);
    this.name = "AssistantIntakeError";
  }
}
