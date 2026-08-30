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

type View = "overview" | "system" | "activity" | "settings";
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

function Dashboard({ bootstrap, onLogout }: { bootstrap: BootstrapResponse; onLogout: () => Promise<void> }) {
  const [view, setView] = useState<View>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [snapshot, setSnapshot] = useState<{ system: SystemStatus; activity: ActivityItem[] }>();
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState("");

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
    ["overview", "總覽", "dashboard"], ["system", "系統狀態", "activity"],
    ["activity", "活動紀錄", "update"], ["settings", "設定", "settings"],
  ] as Array<[View, string, IconName]>, []);

  if (!snapshot || !settings) return <Loading />;
  const system = snapshot.system;
  const title = view === "overview" ? `早安，${bootstrap.session.user?.displayName ?? "Owner"}` : view === "system" ? "系統狀態" : view === "activity" ? "活動紀錄" : "裝置設定";

  return <div className="app-shell">
    <aside className={mobileNav ? "sidebar open" : "sidebar"}><div className="sidebar-head"><Logo /><button className="icon-only mobile-close" onClick={() => setMobileNav(false)}><Icon name="close" /></button></div><nav>{nav.map(([id, label, icon]) => <button key={id} className={view === id ? "active" : ""} onClick={() => { setView(id); setMobileNav(false); }}><Icon name={icon} />{label}</button>)}</nav><div className="sidebar-phase"><span><Icon name="sparkle" /></span><div><small>目前版本</small><strong>Phase 2</strong><p>管理介面已就緒</p></div></div><button className="logout" onClick={() => void onLogout()}><Icon name="logout" />安全登出</button></aside>
    {mobileNav && <button className="scrim" aria-label="關閉選單" onClick={() => setMobileNav(false)} />}
    <div className="main-column"><header className="topbar"><button className="icon-only menu-button" onClick={() => setMobileNav(true)}><Icon name="menu" /></button><div><strong>{title}</strong><small>{settings.deviceName}</small></div><div className={`connection ${connection}`}><i />{connection === "online" ? "即時連線" : connection === "reconnecting" ? "重新連線" : "連線中"}</div><span className="avatar">{bootstrap.session.user?.initials ?? "AO"}</span></header>
      <main className="content">{error && <div className="error-box page-error"><Icon name="warning" />{error}<button onClick={() => void refresh()}>重試</button></div>}
        {view === "overview" && <div className="page-stack"><header className="page-header"><div><p className="eyebrow">Overview</p><h1>{title}</h1><p>Agent-OS 正在你的裝置上穩定運作。</p></div><div className={`health-chip ${system.overall}`}><i />{system.overall === "healthy" ? "系統正常" : "需要注意"}</div></header><section className="hero"><div className="hero-orb"><span /><i><Icon name="sparkle" size={28} /></i></div><div><p className="eyebrow light">Your agent workspace</p><h2>管理介面已經就緒，下一步會接上 Agent 核心。</h2><p>Phase 2 已提供安全登入、系統監控、活動記錄與設定；聊天、工具調用與任務佇列會在後續階段啟用。</p></div><div className="task-preview"><small>進行中的任務</small><strong>尚未連接 Agent Core</strong><span><i />等待 Phase 3</span></div></section><section><div className="section-title"><div><p className="eyebrow">Live resources</p><h2>裝置資源</h2></div><button onClick={() => setView("system")}>查看全部<Icon name="chevron" /></button></div><div className="metric-grid">{Object.entries(system.resources).map(([id, metric]) => <Metric key={id} id={id} metric={metric} />)}</div></section><div className="two-columns"><section className="panel"><div className="panel-title"><span><Icon name="server" /></span><div><h2>服務狀態</h2><p>{system.services.filter((service) => service.state === "healthy").length} 個服務運作中</p></div></div><Services system={system} /></section><section className="panel"><div className="panel-title"><span><Icon name="activity" /></span><div><h2>最近活動</h2><p>安全與設定事件</p></div><button className="icon-only" onClick={() => setView("activity")}><Icon name="arrow" /></button></div><ActivityList items={snapshot.activity.slice(0, 4)} /></section></div><section className="host-strip"><div><Icon name="server" size={26} /><span><small>目前主機</small><strong>{system.host.name}</strong></span></div><dl><div><dt>IP 位址</dt><dd>{system.host.address}</dd></div><div><dt>運行時間</dt><dd>{formatUptime(system.host.uptimeSeconds)}</dd></div><div><dt>版本</dt><dd>{system.host.version}</dd></div></dl></section></div>}
        {view === "system" && <div className="page-stack"><header className="page-header inline"><div><p className="eyebrow">System health</p><h1>系統狀態</h1><p>{system.host.platform}</p></div><button className="secondary" onClick={() => void refresh()}><Icon name="refresh" />重新整理</button></header><section className={`overall ${system.overall}`}><Icon name={system.overall === "healthy" ? "check" : "warning"} size={30} /><div><small>Overall status</small><h2>{system.overall === "healthy" ? "所有核心項目正常" : "部分資源需要注意"}</h2><p>最後更新：{new Date(system.generatedAt).toLocaleString("zh-TW")}</p></div></section><div className="metric-grid">{Object.entries(system.resources).map(([id, metric]) => <Metric key={id} id={id} metric={metric} />)}</div><section className="panel"><div className="panel-title"><span><Icon name="activity" /></span><div><h2>服務健康狀態</h2><p>Gateway 與選用元件</p></div></div><Services system={system} /></section></div>}
        {view === "activity" && <div className="page-stack"><header className="page-header"><div><p className="eyebrow">Audit & activity</p><h1>活動紀錄</h1><p>登入、首次配對與設定變更都會保留在本機。</p></div></header><section className="panel activity-panel"><div className="activity-toolbar"><strong>最近事件</strong><span>{snapshot.activity.length} 筆</span></div><ActivityList items={snapshot.activity} /></section></div>}
        {view === "settings" && <SettingsPage value={settings} onSave={async (next) => setSettings(await client.updateSettings(next))} />}
      </main>
      <footer className="chat-dock"><div><Icon name="sparkle" /><input disabled placeholder="輸入任務給 Agent-OS（Phase 3 啟用）" /><span>尚未連接模型</span><button disabled><Icon name="arrow" /></button></div></footer>
    </div>
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
