import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AgentClient, ApiError } from "./api/agentClient";
import type {
  AutomationRecord,
  AutonomyLevel,
  CapabilityRecord,
  CommitmentOwner,
  GoalDetail,
  GoalRecord,
  GoalStatus,
  PortfolioSnapshot,
  ProjectDetail,
  ProjectRecord,
  WatcherRecord,
  WatcherSnapshot,
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

function contractList(items: string[], empty: string) {
  return items.length ? <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p>{empty}</p>;
}

function scheduleLabel(automation: AutomationRecord): string {
  return automation.schedule.kind === "ONCE"
    ? `單次・${formatDate(automation.schedule.at)}`
    : `每 ${Math.round(automation.schedule.everySeconds / 60)} 分鐘・起始 ${formatDate(automation.schedule.startAt)}`;
}

function GoalDrawer({ goalId, automations, client, onClose, onChanged }: {
  goalId: string;
  automations: AutomationRecord[];
  client: AgentClient;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<GoalDetail>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [watcherDetails, setWatcherDetails] = useState<Record<string, WatcherSnapshot>>({});
  const load = async () => {
    try {
      const next = await client.goalDetail(goalId);
      setDetail(next);
      const snapshots = await Promise.allSettled((next.watchers ?? []).map((watcher) => client.watcherDetail(watcher.id)));
      setWatcherDetails(Object.fromEntries(snapshots.flatMap((result) => result.status === "fulfilled" ? [[result.value.id, result.value]] : [])));
      setError("");
    }
    catch (cause) { setError(errorMessage(cause)); }
  };
  useEffect(() => {
    setDetail(undefined);
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [goalId]);
  const act = async (action: "pause" | "resume" | "cancel") => {
    if (!detail || (action === "cancel" && !window.confirm(`確定取消「${detail.goal.title}」？`))) return;
    setBusy(true);
    try { await client.goalAction(goalId, action); await Promise.all([load(), onChanged()]); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const relatedAutomations = automations.filter((item) => item.goalId === goalId);
  const relatedWatchers = detail?.watchers ?? [];
  const activePlan = detail?.plans.find((plan) => plan.status === "ACTIVE") ?? detail?.plans[0];
  return <div className="secretary-drawer-layer" role="presentation" onMouseDown={onClose}><aside className="secretary-drawer goal-detail-drawer" onMouseDown={(event) => event.stopPropagation()}>{!detail ? <div className="secretary-loading"><span className="loader" />{error || "讀取 Goal 詳細資料…"}</div> : <>
    <header><div><div className="goal-detail-status"><span className={`goal-status ${detail.goal.status.toLowerCase()}`}>{statusLabels[detail.goal.status]}</span><span>Contract v{detail.goal.currentVersion}</span></div><h2>{detail.goal.title}</h2><p>{detail.goal.desiredOutcome}</p></div><button className="icon-only" onClick={onClose}><Icon name="close" /></button></header>
    {error && <div className="error-box"><Icon name="warning" />{error}</div>}
    <section className="goal-detail-overview"><div><span>優先順序</span><strong>{priorityLabel(detail.goal)}</strong></div><div><span>自主程度</span><strong>{autonomyLabels[detail.goal.autonomy]}</strong></div><div><span>截止時間</span><strong>{formatDate(detail.goal.contract.deadline)}</strong></div><div><span>更新時間</span><strong>{formatDate(detail.goal.updatedAt)}</strong></div></section>
    {detail.goal.stateReason && <div className="goal-state-reason"><Icon name="warning" size={16} /><span><strong>目前狀態說明</strong>{detail.goal.stateReason}</span></div>}
    <section><div className="secretary-drawer-title"><h3>Responsibility Contract</h3><span>v{detail.goal.currentVersion}</span></div><div className="contract-grid"><article><h4>Agent 承諾</h4>{contractList(detail.goal.contract.agentCommitment, "沒有額外承諾")}</article><article><h4>完成條件</h4>{contractList(detail.goal.contract.completionCriteria, "沒有完成條件")}</article><article><h4>取消條件</h4>{contractList(detail.goal.contract.cancellationCriteria, "沒有取消條件")}</article><article><h4>外部依賴</h4>{contractList(detail.goal.contract.externalDependencies, "沒有外部依賴")}</article></div></section>
    <section><div className="secretary-drawer-title"><h3>Plan 與 Tasks</h3><span>{detail.tasks.length} Tasks</span></div>{activePlan && <div className="active-plan-summary"><span>Plan v{activePlan.version}</span><strong>{activePlan.status}</strong><small>{Array.isArray(activePlan.plan.nodes) ? activePlan.plan.nodes.length : 0} 個節點・建立於 {formatDate(activePlan.createdAt)}</small></div>}{detail.tasks.length ? <div className="goal-task-list">{detail.tasks.map((task, index) => {
      const criteria = Array.isArray(task.specification.completionCriteria) ? task.specification.completionCriteria.filter((item): item is string => typeof item === "string") : [];
      const budget = task.specification.budget as Record<string, unknown> | undefined;
      const result = task.result && typeof task.result === "object" ? task.result as Record<string, unknown> : undefined;
      return <article key={task.id}><div className="goal-task-index">{index + 1}</div><div><header><span>{task.kind}</span><b>{task.status}</b></header><h4>{task.title}</h4>{contractList(criteria, "未提供節點完成條件")}{budget && <small>預算：{String(budget.maxTokens ?? "—")} tokens・{String(budget.maxDurationMs ?? "—")} ms・最多 {String(budget.maxAttempts ?? "—")} 次</small>}{result && <div className="task-result"><strong>執行結果</strong><p>{typeof result.summary === "string" ? result.summary : JSON.stringify(result)}</p></div>}</div></article>;
    })}</div> : <EmptySection text="這個 Goal 尚未建立 Task" />}</section>
    <section><div className="secretary-drawer-title"><h3>Watcher、排程與 Wake</h3><span>{relatedWatchers.length} Watchers・{relatedAutomations.length} Automations・{detail.wakes.length} Wakes</span></div>{relatedWatchers.length > 0 && <div className="watcher-list">{relatedWatchers.map((watcher) => { const snapshot = watcherDetails[watcher.id]; const latest = snapshot?.observations[0]; return <article key={watcher.id}><span className="automation-mode code"><Icon name="eye" /></span><div><div><strong>{watcher.status}</strong><small>{watcher.consecutiveFailures ? `${watcher.consecutiveFailures} 次連續失敗` : "來源正常"}</small></div><a href={watcher.sourceUrl} target="_blank" rel="noreferrer">{watcher.sourceUrl}</a><p>每 {Math.round(watcher.intervalSeconds / 60)} 分鐘・下次 {formatDate(watcher.nextCheckAt)}</p><small>模型：{watcher.semanticReview ? `只在變更時分析・${watcher.modelTokensUsed}/${watcher.modelTokenBudget} tokens` : "不使用"}・{snapshot?.checkpoints.length ?? 0} checkpoints・指紋 {watcher.lastFingerprint?.slice(0, 10) ?? "尚未建立"}</small>{latest && <details className="watcher-result"><summary><b>{latest.status}</b><span>{latest.summary}</span><time>{formatDate(latest.checkedAt)}</time></summary><div><h5>Delta</h5><pre>{JSON.stringify(latest.delta, null, 2)}</pre><h5>Evidence</h5>{latest.evidence.length ? <ul>{latest.evidence.map((item, index) => <li key={index}><strong>{String(item.kind ?? "EVIDENCE")}</strong><span>{String(item.summary ?? "")}</span><code>{String(item.reference ?? "")}</code></li>)}</ul> : <p>這次檢查沒有 Evidence。</p>}</div></details>}</div>{watcher.status === "ACTIVE" && <div className="watcher-actions"><button className="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await client.checkWatcher(watcher.id); await load(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}>立即檢查</button><button className="danger-link" disabled={busy} onClick={async () => { setBusy(true); try { await client.cancelWatcher(watcher.id); await Promise.all([load(), onChanged()]); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}>取消</button></div>}</article>; })}</div>}{relatedAutomations.length ? <div className="goal-automation-list">{relatedAutomations.map((automation) => <article key={automation.id}><span className={`automation-mode ${automation.executionMode === "AI_EXECUTION" ? "ai" : "code"}`}><Icon name={automation.executionMode === "AI_EXECUTION" ? "model" : "activity"} /></span><div><strong>{automation.executionMode}</strong><p>{scheduleLabel(automation)}</p><small>{automation.status}・{automation.timezone}</small></div></article>)}</div> : relatedWatchers.length === 0 && <EmptySection text="這個 Goal 沒有 Watcher 或自動排程" />}{detail.wakes.length > 0 && <div className="goal-wake-list">{detail.wakes.map((wake) => <div key={wake.id}><span>{wake.type}</span><strong>{wake.status}</strong><small>{wake.dueAt ? formatDate(wake.dueAt) : "事件觸發"}</small></div>)}</div>}</section>
    <section><div className="secretary-drawer-title"><h3>Timeline</h3><span>{detail.timeline.length}</span></div><div className="secretary-timeline">{detail.timeline.map((event) => <div key={event.id}><i /><span><strong>{event.type}</strong><small>{formatDate(event.occurredAt)}・{event.actor}</small></span></div>)}</div></section>
    <footer className="goal-detail-actions">{detail.goal.status === "ACTIVE" && <button className="secondary" disabled={busy} onClick={() => void act("pause")}>暫停 Goal</button>}{["WAITING", "BLOCKED"].includes(detail.goal.status) && <button className="primary" disabled={busy} onClick={() => void act("resume")}>恢復 Goal</button>}{!["COMPLETED", "CANCELLED"].includes(detail.goal.status) && <button className="danger-link" disabled={busy} onClick={() => void act("cancel")}>取消 Goal</button>}</footer>
  </>}</aside></div>;
}

export function SecretaryOverview({
  name,
  snapshot,
  projects,
  automations,
  client,
  onChanged,
  onChat,
}: {
  name: string;
  snapshot: PortfolioSnapshot;
  projects: ProjectRecord[];
  automations: AutomationRecord[];
  client: AgentClient;
  onChanged: () => Promise<void>;
  onChat: () => void;
}) {
  const [createMode, setCreateMode] = useState<"project" | "goal">();
  const [projectId, setProjectId] = useState<string>();
  const [goalId, setGoalId] = useState<string>();
  const [error, setError] = useState("");
  const openGoal = (goal: GoalRecord) => setGoalId(goal.id);
  const decide = async (id: string, decision: "APPROVED" | "REJECTED") => {
    try {
      await client.decideApproval(id, decision, decision === "APPROVED" ? "Approved by the owner." : "Rejected by the owner.");
      await onChanged();
      setError("");
    } catch (cause) { setError(errorMessage(cause)); }
  };
  return <div className="secretary-page"><header className="secretary-hero"><div><p className="today-date">{new Intl.DateTimeFormat("zh-TW", { dateStyle: "full" }).format(new Date())}</p><h1>早安，{name}</h1><p>這裡只顯示 Durable Responsibility Store 的真實資料。</p></div><div className="secretary-modes"><button className="primary" onClick={onChat}><Icon name="sparkle" />告訴 Agent-OS</button></div></header>{error && <div className="error-box"><Icon name="warning" />{error}</div>}<div className="secretary-summary"><div><strong>{snapshot.today.length}</strong><span>Today</span></div><div><strong>{snapshot.waitingOnYou.length}</strong><span>Waiting on You</span></div><div><strong>{snapshot.activeProjects.length}</strong><span>Active Projects</span></div><div><strong>{snapshot.commitments.filter((item) => ["OPEN", "WAITING", "BROKEN"].includes(item.status)).length}</strong><span>Open Commitments</span></div></div><div className="secretary-grid"><PortfolioSection title="Today" note="高優先、已到期或今天截止" icon="dashboard" goals={snapshot.today} onOpen={openGoal} /><PortfolioSection title="Waiting on You" note="等待澄清、批准、登入或你的承諾" icon="key" goals={snapshot.waitingOnYou} onOpen={openGoal} /><PortfolioSection title="Waiting on Others" note="等待外部對象或外部條件" icon="globe" goals={snapshot.waitingOnOthers} onOpen={openGoal} /><PortfolioSection title="Upcoming" note="有未來截止時間的責任" icon="update" goals={snapshot.upcoming} onOpen={openGoal} /><DecisionQueue snapshot={snapshot} onOpen={openGoal} onDecide={decide} /><PortfolioSection title="Recently Completed" note="最近驗證完成的 Goal" icon="check" goals={snapshot.recentlyCompleted} onOpen={openGoal} /></div><section className="active-projects-section"><header><div><p className="eyebrow">Portfolio</p><h2>Active Projects</h2></div><button className="secondary" onClick={() => setCreateMode("project")}>＋ 建立 Project</button></header>{snapshot.activeProjects.length ? <div className="active-project-grid">{snapshot.activeProjects.map((project) => <button key={project.id} onClick={() => setProjectId(project.id)}><span><Icon name="storage" /></span><div><h3>{project.name}</h3><p>{project.description || "沒有額外說明"}</p><small>{project.activeGoalCount} Goals・{project.openCommitmentCount} Commitments</small></div><Icon name="chevron" /></button>)}</div> : <EmptySection text="建立第一個 Project，開始管理長期責任" />}</section>{createMode && <CreateDialog mode={createMode} projects={projects} client={client} onClose={() => setCreateMode(undefined)} onCreated={onChanged} />}{projectId && <ProjectDrawer projectId={projectId} client={client} onClose={() => setProjectId(undefined)} onChanged={onChanged} />}{goalId && <GoalDrawer goalId={goalId} automations={automations} client={client} onClose={() => setGoalId(undefined)} onChanged={onChanged} />}</div>;
}

export function ResponsibilitiesPage({
  goals,
  projects,
  automations,
  capabilities,
  watchers,
  client,
  onChanged,
}: {
  goals: GoalRecord[];
  projects: ProjectRecord[];
  automations: AutomationRecord[];
  capabilities: CapabilityRecord[];
  watchers: WatcherRecord[];
  client: AgentClient;
  onChanged: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<"OPEN" | "WAITING" | "DONE" | "ALL">("OPEN");
  const [createMode, setCreateMode] = useState<"project" | "goal">();
  const [goalId, setGoalId] = useState<string>();
  const visible = useMemo(() => goals.filter((goal) => filter === "ALL"
    || (filter === "DONE" ? ["COMPLETED", "CANCELLED"].includes(goal.status)
      : filter === "WAITING" ? ["CLARIFYING", "WAITING", "WAITING_AUTH", "NEEDS_APPROVAL", "BLOCKED"].includes(goal.status)
        : !["COMPLETED", "CANCELLED", "CLARIFYING", "WAITING", "WAITING_AUTH", "NEEDS_APPROVAL", "BLOCKED"].includes(goal.status))), [goals, filter]);
  const capabilityNames = new Map(capabilities.map((item) => [item.id, `${item.name} v${item.version}`]));
  const cancelAutomation = async (id: string) => {
    if (!window.confirm("只取消這個排程？原本的 Goal 會繼續保持有效。")) return;
    try { await client.cancelAutomation(id); await onChanged(); } catch (cause) { window.alert(errorMessage(cause)); }
  };
  return <div className="responsibilities-page"><header><div><p className="eyebrow">Responsibilities</p><h1>Projects 與 Goals</h1><p>所有內容都直接來自 SQLite Responsibility Kernel。</p></div><div><button className="secondary" onClick={() => setCreateMode("project")}>建立 Project</button><button className="primary" onClick={() => setCreateMode("goal")}>進階建立 Goal</button></div></header>{watchers.length > 0 && <section className="automation-panel watcher-panel"><header><div><p className="eyebrow">Phase 7 Watchers</p><h2>長期狀態監看</h2><p>未變更時 0 模型呼叫、0 通知；只有 Delta 才會分析或提醒。</p></div><span>{watchers.filter((item) => item.status === "ACTIVE").length} active</span></header><div className="automation-list">{watchers.map((watcher) => { const goal = goals.find((item) => item.id === watcher.goalId); return <article key={watcher.id}><span className="automation-mode code"><Icon name="eye" /></span><div><div><strong>{goal?.title ?? "Watcher Goal"}</strong><small>{watcher.status}</small></div><p>{watcher.sourceUrl}</p><small>每 {Math.round(watcher.intervalSeconds / 60)} 分鐘・下次 {formatDate(watcher.nextCheckAt)}・{watcher.semanticReview ? `${watcher.modelTokensUsed}/${watcher.modelTokenBudget} tokens` : "0-token"}</small>{watcher.lastError && <em>{watcher.lastError}</em>}</div><button className="secondary" onClick={() => setGoalId(watcher.goalId)}>查看</button></article>; })}</div></section>}<section className="automation-panel"><header><div><p className="eyebrow">Phase 5 Wake Engine</p><h2>AI 選擇的執行方式</h2><p>這裡只顯示 Router 分析後建立的排程；系統沒有預設領域模板。</p></div><span>{automations.filter((item) => item.status === "ACTIVE").length} active</span></header>{automations.length ? <div className="automation-list">{automations.map((automation) => { const goal = goals.find((item) => item.id === automation.goalId); return <article key={automation.id}><span className={`automation-mode ${automation.executionMode === "AI_EXECUTION" ? "ai" : "code"}`}><Icon name={automation.executionMode === "AI_EXECUTION" ? "model" : "activity"} /></span><div><div><strong>{goal?.title ?? "Goal"}</strong><small>{automation.status}</small></div><p>{automation.executionMode === "AI_EXECUTION" ? "複雜任務：到期時交給 AI Runtime 分析" : `簡易任務：${automation.capabilityId ? capabilityNames.get(automation.capabilityId) ?? "Generated Capability" : "Generated Capability"}`}</p><small>{automation.schedule.kind === "ONCE" ? `單次・${formatDate(automation.schedule.at)}` : `每 ${Math.round(automation.schedule.everySeconds / 60)} 分鐘・${automation.misfirePolicy}`}・{automation.timezone}</small></div>{automation.status === "ACTIVE" && <button className="secondary" onClick={() => void cancelAutomation(automation.id)}>取消排程</button>}</article>; })}</div> : <EmptySection text="尚無排程；AI Router 判定適合時才會建立" />}</section><div className="responsibility-filters">{(["OPEN", "WAITING", "DONE", "ALL"] as const).map((value) => <button className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{value === "OPEN" ? "進行中" : value === "WAITING" ? "等待／受阻" : value === "DONE" ? "已結束" : "全部"}<span>{value === "ALL" ? goals.length : undefined}</span></button>)}</div>{visible.length ? <div className="responsibility-list">{visible.map((goal) => <GoalCard key={goal.id} goal={goal} onOpen={(item) => setGoalId(item.id)} />)}</div> : <EmptySection text="這個分類目前沒有 Goal" />}{createMode && <CreateDialog mode={createMode} projects={projects} client={client} onClose={() => setCreateMode(undefined)} onCreated={onChanged} />}{goalId && <GoalDrawer goalId={goalId} automations={automations} client={client} onClose={() => setGoalId(undefined)} onChanged={onChanged} />}</div>;
}
