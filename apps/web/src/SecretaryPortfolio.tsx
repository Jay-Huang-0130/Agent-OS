import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AgentClient, ApiError } from "./api/agentClient";
import type {
  AutonomyLevel,
  CommitmentOwner,
  GoalRecord,
  GoalStatus,
  PortfolioSnapshot,
  ProjectDetail,
  ProjectRecord,
} from "./api/model";
import { Icon, type IconName } from "./components/Icon";

const autonomyLabels: Record<AutonomyLevel, string> = {
  OBSERVE: "Observe",
  PREPARE: "Prepare",
  ASK_BEFORE_ACT: "Ask Before Act",
  ACT_WITHIN_POLICY: "Act Within Policy",
  FULLY_AUTOMATED: "Fully Automated",
};

const statusLabels: Record<GoalStatus, string> = {
  INBOX: "收件匣",
  CLARIFYING: "待澄清",
  PLANNING: "規劃中",
  ACTIVE: "進行中",
  WAITING: "等待外部",
  WAITING_AUTH: "等待登入",
  NEEDS_APPROVAL: "等待批准",
  RETRYING: "重試中",
  BLOCKED: "受阻",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "操作失敗，請稍後再試。";
}

function formatDate(value: string | null): string {
  if (!value) return "未設定";
  return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function priorityLabel(goal: GoalRecord): string {
  const urgency = goal.contract.priority.urgency;
  const rank = goal.contract.priority.userRank;
  if (urgency === "high" || (typeof rank === "number" && rank <= 2)) return "高優先";
  if (urgency === "low") return "低優先";
  return "一般";
}

function GoalCard({ goal, onOpen }: { goal: GoalRecord; onOpen: (goal: GoalRecord) => void }) {
  return <button className="secretary-goal-card" onClick={() => onOpen(goal)}>
    <div className="secretary-goal-head"><span className={`goal-status ${goal.status.toLowerCase()}`}>{statusLabels[goal.status]}</span><small>{priorityLabel(goal)}</small></div>
    <h3>{goal.title}</h3>
    <p>{goal.desiredOutcome}</p>
    <footer><span><Icon name="update" size={14} />{goal.contract.deadline ? formatDate(goal.contract.deadline) : "沒有截止日"}</span><span>{autonomyLabels[goal.autonomy]}</span></footer>
  </button>;
}

function EmptySection({ text }: { text: string }) {
  return <div className="secretary-empty"><Icon name="check" /><span>{text}</span></div>;
}

function PortfolioSection({
  title,
  note,
  icon,
  goals,
  onOpen,
}: {
  title: string;
  note: string;
  icon: IconName;
  goals: GoalRecord[];
  onOpen: (goal: GoalRecord) => void;
}) {
  return <section className="secretary-section">
    <header><span><Icon name={icon} size={18} /></span><div><h2>{title}</h2><p>{note}</p></div><b>{goals.length}</b></header>
    {goals.length ? <div className="secretary-goal-list">{goals.map((goal) => <GoalCard key={goal.id} goal={goal} onOpen={onOpen} />)}</div> : <EmptySection text="目前沒有項目" />}
  </section>;
}

function DecisionQueue({
  snapshot,
  onOpen,
  onDecide,
}: {
  snapshot: PortfolioSnapshot;
  onOpen: (goal: GoalRecord) => void;
  onDecide: (id: string, decision: "APPROVED" | "REJECTED") => Promise<void>;
}) {
  return <section className="secretary-section decision-section"><header><span><Icon name="warning" size={18} /></span><div><h2>Needs Decision</h2><p>需要使用者明確批准或拒絕</p></div><b>{snapshot.approvals.length}</b></header>{snapshot.approvals.length ? <div className="decision-list">{snapshot.approvals.map((approval) => {
    const goal = snapshot.needsDecision.find((item) => item.id === approval.goalId);
    const summary = typeof approval.action.summary === "string" ? approval.action.summary : JSON.stringify(approval.action);
    return <article key={approval.id}><button className="decision-copy" onClick={() => { if (goal) onOpen(goal); }}><span>{approval.risk}</span><strong>{goal?.title ?? "Goal decision"}</strong><p>{summary}</p></button><div><button className="secondary" onClick={() => void onDecide(approval.id, "REJECTED")}>拒絕</button><button className="primary" onClick={() => void onDecide(approval.id, "APPROVED")}>批准</button></div></article>;
  })}</div> : <EmptySection text="目前沒有待決定項目" />}</section>;
}

function CreateDialog({
  mode,
  projects,
  initialProjectId,
  client,
  onClose,
  onCreated,
}: {
  mode: "project" | "goal";
  projects: ProjectRecord[];
  initialProjectId?: string;
  client: AgentClient;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [outcome, setOutcome] = useState("");
  const [completion, setCompletion] = useState("");
  const [deadline, setDeadline] = useState("");
  const [priority, setPriority] = useState<"high" | "normal" | "low">("normal");
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("ASK_BEFORE_ACT");
  const [attention, setAttention] = useState<"exceptions" | "deadlines" | "all">("exceptions");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "project") {
        await client.createProject({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
      } else {
        await client.createGoal({
          ...(projectId ? { projectId } : {}),
          title: name.trim(),
          desiredOutcome: outcome.trim(),
          completionCriteria: [completion.trim()],
          ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
          priority: { urgency: priority, userRank: priority === "high" ? 1 : priority === "low" ? 5 : 3 },
          attentionPolicy: attention === "all"
            ? { notifyWhen: ["progressed", "deadline_near", "needs_decision", "blocked", "completed"] }
            : attention === "deadlines"
              ? { notifyWhen: ["deadline_near", "needs_decision", "blocked", "completed"] }
              : { notifyWhen: ["needs_decision", "blocked"], stayQuietWhen: ["normal_progress", "no_change"] },
          autonomy,
        });
      }
      await onCreated();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  const valid = mode === "project" ? Boolean(name.trim()) : Boolean(name.trim() && outcome.trim() && completion.trim());
  return <div className="secretary-modal-layer" role="presentation" onMouseDown={onClose}>
    <form className="secretary-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><p className="eyebrow">{mode === "project" ? "New project" : "Delegate responsibility"}</p><h2>{mode === "project" ? "建立 Project" : "交辦新的 Goal"}</h2></div><button type="button" className="icon-only" onClick={onClose}><Icon name="close" /></button></header>
      <label>{mode === "project" ? "Project 名稱" : "Goal 標題"}<input value={name} onChange={(event) => setName(event.target.value)} autoFocus maxLength={240} /></label>
      {mode === "project" ? <label>說明<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} maxLength={4000} /></label> : <>
        <label>所屬 Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">不指定 Project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label>Desired Outcome<textarea value={outcome} onChange={(event) => setOutcome(event.target.value)} rows={3} /></label>
        <label>完成條件<textarea value={completion} onChange={(event) => setCompletion(event.target.value)} rows={2} /></label>
        <div className="secretary-form-grid"><label>截止時間<input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label><label>優先順序<select value={priority} onChange={(event) => setPriority(event.target.value as typeof priority)}><option value="high">高</option><option value="normal">一般</option><option value="low">低</option></select></label></div>
        <div className="secretary-form-grid"><label>Autonomy Contract<select value={autonomy} onChange={(event) => setAutonomy(event.target.value as AutonomyLevel)}>{Object.entries(autonomyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Attention Policy<select value={attention} onChange={(event) => setAttention(event.target.value as typeof attention)}><option value="exceptions">只通知決定與阻塞</option><option value="deadlines">截止、完成與例外</option><option value="all">所有重要進度</option></select></label></div>
      </>}
      {error && <div className="error-box"><Icon name="warning" />{error}</div>}
      <footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={busy || !valid}>{busy ? "儲存中…" : mode === "project" ? "建立 Project" : "接受 Goal"}</button></footer>
    </form>
  </div>;
}

function CommitmentDialog({
  detail,
  client,
  onClose,
  onCreated,
}: {
  detail: ProjectDetail;
  client: AgentClient;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [goalId, setGoalId] = useState(detail.goals[0]?.id ?? "");
  const [owner, setOwner] = useState<CommitmentOwner>("AGENT_OS");
  const [owedTo, setOwedTo] = useState<CommitmentOwner>("USER");
  const [promise, setPromise] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await client.createCommitment({
        goalId,
        owner,
        owedTo,
        promise: promise.trim(),
        ...(dueAt ? { dueAt: new Date(dueAt).toISOString(), followUpPolicy: "remind_24h_before" } : {}),
      });
      await onCreated(); onClose();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  };
  return <div className="secretary-modal-layer" role="presentation" onMouseDown={onClose}><form className="secretary-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">Commitment ledger</p><h2>新增承諾</h2></div><button type="button" className="icon-only" onClick={onClose}><Icon name="close" /></button></header><label>關聯 Goal<select value={goalId} onChange={(event) => setGoalId(event.target.value)}>{detail.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label><div className="secretary-form-grid"><label>承諾人<select value={owner} onChange={(event) => setOwner(event.target.value as CommitmentOwner)}><option value="USER">使用者</option><option value="AGENT_OS">Agent-OS</option><option value="EXTERNAL_PARTY">外部對象</option></select></label><label>承諾對象<select value={owedTo} onChange={(event) => setOwedTo(event.target.value as CommitmentOwner)}><option value="USER">使用者</option><option value="AGENT_OS">Agent-OS</option><option value="EXTERNAL_PARTY">外部對象</option></select></label></div><label>承諾內容<textarea value={promise} onChange={(event) => setPromise(event.target.value)} rows={3} /></label><label>到期時間<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>{error && <div className="error-box"><Icon name="warning" />{error}</div>}<footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={busy || !goalId || !promise.trim()}>{busy ? "儲存中…" : "加入 Ledger"}</button></footer></form></div>;
}

function ProjectDrawer({
  projectId,
  client,
  onClose,
  onChanged,
}: {
  projectId: string;
  client: AgentClient;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<ProjectDetail>();
  const [error, setError] = useState("");
  const [commitmentOpen, setCommitmentOpen] = useState(false);
  const load = async () => {
    try { setDetail(await client.projectDetail(projectId)); setError(""); } catch (cause) { setError(errorMessage(cause)); }
  };
  useEffect(() => { void load(); }, [projectId]);
  const goalAction = async (goal: GoalRecord, action: "pause" | "resume" | "cancel") => {
    if (action === "cancel" && !window.confirm(`確定取消「${goal.title}」？這會留下永久 Audit event。`)) return;
    try { await client.goalAction(goal.id, action); await Promise.all([load(), onChanged()]); } catch (cause) { setError(errorMessage(cause)); }
  };
  const commitmentAction = async (id: string, action: "fulfill" | "cancel") => {
    try { await client.commitmentAction(id, action); await Promise.all([load(), onChanged()]); } catch (cause) { setError(errorMessage(cause)); }
  };
  return <div className="secretary-drawer-layer" role="presentation" onMouseDown={onClose}><aside className="secretary-drawer" onMouseDown={(event) => event.stopPropagation()}>{!detail ? <div className="secretary-loading"><span className="loader" />{error || "讀取 Project…"}</div> : <><header><div><p className="eyebrow">Project detail</p><h2>{detail.project.name}</h2><p>{detail.project.description || "沒有額外說明"}</p></div><button className="icon-only" onClick={onClose}><Icon name="close" /></button></header>{error && <div className="error-box"><Icon name="warning" />{error}</div>}<section><div className="secretary-drawer-title"><h3>Goals</h3><span>{detail.goals.length}</span></div><div className="detail-goals">{detail.goals.map((goal) => <article key={goal.id}><div><span className={`goal-status ${goal.status.toLowerCase()}`}>{statusLabels[goal.status]}</span><small>{autonomyLabels[goal.autonomy]}</small></div><h4>{goal.title}</h4><p>{goal.desiredOutcome}</p>{goal.stateReason && <em><Icon name="warning" size={14} />{goal.stateReason}</em>}<footer>{goal.status === "ACTIVE" && <button onClick={() => void goalAction(goal, "pause")}>暫停</button>}{["WAITING", "BLOCKED"].includes(goal.status) && <button onClick={() => void goalAction(goal, "resume")}>恢復</button>}{!["COMPLETED", "CANCELLED"].includes(goal.status) && <button className="danger-link" onClick={() => void goalAction(goal, "cancel")}>取消</button>}</footer></article>)}</div></section><section><div className="secretary-drawer-title"><h3>Commitment Ledger</h3><button onClick={() => setCommitmentOpen(true)} disabled={!detail.goals.length}>＋ 新增承諾</button></div>{detail.commitments.length ? <div className="commitment-list">{detail.commitments.map((item) => <article key={item.id}><span className={`commitment-owner ${item.owner.toLowerCase()}`}>{item.owner === "USER" ? "使用者" : item.owner === "AGENT_OS" ? "Agent-OS" : "外部對象"}</span><div><strong>{item.promise}</strong><small>{item.dueAt ? `到期：${formatDate(item.dueAt)}` : "未設定到期時間"}</small></div><b>{item.status}</b>{["OPEN", "WAITING", "BROKEN"].includes(item.status) && <div><button onClick={() => void commitmentAction(item.id, "fulfill")}>完成</button><button onClick={() => void commitmentAction(item.id, "cancel")}>取消</button></div>}</article>)}</div> : <EmptySection text="尚未建立承諾" />}</section><section><div className="secretary-drawer-title"><h3>Timeline</h3><span>{detail.timeline.length}</span></div><div className="secretary-timeline">{detail.timeline.map((event) => <div key={event.id}><i /><span><strong>{event.type}</strong><small>{formatDate(event.occurredAt)}・{event.actor}</small></span></div>)}</div></section><section><div className="secretary-drawer-title"><h3>Artifacts</h3><span>{detail.artifacts.length}</span></div>{detail.artifacts.length ? detail.artifacts.map((artifact) => <a className="secretary-artifact" href={artifact.uri} key={artifact.id}><Icon name="storage" /><span><strong>{artifact.kind}</strong><small>{artifact.uri}</small></span></a>) : <EmptySection text="尚無 Artifact reference" />}</section></>}{commitmentOpen && detail && <CommitmentDialog detail={detail} client={client} onClose={() => setCommitmentOpen(false)} onCreated={async () => { await Promise.all([load(), onChanged()]); }} />}</aside></div>;
}

export function SecretaryOverview({
  name,
  snapshot,
  projects,
  client,
  onChanged,
  onChat,
}: {
  name: string;
  snapshot: PortfolioSnapshot;
  projects: ProjectRecord[];
  client: AgentClient;
  onChanged: () => Promise<void>;
  onChat: () => void;
}) {
  const [createMode, setCreateMode] = useState<"project" | "goal">();
  const [projectId, setProjectId] = useState<string>();
  const [error, setError] = useState("");
  const openGoal = (goal: GoalRecord) => { if (goal.projectId) setProjectId(goal.projectId); };
  const decide = async (id: string, decision: "APPROVED" | "REJECTED") => {
    try {
      await client.decideApproval(id, decision, decision === "APPROVED" ? "Approved by the owner." : "Rejected by the owner.");
      await onChanged();
      setError("");
    } catch (cause) { setError(errorMessage(cause)); }
  };
  return <div className="secretary-page"><header className="secretary-hero"><div><p className="today-date">{new Intl.DateTimeFormat("zh-TW", { dateStyle: "full" }).format(new Date())}</p><h1>早安，{name}</h1><p>這裡只顯示 Durable Responsibility Store 的真實資料。</p></div><div className="secretary-modes"><button className="primary" onClick={onChat}><Icon name="sparkle" />告訴 Agent-OS</button></div></header>{error && <div className="error-box"><Icon name="warning" />{error}</div>}<div className="secretary-summary"><div><strong>{snapshot.today.length}</strong><span>Today</span></div><div><strong>{snapshot.waitingOnYou.length}</strong><span>Waiting on You</span></div><div><strong>{snapshot.activeProjects.length}</strong><span>Active Projects</span></div><div><strong>{snapshot.commitments.filter((item) => ["OPEN", "WAITING", "BROKEN"].includes(item.status)).length}</strong><span>Open Commitments</span></div></div><div className="secretary-grid"><PortfolioSection title="Today" note="高優先、已到期或今天截止" icon="dashboard" goals={snapshot.today} onOpen={openGoal} /><PortfolioSection title="Waiting on You" note="等待澄清、批准、登入或你的承諾" icon="key" goals={snapshot.waitingOnYou} onOpen={openGoal} /><PortfolioSection title="Waiting on Others" note="等待外部對象或外部條件" icon="globe" goals={snapshot.waitingOnOthers} onOpen={openGoal} /><PortfolioSection title="Upcoming" note="有未來截止時間的責任" icon="update" goals={snapshot.upcoming} onOpen={openGoal} /><DecisionQueue snapshot={snapshot} onOpen={openGoal} onDecide={decide} /><PortfolioSection title="Recently Completed" note="最近驗證完成的 Goal" icon="check" goals={snapshot.recentlyCompleted} onOpen={openGoal} /></div><section className="active-projects-section"><header><div><p className="eyebrow">Portfolio</p><h2>Active Projects</h2></div><button className="secondary" onClick={() => setCreateMode("project")}>＋ 建立 Project</button></header>{snapshot.activeProjects.length ? <div className="active-project-grid">{snapshot.activeProjects.map((project) => <button key={project.id} onClick={() => setProjectId(project.id)}><span><Icon name="storage" /></span><div><h3>{project.name}</h3><p>{project.description || "沒有額外說明"}</p><small>{project.activeGoalCount} Goals・{project.openCommitmentCount} Commitments</small></div><Icon name="chevron" /></button>)}</div> : <EmptySection text="建立第一個 Project，開始管理長期責任" />}</section>{createMode && <CreateDialog mode={createMode} projects={projects} client={client} onClose={() => setCreateMode(undefined)} onCreated={onChanged} />}{projectId && <ProjectDrawer projectId={projectId} client={client} onClose={() => setProjectId(undefined)} onChanged={onChanged} />}</div>;
}

export function ResponsibilitiesPage({
  goals,
  projects,
  client,
  onChanged,
}: {
  goals: GoalRecord[];
  projects: ProjectRecord[];
  client: AgentClient;
  onChanged: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<"OPEN" | "WAITING" | "DONE" | "ALL">("OPEN");
  const [createMode, setCreateMode] = useState<"project" | "goal">();
  const [projectId, setProjectId] = useState<string>();
  const visible = useMemo(() => goals.filter((goal) => filter === "ALL"
    || (filter === "DONE" ? ["COMPLETED", "CANCELLED"].includes(goal.status)
      : filter === "WAITING" ? ["CLARIFYING", "WAITING", "WAITING_AUTH", "NEEDS_APPROVAL", "BLOCKED"].includes(goal.status)
        : !["COMPLETED", "CANCELLED", "CLARIFYING", "WAITING", "WAITING_AUTH", "NEEDS_APPROVAL", "BLOCKED"].includes(goal.status))), [goals, filter]);
  return <div className="responsibilities-page"><header><div><p className="eyebrow">Responsibilities</p><h1>Projects 與 Goals</h1><p>所有內容都直接來自 SQLite Responsibility Kernel。</p></div><div><button className="secondary" onClick={() => setCreateMode("project")}>建立 Project</button><button className="primary" onClick={() => setCreateMode("goal")}>交辦 Goal</button></div></header><div className="responsibility-filters">{(["OPEN", "WAITING", "DONE", "ALL"] as const).map((value) => <button className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{value === "OPEN" ? "進行中" : value === "WAITING" ? "等待／受阻" : value === "DONE" ? "已結束" : "全部"}<span>{value === "ALL" ? goals.length : undefined}</span></button>)}</div>{visible.length ? <div className="responsibility-list">{visible.map((goal) => <GoalCard key={goal.id} goal={goal} onOpen={(item) => { if (item.projectId) setProjectId(item.projectId); }} />)}</div> : <EmptySection text="這個分類目前沒有 Goal" />}{createMode && <CreateDialog mode={createMode} projects={projects} client={client} onClose={() => setCreateMode(undefined)} onCreated={onChanged} />}{projectId && <ProjectDrawer projectId={projectId} client={client} onClose={() => setProjectId(undefined)} onChanged={onChanged} />}</div>;
}
