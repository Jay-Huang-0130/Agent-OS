import { z } from "zod";
import type { AgentDatabase } from "./database.js";
import type { AssistantExecution, AssistantExecutionResult, ExecutionMode, RequestRouter, RouterResult } from "./assistantIntake.js";
import type { ModelRunRequest, ModelRuntime } from "./modelRuntime.js";
import { ModelRuntimeError } from "./modelRuntime.js";
import { ResponsibilityKernel, type GoalRecord, type PlanRecord, type TaskRecord } from "./responsibilityKernel.js";
import {
  AutomationService,
  CapabilityService,
  type AiWakeExecutor,
  type AutomationRecord,
  type JsonSchema,
} from "./wakeEngine.js";

const executionModeSchema = z.enum([
  "DIRECT_RESPONSE", "SINGLE_ACTION", "DETERMINISTIC_AUTOMATION", "CHANGE_WATCHER",
  "BOUNDED_AGENT", "HYBRID_GOAL", "MULTI_TASK_PLAN",
]);
const routerOutputSchema = z.object({
  executionMode: executionModeSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(1_000),
  requiresClarification: z.boolean(),
  clarificationQuestion: z.string().max(1_000),
}).strict();

const routeJsonSchema: Record<string, unknown> = {
  type: "object", additionalProperties: false,
  required: ["executionMode", "confidence", "reason", "requiresClarification", "clarificationQuestion"],
  properties: {
    executionMode: { type: "string", enum: executionModeSchema.options },
    confidence: { type: "number", minimum: 0, maximum: 1 }, reason: { type: "string" },
    requiresClarification: { type: "boolean" }, clarificationQuestion: { type: "string" },
  },
};

const planNodeSchema = z.object({
  id: z.string().min(1).max(80), title: z.string().min(1).max(240),
  kind: z.enum(["ACTION", "ANALYSIS", "VERIFY", "WAIT", "NOTIFY"]),
  dependsOn: z.array(z.string()).max(30),
  completionCriteria: z.array(z.string().min(1)).min(1).max(30),
  allowedTools: z.array(z.string()).max(30),
  maxTokens: z.number().int().min(100).max(100_000),
  maxDurationMs: z.number().int().min(1_000).max(3_600_000),
  maxAttempts: z.number().int().min(1).max(10),
}).strict();

const jsonRecord = z.record(z.unknown());
const automationProposalSchema = z.object({
  executionMode: z.enum(["DETERMINISTIC_AUTOMATION", "AI_EXECUTION"]),
  schedule: z.union([
    z.object({ kind: z.literal("ONCE"), at: z.string().datetime({ offset: true }) }).strict(),
    z.object({ kind: z.literal("INTERVAL"), startAt: z.string().datetime({ offset: true }), everySeconds: z.number().int().min(60) }).strict(),
  ]),
  timezone: z.string().min(1), input: z.unknown(), notificationTemplate: z.string(),
  capability: z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u), version: z.number().int().min(1), description: z.string(),
    sourceCode: z.string().min(1), inputSchema: jsonRecord, outputSchema: jsonRecord,
    permissions: z.array(z.string()), risk: z.literal("LOW"), timeoutMs: z.number().int().min(100).max(60_000), testInput: z.unknown(),
  }).strict().nullable(),
}).strict();

const compiledGoalSchema = z.object({
  title: z.string().min(1).max(240), desiredOutcome: z.string().min(1).max(8_000),
  agentCommitment: z.array(z.string().min(1)).max(100), completionCriteria: z.array(z.string().min(1)).min(1).max(100),
  cancellationCriteria: z.array(z.string()).max(100), externalDependencies: z.array(z.string()).max(100),
  deadline: z.string().datetime({ offset: true }).nullable(), constraints: jsonRecord, priority: jsonRecord,
  attentionPolicy: jsonRecord, budget: jsonRecord,
  autonomy: z.enum(["OBSERVE", "PREPARE", "ASK_BEFORE_ACT", "ACT_WITHIN_POLICY", "FULLY_AUTOMATED"]),
  plan: z.object({ version: z.literal(1), nodes: z.array(planNodeSchema).min(1).max(50) }).strict(),
  automation: automationProposalSchema.nullable(),
}).strict();
export type CompiledGoal = z.infer<typeof compiledGoalSchema>;

