import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AgentClient, ApiError } from "./api/agentClient";
import type {
  ActivityItem,
  BootstrapResponse,
  ConnectionState,
  ResourceMetric,
  Settings,
  SetupInput,
  SystemStatus,
} from "./api/model";
import { Icon, Logo, type IconName } from "./components/Icon";

type View = "overview" | "tasks" | "system" | "activity" | "settings";
const client = new AgentClient();

function messageFor(error: unknown): string {
  return error instanceof ApiError ? error.message : "發生未預期的錯誤，請再試一次。";
}

function Loading() {
  return <main className="center-page"><div className="loading-card"><Logo /><span className="loader" /><p>正在連線到 Agent-OS…</p></div></main>;
}

function Setup({ bootstrap, onComplete }: { bootstrap: BootstrapResponse; onComplete: (input: SetupInput) => Promise<void> }) {
  const [pairingCode, setPairingCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pairingCode.replace(/[\s-]/g, "").length < 8) return setError("請輸入伺服器顯示的 8 位配對碼。");
    if (!displayName.trim()) return setError("請輸入顯示名稱。");
    if (password.length < 10) return setError("密碼至少需要 10 個字元。");
    if (password !== confirm) return setError("兩次輸入的密碼不一致。");
    setBusy(true);
    setError("");
    try {
      await onComplete({ pairingCode, displayName: displayName.trim(), password });
    } catch (cause) {
      setError(messageFor(cause));
      setBusy(false);
    }
  };

  return <main className="setup-layout">
    <section className="setup-brand-panel">
      <Logo />
      <div className="setup-pitch"><p className="eyebrow light">Your private agent</p><h1>把你的樹莓派，變成真正屬於你的 AI 助手。</h1><p>資料、工具與工作流程都留在自己的環境；裝好後，所有細部設定都由瀏覽器完成。</p></div>
      <div className="device-card"><span><Icon name="server" /></span><div><small>正在設定</small><strong>{bootstrap.meta.hostname}</strong></div><em><Icon name="lock" size={13} />區域網路</em></div>
    </section>
    <section className="setup-form-panel">
      <div className="mobile-logo"><Logo /></div>
      <p className="eyebrow">Welcome to Agent-OS</p>
      <h2>完成首次安全設定</h2>
      <p className="lede">配對碼只會顯示在樹莓派終端，完成設定後會立即失效。</p>
      <form onSubmit={submit} className="form-stack">
        <label>配對碼<input value={pairingCode} onChange={(event) => setPairingCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoComplete="one-time-code" autoFocus /></label>
        <label>顯示名稱<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：Jay" autoComplete="name" /></label>
        <label>管理密碼<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 10 個字元" autoComplete="new-password" /></label>
        <label>確認密碼<input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" /></label>
        {error && <div className="error-box"><Icon name="warning" />{error}</div>}
        <button className="primary" disabled={busy}>{busy ? "正在建立…" : "完成設定"}<Icon name="arrow" /></button>
      </form>
      <p className="security-copy"><Icon name="shield" />密碼只會以雜湊形式儲存在本機 SQLite。</p>
    </section>
  </main>;
}

function Login({ bootstrap, onLogin }: { bootstrap: BootstrapResponse; onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try { await onLogin(password); } catch (cause) { setError(messageFor(cause)); setBusy(false); }
  };
  return <main className="center-page auth-background"><section className="login-card">
    <Logo />
    <div className="login-orb"><Icon name="sparkle" size={27} /></div>
    <p className="eyebrow">Welcome back</p><h1>登入 Agent-OS</h1>
    <p className="lede">連線到 <strong>{bootstrap.meta.hostname}</strong></p>
    <form onSubmit={submit} className="form-stack compact">
      <label>管理密碼<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus /></label>
      {error && <div className="error-box"><Icon name="warning" />{error}</div>}
      <button className="primary" disabled={busy || !password}>{busy ? "登入中…" : "安全登入"}<Icon name="arrow" /></button>
    </form>
    <div className="version-pill"><i />{bootstrap.meta.secure ? "加密連線" : "區域網路連線"}<span />Agent-OS {bootstrap.meta.version}</div>
  </section></main>;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  return days ? `${days} 天 ${hours} 小時` : `${hours} 小時`;
}

