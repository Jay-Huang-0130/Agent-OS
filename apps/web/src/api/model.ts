export type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";
export type ServiceState = "healthy" | "starting" | "degraded" | "stopped";

export interface MetaResponse {
  name: string;
  version: string;
  setupRequired: boolean;
  secure: boolean;
  hostname: string;
}

export interface SessionResponse {
  authenticated: boolean;
  user?: { id: string; displayName: string; initials: string };
  csrfToken?: string;
}

export interface BootstrapResponse {
  meta: MetaResponse;
  session: SessionResponse;
}

export interface ResourceMetric {
  value: number;
  unit: "%" | "GB" | "°C";
  detail: string;
  status: "normal" | "warning" | "critical";
}

export interface SystemStatus {
  generatedAt: string;
  overall: "healthy" | "degraded" | "unavailable";
  host: { name: string; address: string; platform: string; uptimeSeconds: number; version: string };
  resources: Record<"cpu" | "memory" | "storage" | "temperature", ResourceMetric>;
  services: Array<{ id: string; name: string; detail: string; state: ServiceState; latencyMs?: number }>;
}

export interface ActivityItem {
  id: string;
  title: string;
  detail: string;
  kind: "system" | "security" | "settings" | "update";
  occurredAt: string;
}

export interface NotificationItem {
  id: string;
  title: string;
  detail: string;
  kind: "task" | "attention" | "system";
  createdAt: string;
  read: boolean;
  taskId?: string;
}

export interface Settings {
  deviceName: string;
  language: "zh-Hant" | "en";
  timezone: string;
  theme: "system" | "light" | "dark";
}

export interface OpenAIConnection {
  available: boolean;
  state: "unavailable" | "disconnected" | "connecting" | "connected" | "error";
  authMode: string | null;
  email?: string;
  planType?: string;
  error?: string;
}

export interface OpenAIDeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface SetupInput {
  pairingCode: string;
  password: string;
  displayName: string;
}

export interface AssistantRequestRecord {
  id: string;
  ownerUserId: string;
  message: string;
  status: "PENDING_ROUTING" | "ROUTED" | "NEEDS_CLARIFICATION" | "CANCELLED";
  executionMode: string | null;
  confidence: number | null;
  routingReason: string | null;
  requiresClarification: boolean | null;
  goalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantIntakeReceipt {
  request: AssistantRequestRecord;
  router: {
    state: "PENDING_RUNTIME" | "ROUTED" | "NEEDS_CLARIFICATION";
    executionMode: "DIRECT_RESPONSE" | "SINGLE_ACTION" | "DETERMINISTIC_AUTOMATION"
      | "CHANGE_WATCHER" | "BOUNDED_AGENT" | "HYBRID_GOAL" | "MULTI_TASK_PLAN" | null;
    confidence: number | null;
    reason: string;
    requiresClarification: boolean | null;
  };
  assistantMessage: string;
}

export type GoalStatus = "INBOX" | "CLARIFYING" | "PLANNING" | "ACTIVE" | "WAITING"
  | "WAITING_AUTH" | "NEEDS_APPROVAL" | "RETRYING" | "BLOCKED" | "COMPLETED" | "CANCELLED";
export type AutonomyLevel = "OBSERVE" | "PREPARE" | "ASK_BEFORE_ACT" | "ACT_WITHIN_POLICY" | "FULLY_AUTOMATED";
export type CommitmentOwner = "USER" | "AGENT_OS" | "EXTERNAL_PARTY";
export type CommitmentStatus = "OPEN" | "WAITING" | "FULFILLED" | "BROKEN" | "CANCELLED";

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

export interface ResponsibilityEvent {
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

export interface ProjectDetail {
  project: ProjectRecord;
  goals: GoalRecord[];
  commitments: CommitmentRecord[];
  timeline: ResponsibilityEvent[];
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

export interface CreateGoalInput {
  projectId?: string;
  title: string;
  desiredOutcome: string;
  completionCriteria: string[];
  deadline?: string;
  priority?: Record<string, unknown>;
  attentionPolicy?: Record<string, unknown>;
  autonomy?: AutonomyLevel;
}

export type AgentEvent =
  | { type: "heartbeat"; data: { at: string } }
  | { type: "activity.created"; data: ActivityItem }
  | { type: "settings.updated"; data: Settings }
  | { type: "system.status"; data: SystemStatus }
  | { type: "provider.openai.updated"; data: OpenAIConnection }
  | { type: "assistant.request.received"; data: AssistantRequestRecord }
  | { type: "project.created"; data: ProjectRecord }
  | { type: "goal.accepted" | "goal.paused" | "goal.resumed" | "goal.cancelled" | "goal.progressed" | "goal.blocked" | "goal.completed"; data: GoalRecord }
  | { type: "commitment.created" | "commitment.fulfilled" | "commitment.cancelled"; data: CommitmentRecord }
  | { type: "approval.requested" | "approval.approved" | "approval.rejected"; data: ApprovalRecord }
  | { type: "notification.created"; data: NotificationItem };