const compiledGoalJsonSchema: Record<string, unknown> = {
  type: "object", additionalProperties: false,
  required: ["title", "desiredOutcome", "agentCommitment", "completionCriteria", "cancellationCriteria", "externalDependencies",
    "deadline", "constraintsJson", "priorityJson", "attentionPolicyJson", "budgetJson", "autonomy", "plan", "automationJson"],
  properties: {
    title: { type: "string" }, desiredOutcome: { type: "string" },
    agentCommitment: { type: "array", items: { type: "string" } }, completionCriteria: { type: "array", items: { type: "string" } },
    cancellationCriteria: { type: "array", items: { type: "string" } }, externalDependencies: { type: "array", items: { type: "string" } },
    deadline: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    constraintsJson: { type: "string" }, priorityJson: { type: "string" }, attentionPolicyJson: { type: "string" }, budgetJson: { type: "string" },
    autonomy: { type: "string", enum: ["OBSERVE", "PREPARE", "ASK_BEFORE_ACT", "ACT_WITHIN_POLICY", "FULLY_AUTOMATED"] },
    plan: { type: "object", additionalProperties: false, required: ["version", "nodes"], properties: {
      version: { type: "integer", enum: [1] }, nodes: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["id", "title", "kind", "dependsOn", "completionCriteria", "allowedTools", "maxTokens", "maxDurationMs", "maxAttempts"],
        properties: { id: { type: "string" }, title: { type: "string" }, kind: { type: "string", enum: ["ACTION", "ANALYSIS", "VERIFY", "WAIT", "NOTIFY"] },
          dependsOn: { type: "array", items: { type: "string" } }, completionCriteria: { type: "array", items: { type: "string" } },
          allowedTools: { type: "array", items: { type: "string" } }, maxTokens: { type: "integer" }, maxDurationMs: { type: "integer" }, maxAttempts: { type: "integer" } } } } } },
    automationJson: { type: "string" },
  },
};

export class Phase6RequestRouter implements RequestRouter {
  constructor(private readonly runtime: ModelRuntime) {}

  async route(input: { requestId: string; ownerUserId: string; message: string; model?: string; conversationContext?: string }): Promise<RouterResult> {
    const known = knownRoute(input.message);
    if (known) return known;
    try {
      const result = await this.runtime.run({
        purpose: "ROUTER", ownerUserId: input.ownerUserId, requestId: input.requestId,
        ...(input.model ? { model: input.model } : {}),
        instructions: "Classify intent only. Do not solve it. Prefer clarification for low confidence or irreversible/high-risk actions.",
        input: `${input.conversationContext ? `Conversation so far:\n${input.conversationContext}\n\n` : ""}Latest user message:\n${input.message}`,
        outputSchema: routeJsonSchema, parse: (value) => routerOutputSchema.parse(value), timeoutMs: 30_000,
      });
      const route = result.output;
      const needs = route.requiresClarification || route.confidence < 0.7;
      return {
        state: needs ? "NEEDS_CLARIFICATION" : "ROUTED", executionMode: route.executionMode,
        confidence: route.confidence, reason: needs ? (route.clarificationQuestion || route.reason) : route.reason,
        requiresClarification: needs,
      };
    } catch (error) {
      if (error instanceof ModelRuntimeError && ["unavailable", "unauthenticated"].includes(error.code)) {
        return { state: "PENDING_RUNTIME", executionMode: null, confidence: null, reason: error.message, requiresClarification: null };
      }
      throw error;
    }
  }
}