function relativeTime(iso: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小時前`;
  return `${Math.floor(minutes / 1_440)} 天前`;
}

const metricMeta: Record<string, { label: string; icon: IconName }> = {
  cpu: { label: "處理器", icon: "cpu" },
  memory: { label: "記憶體", icon: "memory" },
  storage: { label: "儲存空間", icon: "storage" },
  temperature: { label: "溫度", icon: "temperature" },
};

function Metric({ id, metric }: { id: string; metric: ResourceMetric }) {
  const meta = metricMeta[id] ?? { label: id, icon: "activity" as IconName };
  const width = metric.unit === "°C" ? Math.min(100, metric.value) : metric.value;
  return <article className={`metric ${metric.status}`}><div className="metric-top"><span><Icon name={meta.icon} /></span><em>{metric.status === "normal" ? "正常" : metric.status === "warning" ? "注意" : "警示"}</em></div><strong>{metric.value}<small>{metric.unit}</small></strong><h3>{meta.label}</h3><p>{metric.detail}</p><div className="meter"><i style={{ width: `${width}%` }} /></div></article>;
}

function ActivityList({ items }: { items: ActivityItem[] }) {
  return <div className="activity-list">{items.map((item) => <div className="activity-item" key={item.id}><span className={item.kind}><Icon name={item.kind === "security" ? "shield" : item.kind === "settings" ? "settings" : item.kind === "update" ? "update" : "activity"} /></span><div><strong>{item.title}</strong><small>{item.detail}</small></div><time>{relativeTime(item.occurredAt)}</time></div>)}{!items.length && <div className="empty"><Icon name="activity" /><p>目前還沒有活動紀錄。</p></div>}</div>;
}

function Services({ system }: { system: SystemStatus }) {
  return <div className="service-list">{system.services.map((service) => <div className="service-item" key={service.id}><span><Icon name={service.id === "browser" ? "browser" : service.id === "model" ? "model" : "server"} /></span><div><strong>{service.name}</strong><small>{service.detail}</small></div>{service.latencyMs !== undefined && <em>{service.latencyMs} ms</em>}<b className={service.state}><i />{service.state === "healthy" ? "運作中" : service.state === "degraded" ? "需注意" : service.state === "starting" ? "啟動中" : "未啟用"}</b></div>)}</div>;
}

function SettingsPage({ value, onSave }: { value: Settings; onSave: (settings: Settings) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => setDraft(value), [value]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setNotice("");
    try { await onSave(draft); setNotice("設定已儲存"); } catch (error) { setNotice(messageFor(error)); } finally { setBusy(false); }
  };
  return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">Preferences</p><h1>裝置設定</h1><p>管理名稱、語言、時區與管理介面外觀。</p></div></header><form className="settings-card" onSubmit={save}><div className="setting-row"><span><Icon name="server" /></span><div><label>裝置名稱<input value={draft.deviceName} onChange={(event) => setDraft({ ...draft, deviceName: event.target.value })} /></label><p>顯示在管理介面與未來的裝置探索中。</p></div></div><div className="setting-row"><span><Icon name="globe" /></span><div><label>語言<select value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.target.value as Settings["language"] })}><option value="zh-Hant">繁體中文</option><option value="en">English</option></select></label><label>時區<input value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></label></div></div><div className="setting-row"><span><Icon name="palette" /></span><div><label>外觀<select value={draft.theme} onChange={(event) => setDraft({ ...draft, theme: event.target.value as Settings["theme"] })}><option value="system">跟隨系統</option><option value="light">淺色</option><option value="dark">深色</option></select></label><p>變更會立即套用在目前的瀏覽器。</p></div></div><div className="settings-actions"><span>{notice}</span><button className="primary" disabled={busy}>{busy ? "儲存中…" : "儲存設定"}</button></div></form><section className="phase-card"><span><Icon name="model" /></span><div><p className="eyebrow">Phase 3</p><h2>模型與 OAuth</h2><p>OpenAI、API Key 與本地模型連線會在下一階段加入；Phase 2 不會假裝連線模型。</p></div></section></div>;
}

type TaskKind = "once" | "scheduled" | "watch";
type TaskState = "attention" | "running" | "watching" | "scheduled" | "completed";

type DemoTask = {
  id: string;
  title: string;
  goal: string;
  kind: TaskKind;
  state: TaskState;
  current: string;
  meta: string;
  progress?: number;
  summary?: string;
  attentionType?: string;
  actionLabel?: string;
};

const demoTasks: DemoTask[] = [
  {
    id: "drive-auth",
    title: "整理本週客戶文件",
    goal: "把 Google Drive 內本週新增的客戶文件分類並產生索引。",
    kind: "once",
    state: "attention",
    current: "Google Drive 的授權已過期，整理工作暫時停在 18 份文件。",
    meta: "停留 12 分鐘",
    progress: 64,
    attentionType: "需要授權",
    actionLabel: "重新連接",
  },
  {
    id: "hosting-choice",
    title: "比較網站監控服務",
    goal: "找出適合個人使用、能從台灣穩定存取的網站監控方案。",
    kind: "once",
    state: "attention",
    current: "已整理出 3 個條件相近的方案，需要你決定是否把價格列為第一優先。",
    meta: "今天 09:42",
    progress: 82,
    attentionType: "需要決定",
    actionLabel: "查看選項",
  },
  {
    id: "vision-roadmap",
    title: "整理 Agent-OS 開發路線",
    goal: "依照 VISION.md 產生可執行的產品與工程路線圖。",
    kind: "once",
    state: "running",
    current: "正在合併工具權限與任務調度的相依項目。",
    meta: "已執行 24 分鐘",
    progress: 68,
  },
  {
    id: "site-audit",
    title: "檢查專案網站內容",
    goal: "找出失效連結、過期說明與行動版排版問題。",
    kind: "once",
    state: "running",
    current: "正在檢查安裝說明與行動裝置斷點。",
    meta: "已執行 8 分鐘",
    progress: 41,
  },
  {
    id: "agent-health",
    title: "追蹤 Agent-OS 服務健康度",
    goal: "持續確認 Gateway、儲存空間與遠端連線正常。",
    kind: "watch",
    state: "watching",
    current: "所有檢查均正常，最近一次檢查沒有發現異常。",
    meta: "1 分鐘前檢查",
  },
  {
    id: "release-watch",
    title: "追蹤 OpenAI 模型更新",
    goal: "偵測可能影響 Agent-OS 的模型、OAuth 與工具調用更新。",
    kind: "watch",
    state: "watching",
    current: "持續監控官方更新來源，目前沒有需要採取行動的變更。",
    meta: "18 分鐘前檢查",
  },
  {
    id: "daily-brief",
    title: "每日技術情報摘要",
    goal: "每天整理 AI Agent 與 Raspberry Pi 生態的重要消息。",
    kind: "scheduled",
    state: "scheduled",
    current: "下一次執行已安排，離線時會在開機後自動補跑。",
    meta: "明天 08:00",
  },
  {
    id: "ssd-report",
    title: "比較樹莓派外接 SSD",
    goal: "找出五款適合長時間運行 Agent-OS 的外接 SSD。",
    kind: "once",
    state: "completed",
    current: "比較與資料核對均已完成。",
    meta: "今天 10:26",
    progress: 100,
    summary: "Samsung T7 綜合穩定性最佳；完整比較表與散熱注意事項已整理完成。",
  },
  {
    id: "security-report",
    title: "檢查昨晚的安全事件",
    goal: "確認 Agent-OS 與主機是否出現異常登入或服務錯誤。",
    kind: "scheduled",
    state: "completed",
    current: "安全事件與系統日誌已檢查完成。",
    meta: "今天 08:04",
    summary: "沒有異常登入；偵測到 2 次短暫斷線，服務皆已自行恢復。",
  },
];

function kindLabel(kind: TaskKind) {
  return kind === "watch" ? "持續追蹤" : kind === "scheduled" ? "排程任務" : "一次性任務";
}

function TaskProgress({ task }: { task: DemoTask }) {
  if (task.kind === "watch") return <div className="task-health"><i />追蹤正常</div>;
  if (task.kind === "scheduled" && task.state !== "completed") return <div className="task-schedule"><Icon name="update" size={15} />{task.meta}</div>;
  return <div className="task-progress"><span><i style={{ width: `${task.progress ?? 100}%` }} /></span><strong>{task.progress ?? 100}%</strong></div>;
}

function BriefingModal({ name, onClose }: { name: string; onClose: () => void }) {
  return <div className="prototype-overlay" role="presentation" onMouseDown={onClose}>
    <section className="briefing-modal" role="dialog" aria-modal="true" aria-labelledby="briefing-title" onMouseDown={(event) => event.stopPropagation()}>
      <button className="modal-close" onClick={onClose} aria-label="關閉摘要"><Icon name="close" /></button>
      <div className="briefing-mark"><Icon name="sparkle" size={24} /></div>
      <p className="eyebrow">Your daily briefing</p>
      <h2 id="briefing-title">早安，{name}</h2>
      <p className="briefing-lede">你離開後，我完成了 2 件事。目前有 2 個項目需要你處理，其餘工作都在正常進行。</p>
      <div className="briefing-stats"><div><strong>2</strong><span>需要處理</span></div><div><strong>2</strong><span>最新成果</span></div><div><strong>4</strong><span>執行與追蹤中</span></div></div>
      <div className="briefing-note"><span><Icon name="check" /></span><p><strong>整體狀態良好</strong>所有持續追蹤服務皆準時回報，昨晚沒有重大安全事件。</p></div>
      <button className="primary briefing-action" onClick={onClose}>查看今日事項<Icon name="arrow" /></button>
    </section>
  </div>;
}

function TaskDrawer({ task, onClose }: { task: DemoTask; onClose: () => void }) {
  return <div className="drawer-layer" role="presentation" onMouseDown={onClose}>
    <aside className="task-drawer" role="dialog" aria-modal="true" aria-labelledby="task-drawer-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="drawer-head"><div><span className={`state-pill ${task.state}`}>{task.state === "attention" ? task.attentionType : task.state === "running" ? "執行中" : task.state === "watching" ? "追蹤正常" : task.state === "scheduled" ? "已排程" : "已完成"}</span><span className="kind-copy">{kindLabel(task.kind)}</span></div><button className="icon-only" onClick={onClose} aria-label="關閉任務詳細資料"><Icon name="close" /></button></header>
      <div className="drawer-body">
        <div className="drawer-title"><p className="eyebrow">Task detail</p><h2 id="task-drawer-title">{task.title}</h2><p>{task.goal}</p></div>
        <section className="current-action"><div className="current-action-head"><span><Icon name={task.state === "attention" ? "warning" : task.state === "completed" ? "check" : "sparkle"} /></span><div><small>目前動作</small><strong>{task.state === "attention" ? "等待你的回覆" : task.state === "completed" ? "工作已交付" : "Agent 正在處理"}</strong></div><em>即時</em></div><p>{task.current}</p><TaskProgress task={task} />{task.actionLabel && <button className="primary drawer-primary">{task.actionLabel}<Icon name="arrow" /></button>}</section>
        {task.summary && <section className="drawer-section result-summary"><div className="drawer-section-title"><Icon name="check" /><h3>成果摘要</h3></div><p>{task.summary}</p><button className="text-button">開啟完整報告<Icon name="chevron" size={16} /></button></section>}
        <section className="drawer-section"><div className="drawer-section-title"><Icon name="activity" /><h3>執行紀錄</h3><button>展開全部</button></div><div className="timeline"><div><i /><span><strong>{task.state === "completed" ? "完成任務並整理成果" : "更新目前狀態"}</strong><small>{task.meta}</small></span></div><div><i /><span><strong>確認目標與可用工具</strong><small>今天 08:02</small></span></div><div className="muted"><i /><span><strong>任務由 Agent 自動建立</strong><small>來自助手對話</small></span></div></div></section>
        <section className="drawer-section"><div className="drawer-section-title"><Icon name="storage" /><h3>相關產出</h3></div><div className="artifact"><span><Icon name="storage" /></span><div><strong>任務工作區</strong><small>報告、來源與變更檔案會顯示在這裡</small></div><Icon name="chevron" /></div></section>
      </div>
      <footer className="drawer-compose"><button className="icon-only"><Icon name="settings" /></button><input placeholder="補充指令或調整這個任務…" /><button className="send-button"><Icon name="arrow" /></button></footer>
    </aside>
  </div>;
}

function AssistantPanel({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [accepted, setAccepted] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    setAccepted(true);
  };
  return <div className="assistant-layer" role="presentation" onMouseDown={onClose}>
    <section className="assistant-panel" role="dialog" aria-modal="true" aria-labelledby="assistant-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="assistant-head"><div className="assistant-identity"><span><Icon name="sparkle" /></span><div><strong id="assistant-title">Agent-OS</strong><small><i />隨時可以交付工作</small></div></div><button className="icon-only" onClick={onClose} aria-label="關閉助手"><Icon name="close" /></button></header>
      <div className="assistant-body">
        {!accepted ? <><div className="assistant-welcome"><p>有什麼需要我處理的嗎？</p><span>可以交付任務，也可以只問一個簡單問題。</span></div><div className="prompt-chips"><button onClick={() => setMessage("幫我整理今天 Agent-OS 的執行狀態")}>整理今天的工作</button><button onClick={() => setMessage("持續追蹤 Agent-OS 的服務健康度")}>建立持續追蹤</button><button onClick={() => setMessage("明天早上八點提醒我檢查更新")}>安排提醒</button></div></> : <div className="accepted-task"><div className="accepted-icon"><Icon name="check" /></div><div><p className="eyebrow">Task accepted</p><h3>已接下這個任務</h3><p>我會先確認目標並自動放進任務清單。若需要授權或重要決定，我會再通知你。</p><div><span><i />正在建立任務</span><button>查看任務<Icon name="chevron" size={15} /></button><button className="undo" onClick={() => setAccepted(false)}>撤銷</button></div></div></div>}
      </div>
      <form className="assistant-compose" onSubmit={submit}><textarea value={message} onChange={(event) => { setMessage(event.target.value); setAccepted(false); }} placeholder="交付一件事，或問我任何問題…" rows={2} autoFocus /><div><span><Icon name="shield" size={15} />高風險操作會先詢問</span><button className="send-button" disabled={!message.trim()}><Icon name="arrow" /></button></div></form>
    </section>
  </div>;
}

function OverviewPage({ name, onOpenBriefing, onOpenTask }: { name: string; onOpenBriefing: () => void; onOpenTask: (task: DemoTask) => void }) {
  const [readResults, setReadResults] = useState<string[]>([]);
  const attention = demoTasks.filter((task) => task.state === "attention");
  const results = demoTasks.filter((task) => task.state === "completed" && !readResults.includes(task.id));
  const markRead = (id: string) => setReadResults((current) => [...current, id]);
  return <div className="today-page">
    <header className="today-header"><div><p className="today-date">8 月 30 日・星期日</p><h1>早安，{name}</h1><p>先處理重要的，其餘交給我。</p></div><button className="briefing-trigger" onClick={onOpenBriefing}><span><Icon name="sparkle" /></span><div><strong>今日摘要已準備好</strong><small>2 個新成果・2 件需要處理</small></div><Icon name="chevron" /></button></header>
    <section className="today-section attention-section"><div className="today-section-head"><div><span className="section-indicator amber"><Icon name="warning" size={17} /></span><div><h2>需要你處理</h2><p>我已經先完成能做的部分</p></div></div><span className="section-count">{attention.length}</span></div><div className="attention-list">{attention.map((task) => <article className="attention-card" key={task.id} onClick={() => onOpenTask(task)}><div className="attention-main"><span className="attention-icon"><Icon name={task.id === "drive-auth" ? "key" : "warning"} /></span><div><div className="task-card-kicker"><span>{task.attentionType}</span><small>{task.meta}</small></div><h3>{task.title}</h3><p>{task.current}</p></div></div><div className="attention-actions"><button className="secondary" onClick={(event) => { event.stopPropagation(); onOpenTask(task); }}>查看細節</button><button className="primary" onClick={(event) => event.stopPropagation()}>{task.actionLabel}</button></div></article>)}</div></section>
    <section className="today-section result-section"><div className="today-section-head"><div><span className="section-indicator green"><Icon name="check" size={17} /></span><div><h2>最新成果</h2><p>從你上次離開後完成的工作</p></div></div>{results.length > 0 && <button className="mark-all" onClick={() => setReadResults(demoTasks.filter((task) => task.state === "completed").map((task) => task.id))}>全部標為已讀</button>}</div>{results.length ? <div className="result-list">{results.map((task) => <article className="result-card" key={task.id} onClick={() => { markRead(task.id); onOpenTask(task); }}><div className="result-check"><Icon name="check" /></div><div className="result-content"><div><span>{kindLabel(task.kind)}</span><small>{task.meta}</small></div><h3>{task.title}</h3><p>{task.summary}</p></div><button className="result-open" aria-label="查看成果"><Icon name="arrow" /></button></article>)}</div> : <div className="all-clear"><span><Icon name="check" /></span><h3>最新成果都看過了</h3><p>有新的交付時，我會放在這裡。</p></div>}</section>
  </div>;
}

function TasksPage({ onOpenTask, onOpenAssistant }: { onOpenTask: (task: DemoTask) => void; onOpenAssistant: () => void }) {
  const [filter, setFilter] = useState<"all" | TaskState>("all");
  const groups: Array<{ state: TaskState; title: string; note: string }> = [
    { state: "attention", title: "需要處理", note: "等待授權、決定或安全確認" },
    { state: "running", title: "正在進行", note: "Agent 目前正在執行" },
    { state: "watching", title: "持續追蹤", note: "定期檢查並在有變化時通知" },
    { state: "scheduled", title: "已安排", note: "會在指定時間自動執行" },
    { state: "completed", title: "最近完成", note: "已交付的成果" },
  ];
  return <div className="tasks-page">
    <header className="tasks-header">
      <div><p className="eyebrow">Tasks</p><h1>所有任務</h1><p>依目前狀態排列，清楚掌握每件事在哪裡。</p></div>
      <button className="primary" onClick={onOpenAssistant}><Icon name="sparkle" />交付新任務</button>
    </header>
    <div className="task-filters">
      <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>看板 <span>{demoTasks.length}</span></button>
      {groups.map((group) => <button key={group.state} className={filter === group.state ? "active" : ""} onClick={() => setFilter(group.state)}>{group.title}<span>{demoTasks.filter((task) => task.state === group.state).length}</span></button>)}
    </div>
    <div className={`task-board ${filter === "all" ? "" : "single-column"}`}>
      {groups.filter((group) => filter === "all" || filter === group.state).map((group) => {
        const tasks = demoTasks.filter((task) => task.state === group.state);
        return <section className={`task-column ${group.state}`} key={group.state}>
          <header className="task-column-head"><div><i /><h2>{group.title}</h2><span>{tasks.length}</span></div><p>{group.note}</p></header>
          <div className="task-column-body">
            {tasks.map((task) => <button className="board-task-card" key={task.id} onClick={() => onOpenTask(task)}>
              <div className="board-card-meta"><span className={`task-kind-tag ${task.kind}`}>{kindLabel(task.kind)}</span><Icon name="chevron" size={17} /></div>
              <h3>{task.title}</h3>
              <p>{task.current}</p>
              <TaskProgress task={task} />
              <div className="board-card-footer"><span>{task.state === "attention" ? task.attentionType : task.meta}</span>{task.state === "attention" && <strong>待處理</strong>}</div>
            </button>)}
            <button className="add-task-card" onClick={onOpenAssistant}><span>＋</span>新增任務</button>
          </div>
        </section>;
      })}
    </div>
  </div>;
}

function Dashboard({ bootstrap, onLogout }: { bootstrap: BootstrapResponse; onLogout: () => Promise<void> }) {
  const [view, setView] = useState<View>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [snapshot, setSnapshot] = useState<{ system: SystemStatus; activity: ActivityItem[] }>();
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState("");
  const [briefingOpen, setBriefingOpen] = useState(true);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<DemoTask>();

  const refresh = async () => {
    try { setSnapshot(await client.dashboard()); setError(""); } catch (cause) { setError(messageFor(cause)); }
  };

  useEffect(() => {
    void refresh();
    void client.settings().then(setSettings).catch((cause) => setError(messageFor(cause)));
    const stop = client.subscribe((event) => {
      if (event.type === "activity.created") setSnapshot((current) => current ? { ...current, activity: [event.data, ...current.activity].slice(0, 30) } : current);
      if (event.type === "settings.updated") setSettings(event.data);
    }, setConnection);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { stop(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (settings) document.documentElement.dataset.theme = settings.theme;
  }, [settings]);

  const nav = useMemo(() => [
    ["overview", "今日", "dashboard"], ["tasks", "任務", "check"],
    ["system", "系統", "activity"], ["activity", "活動", "update"],
    ["settings", "設定", "settings"],
  ] as Array<[View, string, IconName]>, []);

  if (!snapshot || !settings) return <Loading />;
  const system = snapshot.system;
  const name = bootstrap.session.user?.displayName ?? "Owner";
  const pageTitles: Record<View, string> = { overview: "今日", tasks: "所有任務", system: "系統狀態", activity: "活動紀錄", settings: "裝置設定" };

  return <div className="app-shell polished-shell">
    <aside className={mobileNav ? "sidebar open" : "sidebar"}>
      <div className="sidebar-head"><Logo /><button className="icon-only mobile-close" onClick={() => setMobileNav(false)}><Icon name="close" /></button></div>
      <nav>{nav.map(([id, label, icon]) => <button key={id} className={view === id ? "active" : ""} onClick={() => { setView(id); setMobileNav(false); }}><Icon name={icon} />{label}{id === "overview" && <span className="nav-badge">4</span>}</button>)}</nav>
      <button className="agent-status" onClick={() => setAssistantOpen(true)}><span className="agent-status-mark"><Icon name="sparkle" /></span><span><strong>Agent 正在工作</strong><small><i />4 個任務進行中</small></span><Icon name="chevron" size={16} /></button>
      <div className="sidebar-user"><span className="avatar">{bootstrap.session.user?.initials ?? "AO"}</span><div><strong>{name}</strong><small>{settings.deviceName}</small></div><button className="icon-only" onClick={() => void onLogout()} aria-label="安全登出"><Icon name="logout" size={17} /></button></div>
    </aside>
    {mobileNav && <button className="scrim" aria-label="關閉選單" onClick={() => setMobileNav(false)} />}
    <div className="main-column">
      <header className="topbar"><button className="icon-only menu-button" onClick={() => setMobileNav(true)}><Icon name="menu" /></button><div className="topbar-title"><strong>{pageTitles[view]}</strong><small>Agent-OS・{settings.deviceName}</small></div><div className={`connection ${connection}`}><i />{connection === "online" ? "已連線" : connection === "reconnecting" ? "重新連線" : "連線中"}</div><button className="notification-button" onClick={() => setView("overview")} aria-label="查看需要處理的事項"><Icon name="warning" size={18} /><span>2</span></button><span className="topbar-avatar avatar">{bootstrap.session.user?.initials ?? "AO"}</span></header>
      <main className={`content ${view === "overview" || view === "tasks" ? "workspace-content" : ""}`}>
        {error && <div className="error-box page-error"><Icon name="warning" />{error}<button onClick={() => void refresh()}>重試</button></div>}
        {view === "overview" && <OverviewPage name={name} onOpenBriefing={() => setBriefingOpen(true)} onOpenTask={setSelectedTask} />}
        {view === "tasks" && <TasksPage onOpenTask={setSelectedTask} onOpenAssistant={() => setAssistantOpen(true)} />}
        {view === "system" && <div className="page-stack"><header className="page-header inline"><div><p className="eyebrow">System health</p><h1>系統狀態</h1><p>{system.host.platform}</p></div><button className="secondary" onClick={() => void refresh()}><Icon name="refresh" />重新整理</button></header><section className={`overall ${system.overall}`}><Icon name={system.overall === "healthy" ? "check" : "warning"} size={30} /><div><small>Overall status</small><h2>{system.overall === "healthy" ? "所有核心項目正常" : "部分資源需要注意"}</h2><p>最後更新：{new Date(system.generatedAt).toLocaleString("zh-TW")}</p></div></section><div className="metric-grid">{Object.entries(system.resources).map(([id, metric]) => <Metric key={id} id={id} metric={metric} />)}</div><section className="panel"><div className="panel-title"><span><Icon name="activity" /></span><div><h2>服務健康狀態</h2><p>Gateway 與選用元件</p></div></div><Services system={system} /></section></div>}
        {view === "activity" && <div className="page-stack"><header className="page-header"><div><p className="eyebrow">Audit & activity</p><h1>活動紀錄</h1><p>登入、首次配對與設定變更都會保留在本機。</p></div></header><section className="panel activity-panel"><div className="activity-toolbar"><strong>最近事件</strong><span>{snapshot.activity.length} 筆</span></div><ActivityList items={snapshot.activity} /></section></div>}
        {view === "settings" && <SettingsPage value={settings} onSave={async (next) => setSettings(await client.updateSettings(next))} />}
      </main>
      <footer className="chat-dock assistant-dock"><button onClick={() => setAssistantOpen(true)}><span className="dock-agent"><Icon name="sparkle" /></span><span className="dock-placeholder">交付一件事，或問我任何問題…</span><kbd>⌘ K</kbd><span className="dock-send"><Icon name="arrow" /></span></button></footer>
    </div>
    {briefingOpen && view === "overview" && <BriefingModal name={name} onClose={() => setBriefingOpen(false)} />}
    {assistantOpen && <AssistantPanel onClose={() => setAssistantOpen(false)} />}
    {selectedTask && <TaskDrawer task={selectedTask} onClose={() => setSelectedTask(undefined)} />}
  </div>;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [error, setError] = useState("");
  const load = async () => {
    setError("");
    try { setBootstrap(await client.bootstrap()); } catch (cause) { setError(messageFor(cause)); }
  };
  useEffect(() => { void load(); }, []);
  if (!bootstrap && !error) return <Loading />;
  if (!bootstrap) return <main className="center-page"><section className="login-card"><Logo /><div className="login-orb warning"><Icon name="wifi" /></div><h1>無法連線到 Agent-OS</h1><p className="lede">{error}</p><button className="primary" onClick={() => void load()}><Icon name="refresh" />重新連線</button></section></main>;
  if (bootstrap.meta.setupRequired) return <Setup bootstrap={bootstrap} onComplete={async (input) => setBootstrap(await client.setup(input))} />;
  if (!bootstrap.session.authenticated) return <Login bootstrap={bootstrap} onLogin={async (password) => setBootstrap(await client.login(password))} />;
  return <Dashboard bootstrap={bootstrap} onLogout={async () => { await client.logout(); setBootstrap(await client.bootstrap()); }} />;
}