function knownRoute(message: string): RouterResult | undefined {
  const text = message.trim();
  const highRisk = /(刪除|匯款|付款|購買|下單|發送給所有|delete|transfer money|purchase)/iu.test(text);
  if (highRisk) return { state: "NEEDS_CLARIFICATION", executionMode: "BOUNDED_AGENT", confidence: 0.99,
    reason: "這個要求可能產生不可逆或高風險操作；請確認目標、範圍與授權界線。", requiresClarification: true };
  const scheduled = /(每天|每週|每月|每小時|定期|排程|提醒我|叫我|\d+\s*(?:秒|分鐘|分|小時)\s*後|daily|weekly|monthly|every\s+\d+)/iu.test(text);
  const watching = /(有變化|變更時|更新時|價格低於|庫存|監看|監控|watch|when .*changes?|notify .*when)/iu.test(text);
  if (watching) return { state: "ROUTED", executionMode: "CHANGE_WATCHER", confidence: 0.94,
    reason: "要求以外部狀態變化作為觸發條件。", requiresClarification: false };
  if (scheduled && text.length <= 500) return { state: "ROUTED", executionMode: "DETERMINISTIC_AUTOMATION", confidence: 0.9,
    reason: "要求包含固定排程；Goal Compiler 會再判斷是否足夠簡單且安全，否則改用 AI_EXECUTION。", requiresClarification: false };
  const question = /[?？]$/u.test(text) || /^(什麼|為什麼|如何|怎麼|請解釋|what|why|how|explain)/iu.test(text);
  if (question) return { state: "ROUTED", executionMode: "DIRECT_RESPONSE", confidence: 0.96,
    reason: "這是可直接回答、沒有持續責任的問題。", requiresClarification: false };
  return undefined;
}

export class GoalCompiler {
  constructor(private readonly runtime: ModelRuntime) {}
  async compile(input: { ownerUserId: string; requestId: string; message: string; mode: ExecutionMode;
    model?: string; conversationContext: string; timezone: string; now?: Date }): Promise<CompiledGoal> {
    const now = input.now ?? new Date();
    const result = await this.runtime.run({
      purpose: "GOAL_COMPILER", ownerUserId: input.ownerUserId, requestId: input.requestId,
      ...(input.model ? { model: input.model } : {}),
      instructions: `Compile a versioned Responsibility Contract and bounded Plan IR. Requested execution mode: ${input.mode}.
For a fixed schedule, generate a LOW-risk Python JSON capability only when the work is short, deterministic, testable and needs no judgment. Otherwise choose AI_EXECUTION. Never invent credentials. Every node needs measurable completion criteria and hard budgets.`,
      input: `Current time: ${now.toISOString()}\nTimezone: ${input.timezone}\n${input.conversationContext ? `Conversation so far:\n${input.conversationContext}\n` : ""}Latest user message: ${input.message}\n\nReturn constraintsJson, priorityJson, attentionPolicyJson and budgetJson as JSON object strings. Return automationJson as an empty string when no schedule is needed, otherwise as JSON matching the automation proposal contract.`,
      outputSchema: compiledGoalJsonSchema,
      parse: (value) => parseCompiledGoal(value, { message: input.message, timezone: input.timezone, now }), timeoutMs: 90_000,
    });
    return result.output;
  }
}

function parseCompiledGoal(value: unknown, fallback: { message: string; timezone: string; now: Date }): CompiledGoal {
  const raw = z.object({
    title: z.string(), desiredOutcome: z.string(), agentCommitment: z.array(z.string()), completionCriteria: z.array(z.string()),
    cancellationCriteria: z.array(z.string()), externalDependencies: z.array(z.string()), deadline: z.string().nullable(),
    constraintsJson: z.string(), priorityJson: z.string(), attentionPolicyJson: z.string(), budgetJson: z.string(),
    autonomy: z.string(), plan: z.unknown(), automationJson: z.string(),
  }).strict().parse(value);
  const objectJson = (text: string, field: string): Record<string, unknown> => {
    try { return jsonRecord.parse(JSON.parse(text)); }
    catch { throw new ModelRuntimeError("invalid_output", `${field} must contain a JSON object.`, true); }
  };
  let automation: z.infer<typeof automationProposalSchema> | null = null;
  if (raw.automationJson.trim()) {
    try { automation = normalizeAutomation(JSON.parse(raw.automationJson), fallback); }
    catch (error) {
      const delay = relativeDelayMs(fallback.message);
      if (delay === null) throw new ModelRuntimeError("invalid_output",
        `automationJson could not be normalized: ${error instanceof Error ? error.message : "invalid proposal"}`, true);
      automation = reminderFallback(fallback, delay);
    }
  } else {
    const delay = relativeDelayMs(fallback.message);
    if (delay !== null) automation = reminderFallback(fallback, delay);
  }
  return compiledGoalSchema.parse({
    title: raw.title, desiredOutcome: raw.desiredOutcome, agentCommitment: raw.agentCommitment,
    completionCriteria: raw.completionCriteria, cancellationCriteria: raw.cancellationCriteria,
    externalDependencies: raw.externalDependencies, deadline: raw.deadline,
    constraints: objectJson(raw.constraintsJson, "constraintsJson"), priority: objectJson(raw.priorityJson, "priorityJson"),
    attentionPolicy: objectJson(raw.attentionPolicyJson, "attentionPolicyJson"), budget: objectJson(raw.budgetJson, "budgetJson"),
    autonomy: raw.autonomy, plan: raw.plan, automation,
  });
}

function relativeDelayMs(message: string): number | null {
  const match = message.match(/(\d+)\s*(秒|分鐘|分|小時|seconds?|minutes?|hours?)\s*(?:後|later)/iu);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "秒" || unit?.startsWith("second") ? 1_000
    : unit === "分鐘" || unit === "分" || unit?.startsWith("minute") ? 60_000 : 3_600_000;
  return Math.max(1_000, Math.min(amount * multiplier, 366 * 24 * 60 * 60 * 1_000));
}

function reminderFallback(fallback: { message: string; timezone: string; now: Date }, delayMs: number) {
  return automationProposalSchema.parse({ executionMode: "AI_EXECUTION",
    schedule: { kind: "ONCE", at: new Date(fallback.now.getTime() + delayMs).toISOString() },
    timezone: fallback.timezone, input: { message: fallback.message }, notificationTemplate: "{{message}}", capability: null });
}

function normalizeAutomation(value: unknown, fallback: { message: string; timezone: string; now: Date }) {
  const raw = jsonRecord.parse(value);
  const delay = relativeDelayMs(fallback.message);
  let schedule = raw.schedule;
  if (delay !== null) schedule = { kind: "ONCE", at: new Date(fallback.now.getTime() + delay).toISOString() };
  const capability = raw.capability ?? null;
  let executionMode = raw.executionMode === "DETERMINISTIC_AUTOMATION" ? "DETERMINISTIC_AUTOMATION" : "AI_EXECUTION";
  if (executionMode === "DETERMINISTIC_AUTOMATION" && !automationProposalSchema.shape.capability.unwrap().safeParse(capability).success) {
    executionMode = "AI_EXECUTION";
  }
  return automationProposalSchema.parse({ executionMode, schedule, timezone: typeof raw.timezone === "string" ? raw.timezone : fallback.timezone,
    input: raw.input ?? { message: fallback.message },
    notificationTemplate: typeof raw.notificationTemplate === "string" ? raw.notificationTemplate : "{{message}}",
    capability: executionMode === "DETERMINISTIC_AUTOMATION" ? capability : null });
}

export class PlanRuntime {
  constructor(private readonly kernel: ResponsibilityKernel) {}
  materialize(ownerUserId: string, requestId: string, compiled: CompiledGoal, model?: string): { goal: GoalRecord; plan: PlanRecord; tasks: TaskRecord[] } {
    const goal = this.kernel.createGoal(ownerUserId, {
      title: compiled.title, desiredOutcome: compiled.desiredOutcome, agentCommitment: compiled.agentCommitment,
      completionCriteria: compiled.completionCriteria, cancellationCriteria: compiled.cancellationCriteria,
      externalDependencies: compiled.externalDependencies, ...(compiled.deadline ? { deadline: compiled.deadline } : {}),
      constraints: compiled.constraints, priority: compiled.priority, attentionPolicy: compiled.attentionPolicy,
      budget: compiled.budget, autonomy: compiled.autonomy,
    }, `assistant:${requestId}:goal`);
    const plan = this.kernel.createPlan(goal.id, ownerUserId, compiled.plan as unknown as Record<string, unknown>);
    const tasks = compiled.plan.nodes.map((node, position) => this.kernel.createTask({
      goalId: goal.id, planId: plan.id, title: node.title, kind: node.kind, position,
      specification: { nodeId: node.id, dependsOn: node.dependsOn, completionCriteria: node.completionCriteria,
        allowedTools: node.allowedTools, ...(model ? { selectedModel: model } : {}),
        budget: { maxTokens: node.maxTokens, maxDurationMs: node.maxDurationMs, maxAttempts: node.maxAttempts } },
    }, ownerUserId));
    return { goal, plan, tasks };
  }
}

const directSchema = z.object({ message: z.string().min(1).max(32_000) }).strict();
const directJsonSchema = { type: "object", additionalProperties: false, required: ["message"], properties: { message: { type: "string" } } };

export class Phase6AssistantExecutor implements AssistantExecution {
  private readonly compiler: GoalCompiler;
  private readonly plans: PlanRuntime;
  constructor(
    private readonly runtime: ModelRuntime, kernel: ResponsibilityKernel,
    private readonly capabilities: CapabilityService, private readonly automations: AutomationService,
    private readonly getTimezone: () => string,
    private readonly emit?: ((event: { type: string; data: Record<string, unknown> }) => void),
  ) { this.compiler = new GoalCompiler(runtime); this.plans = new PlanRuntime(kernel); }

  async execute(input: { requestId: string; ownerUserId: string; message: string; model?: string; conversationContext: string;
    route: Exclude<RouterResult, { state: "PENDING_RUNTIME" }> }): Promise<AssistantExecutionResult> {
    if (input.route.state === "NEEDS_CLARIFICATION") return { assistantMessage: `我需要先確認：${input.route.reason}` };
    if (input.route.executionMode === "DIRECT_RESPONSE") {
      const response = await this.runtime.run({ purpose: "DIRECT_RESPONSE", ownerUserId: input.ownerUserId, requestId: input.requestId,
        ...(input.model ? { model: input.model } : {}),
        instructions: "Answer the user's question directly in the user's language. Do not create a Goal.",
        input: `${input.conversationContext ? `Conversation so far:\n${input.conversationContext}\n\n` : ""}Latest user message:\n${input.message}`,
        outputSchema: directJsonSchema, parse: (value) => directSchema.parse(value), timeoutMs: 60_000,
        onDelta: (delta, runId) => this.emit?.({ type: "assistant.response.delta", data: { requestId: input.requestId, runId, delta } }) });
      return { assistantMessage: response.output.message, modelRunId: response.runId };
    }
    const compiled = await this.compiler.compile({ ownerUserId: input.ownerUserId, requestId: input.requestId,
      message: input.message, mode: input.route.executionMode, ...(input.model ? { model: input.model } : {}),
      conversationContext: input.conversationContext, timezone: this.getTimezone() });
    const materialized = this.plans.materialize(input.ownerUserId, input.requestId, compiled, input.model);
    let automation: AutomationRecord | undefined;
    if (compiled.automation) {
      let capabilityId: string | undefined;
      if (compiled.automation.executionMode === "DETERMINISTIC_AUTOMATION") {
        if (!compiled.automation.capability) throw new Error("A deterministic automation proposal requires a capability.");
        const capability = await this.capabilities.register(input.ownerUserId, {
          ...compiled.automation.capability,
          inputSchema: compiled.automation.capability.inputSchema as JsonSchema,
          outputSchema: compiled.automation.capability.outputSchema as JsonSchema,
        });
        capabilityId = capability.id;
      }
      automation = this.automations.create(input.ownerUserId, {
        goalId: materialized.goal.id, ...(capabilityId ? { capabilityId } : {}),
        executionMode: compiled.automation.executionMode, input: compiled.automation.input,
        schedule: compiled.automation.schedule, timezone: compiled.automation.timezone,
        notificationTemplate: compiled.automation.notificationTemplate, misfirePolicy: "RUN_LATEST_ONLY",
      }, `assistant:${input.requestId}:automation`);
    }
    return { goalId: materialized.goal.id,
      assistantMessage: automation
        ? `已建立「${materialized.goal.title}」與版本 1 計畫，並安排 ${automation.executionMode === "DETERMINISTIC_AUTOMATION" ? "0-token Capability" : "AI 執行"}。`
        : `已建立「${materialized.goal.title}」與版本 1 計畫，共 ${materialized.tasks.length} 個受限任務。` };
  }
}

export const resultEnvelopeSchema = z.object({
  status: z.enum(["COMPLETED", "BLOCKED", "FAILED"]), summary: z.string().min(1),
  outputs: z.array(z.object({ name: z.string(), value: z.unknown() }).strict()),
  evidence: z.array(z.object({ kind: z.enum(["ARTIFACT", "OBSERVATION", "SOURCE", "TEST"]), reference: z.string().min(1), summary: z.string().min(1) }).strict()),
  nextActions: z.array(z.string()),
}).strict();
export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;

export class BoundedAgentWorker {
  constructor(private readonly runtime: ModelRuntime) {}
  async execute(packet: { ownerUserId: string; goalId: string; taskId: string; objective: string; context: Record<string, unknown>;
    model?: string; allowedTools: string[]; budget: { maxTokens: number; maxDurationMs: number; maxAttempts: number } }): Promise<ResultEnvelope> {
    const schema = { type: "object", additionalProperties: false, required: ["status", "summary", "outputs", "evidence", "nextActions"],
      properties: { status: { type: "string", enum: ["COMPLETED", "BLOCKED", "FAILED"] }, summary: { type: "string" },
        outputs: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"],
          properties: { name: { type: "string" }, value: { type: "string" } } } },
        evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "reference", "summary"],
          properties: { kind: { type: "string", enum: ["ARTIFACT", "OBSERVATION", "SOURCE", "TEST"] }, reference: { type: "string" }, summary: { type: "string" } } } },
        nextActions: { type: "array", items: { type: "string" } } } };
    let lastError: unknown;
    for (let attempt = 1; attempt <= packet.budget.maxAttempts; attempt += 1) {
      try {
        const result = await this.runtime.run({ purpose: "WORKER", ownerUserId: packet.ownerUserId, goalId: packet.goalId, taskId: packet.taskId,
          ...(packet.model ? { model: packet.model } : {}),
          instructions: `Complete only the Task Packet. Allowed tools: ${packet.allowedTools.join(", ") || "none"}. Return evidence; prose alone cannot complete a task.`,
          input: JSON.stringify({ objective: packet.objective, context: packet.context }), outputSchema: schema,
          parse: (value) => resultEnvelopeSchema.parse(value), timeoutMs: packet.budget.maxDurationMs, maxOutputTokens: packet.budget.maxTokens });
        if (result.usage.outputTokens > packet.budget.maxTokens) throw new ModelRuntimeError("provider_error", "Worker exceeded its token budget.", false);
        if (result.output.status === "COMPLETED" && result.output.evidence.length === 0) {
          throw new ModelRuntimeError("invalid_output", "Completion requires at least one evidence item.", false);
        }
        return result.output;
      } catch (error) { lastError = error; }
    }
    throw lastError;
  }
}

export class TaskVerifier {
  verify(envelope: ResultEnvelope, completionCriteria: string[]): { accepted: boolean; reason: string } {
    if (envelope.status !== "COMPLETED") return { accepted: false, reason: `Worker reported ${envelope.status}.` };
    if (envelope.evidence.length === 0) return { accepted: false, reason: "No evidence was supplied." };
    if (completionCriteria.length === 0) return { accepted: false, reason: "Task has no completion criteria." };
    return { accepted: true, reason: `${envelope.evidence.length} evidence item(s) support ${completionCriteria.length} criterion/criteria.` };
  }
}

export class PlanVerifier {
  verify(taskEnvelopes: Array<{ status: string; result: unknown }>): { accepted: boolean; reason: string } {
    if (taskEnvelopes.length === 0) return { accepted: false, reason: "Plan has no tasks." };
    const incomplete = taskEnvelopes.filter((task) => task.status !== "COMPLETED");
    return incomplete.length === 0
      ? { accepted: true, reason: "Every Plan node has a verified Result Envelope." }
      : { accepted: false, reason: `${incomplete.length} Plan node(s) are not verified.` };
  }
}

export class GoalVerifier {
  verify(goal: GoalRecord, taskEnvelopes: Array<{ status: string; result: unknown }>): { accepted: boolean; evidenceRefs: string[]; reason: string } {
    const plan = new PlanVerifier().verify(taskEnvelopes);
    const evidenceRefs = taskEnvelopes.flatMap((task) => {
      const parsed = resultEnvelopeSchema.safeParse(task.result);
      return parsed.success ? parsed.data.evidence.map((item) => item.reference) : [];
    });
    if (!plan.accepted || evidenceRefs.length === 0 || goal.contract.completionCriteria.length === 0) {
      return { accepted: false, evidenceRefs, reason: plan.accepted ? "Goal completion lacks evidence or criteria." : plan.reason };
    }
    return { accepted: true, evidenceRefs, reason: "All Plan nodes are verified and the Goal has completion evidence." };
  }
}

export class PlanManager {
  private readonly worker: BoundedAgentWorker;
  private readonly verifier = new TaskVerifier();
  constructor(private readonly database: AgentDatabase, private readonly kernel: ResponsibilityKernel, runtime: ModelRuntime) {
    this.worker = new BoundedAgentWorker(runtime);
  }

  async executeTask(ownerUserId: string, taskId: string): Promise<ResultEnvelope> {
    let task = this.kernel.getTask(taskId);
    if (task.status === "PENDING") task = this.kernel.transitionTask(task.id, "READY", ownerUserId);
    if (task.status === "READY") task = this.kernel.transitionTask(task.id, "LEASED", ownerUserId);
    if (task.status !== "LEASED") throw new Error(`Task ${task.id} is not executable from ${task.status}.`);
    task = this.kernel.transitionTask(task.id, "RUNNING", ownerUserId);
    const specification = task.specification;
    const rawBudget = specification.budget as Record<string, unknown> | undefined;
    const criteria = Array.isArray(specification.completionCriteria)
      ? specification.completionCriteria.filter((item): item is string => typeof item === "string") : [];
    const allowedTools = Array.isArray(specification.allowedTools)
      ? specification.allowedTools.filter((item): item is string => typeof item === "string") : [];
    try {
      const envelope = await this.worker.execute({ ownerUserId, goalId: task.goalId, taskId: task.id, objective: task.title,
        ...(typeof specification.selectedModel === "string" ? { model: specification.selectedModel } : {}),
        context: buildManagerContext(this.database, task.goalId), allowedTools,
        budget: { maxTokens: Number(rawBudget?.maxTokens ?? 2_000), maxDurationMs: Number(rawBudget?.maxDurationMs ?? 90_000),
          maxAttempts: Number(rawBudget?.maxAttempts ?? 2) } });
      this.kernel.transitionTask(task.id, "VERIFYING", ownerUserId, envelope);
      const verified = this.verifier.verify(envelope, criteria);
      this.kernel.transitionTask(task.id, verified.accepted ? "COMPLETED" : "FAILED", ownerUserId,
        verified.accepted ? envelope : { ...envelope, verification: verified });
      return envelope;
    } catch (error) {
      this.kernel.transitionTask(task.id, "FAILED", ownerUserId, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

export class ModelAiWakeExecutor implements AiWakeExecutor {
  private readonly manager: PlanManager;
  constructor(private readonly runtime: ModelRuntime, private readonly database: AgentDatabase, kernel: ResponsibilityKernel) {
    this.manager = new PlanManager(database, kernel, runtime);
  }
  async execute(input: { goalId: string; automationId: string; input: unknown }) {
    const goal = this.database.db.prepare("SELECT owner_user_id, desired_outcome FROM goals WHERE id = ?").get(input.goalId) as Record<string, unknown>;
    const task = this.database.db.prepare(`SELECT id FROM tasks WHERE goal_id = ? AND status IN ('PENDING', 'READY')
      ORDER BY position LIMIT 1`).get(input.goalId) as Record<string, unknown> | undefined;
    if (!task) throw new Error("AI execution has no ready bounded Task Packet.");
    const envelope = await this.manager.executeTask(String(goal.owner_user_id), String(task.id));
    const run = this.database.db.prepare(`SELECT usage_json FROM model_runs WHERE task_id = ? AND status = 'COMPLETED'
      ORDER BY created_at DESC LIMIT 1`).get(String(task.id)) as Record<string, unknown> | undefined;
    const usage = run?.usage_json ? JSON.parse(String(run.usage_json)) as Record<string, unknown> : {};
    return { output: { message: envelope.summary, evidence: envelope.evidence }, usage: { modelCalls: 1,
      inputTokens: Number(usage.inputTokens ?? 0), outputTokens: Number(usage.outputTokens ?? 0), toolCalls: 0 } };
  }
}

/** Manager context deliberately excludes raw worker transcripts. */
export function buildManagerContext(database: AgentDatabase, goalId: string): Record<string, unknown> {
  const goal = database.db.prepare("SELECT id, title, desired_outcome, status, current_version FROM goals WHERE id = ?").get(goalId);
  const tasks = database.db.prepare("SELECT id, title, status, result_json FROM tasks WHERE goal_id = ? ORDER BY position")
    .all(goalId) as Array<Record<string, unknown>>;
  return { goal, taskEnvelopes: tasks.map((task) => ({ id: task.id, title: task.title, status: task.status,
    result: task.result_json ? JSON.parse(String(task.result_json)) : null })) };
}
