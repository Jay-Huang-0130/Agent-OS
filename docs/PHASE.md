# Agent-OS Implementation Phases

> 依據 [Responsibility & Secretary Kernel](RESPONSIBILITY-KERNEL.md) 的實作路線｜2026-09-01

## 1. 路線原則

Agent-OS 的核心不是聊天 UI、Cron 或多 Agent，而是：

~~~text
Secretary Layer
管理使用者所有責任、承諾、時間、優先順序與注意力

Responsibility Kernel
確保已接受的 Goal 跨斷網、崩潰與重啟持續存在，直到完成或明確取消

Execution Layer
依成本與風險選擇 API、程式、Browser、Agent 或 Human Gate
~~~

Phase 必須遵守：

1. 每一階段都交付一條可展示、可測試的垂直能力。
2. 先做 Durable State，再加入模型規劃。
3. 先證明 deterministic 0-token path，再做複雜 Agent。
4. 多 Agent、Device Mesh、向量資料庫和自我修改都不是前期依賴。
5. 每個 Phase 都要有明確完成標準和故障測試。
6. 未通過前一階段的 Durable / Security invariants，不進入下一階段。

## 2. 目前基線

Repo 已有、不要重做：

- Self-contained Node runtime 與版本化 release 安裝。
- systemd user service、health check、update 與 rollback 基礎。
- Fastify Gateway、React Web UI、HTTPS、WebSocket。
- 首次 pairing、管理員登入、Session、CSRF 與 Settings。
- SQLite WAL 基礎資料庫。
- Durable Project、Goal、Task、Run、Wake、Event、Lease 與 Outbox 資料模型。
- Goal / Task state machine、idempotency 與 restart reconciliation。
- Project / Goal API 與 append-only Event Ledger。
- 系統狀態與 Activity UI。
- Codex App Server 整合基礎。
- Headless Raspberry Pi 的 ChatGPT device-code OAuth。
- Agent-Web 既有整合入口。

目前尚未完成的 Secretary / Execution 部分：

- Secretary Portfolio、Today、Waiting on You、Decision Queue。
- Commitment service、Portfolio projection 與 Project Detail API。
- Deterministic automation 與 Watcher。
- Goal Compiler、Plan IR、bounded ReAct、Verifier。
- Browser Authentication Gate。
- Project Memory、Experience、Skill 與受控自主進步。

下一個實作階段是 Phase 4，不回頭重寫已完成的 Phase 0–3。

---

## Phase 0–2：Foundation

狀態：`EXISTING BASELINE`

詳細內容見 [Phase 0–2](PHASE-0-2.md)。後續只做必要修補，不擴張 scope。

保留驗收：

~~~text
乾淨 Raspberry Pi 可一條指令安裝
重啟後服務自動運行
其他裝置可安全進入 Web UI
設定與 state 不因更新消失
OAuth 可在沒有 GUI 的 Pi 上由使用者裝置完成
~~~

---

## Phase 3：Durable Responsibility Store

狀態：`COMPLETED`（詳見 [Phase 3 實作說明](PHASE-3.md)）

目標：先建立不依賴 LLM 的責任真實來源。

### 建立資料模型

- `projects`
- `goals`
- `goal_versions`
- `commitments`
- `plans`
- `tasks`
- `runs`
- `events`
- `wake_conditions`
- `leases`
- `outbox`
- `approvals`
- `artifact_refs`

### 建立 Kernel 規則

- Schema migration 與版本相容策略。
- Goal 與 Task state machine。
- Transactional state transition。
- Append-only Event Ledger。
- Transactional Outbox。
- Lease acquire、renew、expire。
- Idempotency key 與 side-effect intent。
- Repository / service boundary，HTTP route 不直接寫 SQL。

Goal 終態只允許：

~~~text
COMPLETED   Completion Criteria 已驗證
CANCELLED   使用者明確取消
~~~

`FAILED` 只能是 Run 或 Task 結果，不能自動終止 Goal。

### 最小 API

~~~text
POST   /api/v1/projects
GET    /api/v1/projects
POST   /api/v1/goals
GET    /api/v1/goals
GET    /api/v1/goals/:id
POST   /api/v1/goals/:id/pause
POST   /api/v1/goals/:id/resume
POST   /api/v1/goals/:id/cancel
GET    /api/v1/goals/:id/events
~~~

### 完成標準

~~~text
Goal accepted 前已原子保存 Goal + Event + first Wake
建立三個 Goal 後重啟 Gateway，狀態完全保留
Run 中途崩潰後 Lease 過期，可安全重新取得
相同 idempotency key 不產生兩次副作用
Migration 可從前一版資料庫升級並保留資料
~~~

---

## Phase 4：Secretary Portfolio MVP

狀態：`COMPLETED`（詳見 [Phase 4 實作說明](PHASE-4.md)）

目標：在還沒有 AI Planner 前，先做出真正的秘書資料與介面。

### Web UI

~~~text
Today
Waiting on You
Waiting on Others
Upcoming
Active Projects
Needs Decision
Recently Completed
~~~

### 功能

- 明確的 `[聊天]`、`[交辦]` 模式。
- Project 和 Goal 建立、查看、暫停、恢復、取消。
- Priority、Deadline、Attention Policy。
- Autonomy Contract：Observe、Prepare、Ask Before Act、Act Within Policy、Fully Automated。
- Commitment Ledger：使用者、Agent-OS、外部對象的承諾。
- Project Detail：Goals、Commitments、Timeline、Artifacts、等待原因。
- Goal accepted、progressed、waiting、blocked、completed 事件。

此階段先用表單和 deterministic rules，不需要模型自動理解所有輸入。

### 完成標準

~~~text
使用者可建立三個不同 Project / Goal
可設定優先順序、截止日期與 Autonomy
Today 能顯示快截止與高優先責任
Waiting on You 能顯示待澄清和待批准事項
Commitment 到期前產生正確提醒事件
取消 Goal 必須是明確操作並留下 Audit
~~~

---

## Phase 5：Wake Engine 與 0-Token Automation

目標：證明 Agent-OS 不需要每次排程都呼叫 AI。

### Wake Engine

- `TIME`
- `INTERVAL`
- `EVENT`
- `WEBHOOK`
- `USER_INPUT`
- `APPROVAL_GRANTED`
- `AUTH_COMPLETED`
- `NETWORK_RECOVERED`
- `DEADLINE_NEAR`

### Durable Runner

- Due Wake scan。
- Worker concurrency limit。
- Exponential backoff + jitter。
- Misfire Policy：Run Once、Latest Only、Run All、Skip、Replan。
- Startup Reconciliation。
- Notification Outbox。
- Token / tool / duration usage ledger。

### 最小 Capability Framework

- Capability definition 與 JSON Schema。
- Registry、Runner、timeout、retry、risk、permissions。
- HTTP read、template render、notification send。
- Schema validator 與 deterministic verifier。

### 第一條垂直案例：每日天氣

~~~text
建立 Goal 時選擇 Weather Capability
→ 每日 09:00 Wake
→ Weather API
→ Schema Validation
→ Template
→ Notification
→ Next Wake
~~~

### 完成標準

~~~text
每日天氣正常 occurrence 為 0 model calls
排程等待期間不佔 Worker
Pi 關機跨過排程後依 RUN_LATEST_ONLY 正確恢復
斷網時退避，不高頻重試
通知不重複發送
Goal 仍保持 ACTIVE，直到使用者取消
~~~

這是第一個 Kernel MVP 截止點。

---

## Phase 6：Model Runtime、Goal Compiler 與 Bounded Agent

目標：讓現有 OAuth 真正服務 Responsibility Kernel，而不是只提供聊天。

### Model Runtime

- Codex App Server Adapter。
- 串流對話與中斷。
- Structured output。
- Model usage、error、timeout 和 retry normalization。
- OpenAI API Key / compatible provider 後續加入，不阻塞 Codex 路徑。

### Request Router

~~~text
Rule / known template
→ small classifier if needed
→ strong Goal Compiler only on low confidence or complex request
~~~

Router 必須輸出 execution mode、confidence、reason 和是否需要澄清。

### Goal Compiler

輸出：

- Desired Outcome。
- Agent Commitment。
- Completion Criteria。
- External Dependencies。
- Constraints、Priority、Attention、Autonomy、Budget。
- Versioned Responsibility Plan。

### Plan Runtime

- Plan IR 與 node schema。
- Task Packet、Result Envelope。
- Bounded ReAct：max tokens、tools、duration、attempts。
- Manager、Worker、Task/Plan/Goal Verifier。
- Context Builder 只讀相關 slice。

### 完成標準

~~~text
自然語言可正確分成問答、固定自動化、Watcher、Agent 或長期 Goal
已知天氣模板不呼叫強模型重新規劃
Worker 不能只用文字宣告完成，必須交 Result Envelope 和 Evidence
Manager 不讀完整 Worker Transcript
Model Run 結束後 Goal 狀態仍由 Kernel 持有
低信心或高風險 Request 會澄清，不猜測執行
~~~

---

## Phase 7：Watcher 與 Hybrid Long-term Goal

目標：證明同一 Kernel 能處理事件追蹤和多天模糊責任。

### 案例 A：漫畫更新

~~~text
Fetch → Parse → Normalize → Fingerprint
No change → Checkpoint + Next Wake, 0 model calls
Changed → Notify or semantic analysis
~~~

### 案例 B：七天市場報告

~~~text
程式每日蒐集和壓縮
→ 只保存 Delta、指標與 Evidence
→ 重大事件才喚醒 AI
→ 第七天批次分析和驗證
~~~

### 案例 C：持續找實習

~~~text
API / Browser 蒐集
→ deterministic 去重和硬條件過濾
→ 新職缺批次語意排名
→ 高匹配、快截止或需決定才通知
→ 持續到使用者確認入職或取消
~~~

### 成本功能

- Fingerprint、cache、delta processing。
- Batch model calls。
- Context budget。
- Model tier escalation。
- `tokens_per_verified_outcome` 指標。

### 完成標準

~~~text
漫畫無更新時為 0 model calls 和 0 使用者通知
市場七天資料跨重啟連續且不重複
實習 Goal 可等待、重試、通知並持續多天
Token Budget 耗盡只降級或等待，不會丟失 Goal
Strategic Review 低頻且只在異常或進度停滯時執行
~~~

---

## Phase 8：Agent-Web Browser Authentication Gate

目標：讓 Agent-Web 成為可替換 Browser Runtime，不改變 Goal ownership。

### Browser Adapter

- Navigate、snapshot、act、download。
- Browser Session 和 Profile opaque reference。
- Agent lease 與 user takeover lock。
- Browser Task checkpoint。

### Authentication Challenge

~~~text
Browser detects login / MFA / CAPTCHA
→ Persist checkpoint
→ WAITING_AUTH
→ Short-lived user takeover link
→ User exclusive control
→ Deterministic Auth Probe
→ AUTH_COMPLETED Wake
→ Resume original Task
~~~

### 安全要求

- 密碼、Cookie、MFA、Session Token 不進 LLM、Memory、Log 或 Project Archive。
- User Control 期間 Agent 不操作、不截圖。
- Takeover token 綁定 user、origin、profile、task，完成後撤銷。
- Login 不等於 Action Approval。
- Agent-Web 或 Gateway 重啟後 Challenge 仍可恢復。

### 完成標準

~~~text
Agent 遇到登入頁會停止並通知使用者
等待登入期間 0 model calls 且不佔 Worker
使用者登入後原 Task 從 checkpoint 繼續
關閉 Browser 或 Challenge 過期不取消 Goal
人與 Agent 不會同時控制同一 Session
~~~

---

## Phase 9：Attention、Agenda 與 Briefing

目標：讓系統從任務引擎變成可日常使用的秘書。

### 製作

- Calendar event 和 availability 基礎模型。
- Agenda Builder。
- Deadline conflict detector。
- Urgent Alert。
- Decision Queue。
- Daily Brief。
- Weekly Review。
- Quiet hours、digest、notification dedupe。
- Waiting too long / no progress / broken commitment detection。

Daily Brief 優先由結構化資料與 Template 產生；只有需要摘要、取捨或衝突解釋時才用模型。

### 完成標準

~~~text
Today 能跨 Project 排序責任
撞期和快逾期項目能提前顯示
低優先更新會合併成 digest
Waiting on You 和 Waiting on Others 不混在一起
沒有重要變化時不發 Daily Brief 空訊息
Weekly Review 能指出完成、停滯、阻塞和下週優先事項
~~~

這是 Secretary MVP / 公開展示截止點。

---

## Phase 10：File Broker 與 Generated Capability

目標：安全處理檔案，並把重複 Agent 工作沉澱成程式能力。

### File Broker

- Workspace grant、read-only / read-write。
- Path canonicalization、symlink escape 防護。
- Hash、patch、diff、atomic write、backup、rollback。
- Artifact preview。

### Sandbox

- Podman 選配安裝。
- CPU、RAM、time、network、mount policy。
- Read-only root。
- 未知程式不得直接在 host 執行。

### Capability Lifecycle

~~~text
Search existing capability
→ Define spec
→ Generate candidate
→ Sandbox tests
→ Policy / approval
→ Version and register
→ Health check / rollback
~~~

### 完成標準

~~~text
未授權路徑無法讀取
檔案修改先顯示 diff，按 Autonomy 決定是否批准
生成程式通過 sandbox tests 才能註冊
Capability 版本可停用和 rollback
Sandbox 不存在時核心仍可運行
~~~

---

## Phase 11：Project Memory、Experience 與 Skill

目標：專案獨立封裝，完成後只提升有價值且有來源的記憶。

### Project Capsule

- Manifest、Project Card。
- Goal / Plan / Decision projection。
- Artifact / Evidence references。
- Project Memory。
- Archive / export。

### Memory Promotion

~~~text
Verified Project completion
→ Compact Project Card
→ Project-only details stay local
→ Confirmed stable facts propose Person Memory
→ Past work becomes Experience + project_ref
→ Repeatable method becomes Skill Candidate
~~~

### Retrieval

~~~text
L0 Person constraints and Skill names
L1 Project Cards
L2 relevant decisions and lessons
L3 exact Artifacts and Evidence
~~~

### 完成標準

~~~text
模型不載入完整歷史就能找到相關過往 Project
每筆 Person Memory 可追溯來源、修正和撤回
刪除 Project 會重評估衍生 Memory 與 Skill
Secret、Cookie 和未驗證推測不會被提升
Skill Candidate 有 input、output、permission、tests、version
~~~

---

## Phase 12：Controlled Self-Improvement

目標：先建立可量測改善，不允許無限制自我修改。

### Level 0：Observe

- Outcome、Trace、Failure、Token、Latency、Tool call 指標。
- Routing、Plan、Capability、Prompt 版本。
- 固定 regression dataset。

### Level 1：Recommend

- Pattern Miner。
- Improvement Proposal。
- Offline replay。
- Quality、Cost、Reliability、Safety 多目標評測。
- 人工 Promote / Reject / Rollback。

### 不在此階段開放

- 自動修改 Kernel invariants。
- 自動擴張 Permission。
- 自動改 Goal Contract 或 Completion Criteria。
- 未經 Shadow / Canary 的 production auto-promote。

### 完成標準

~~~text
系統能指出某類任務可由 ReAct 轉成 deterministic capability
Proposal 有 baseline、candidate、eval、expected saving 和 rollback
新版未通過 regression 不得啟用
可量測 tokens_per_verified_outcome 是否真的下降
~~~

---

## Phase 13：Device Mesh

最後才加入：

- Device identity、pairing、mTLS。
- Heartbeat、capability report、offline detection。
- Task lease 和 device selection。
- Desktop / Laptop node。
- Phone notification bridge。

完成標準：

~~~text
裝置上線後回報能力
等待該能力的 Goal 自動恢復
離線或過期 lease 不造成重複副作用
Device 不能取得未授權 Project、Secret 或 Workspace
~~~

---

## 3. 三個截止點

### Kernel MVP：完成 Phase 5

~~~text
Goal 可持久保存
Portfolio 可查看
Commitment 可追蹤
每日天氣正常執行 0 model calls
斷電與重啟後自動恢復
~~~

### Agent MVP：完成 Phase 8

~~~text
自然語言可編譯 Goal 和 Plan
Watcher 與長期 Hybrid Goal 可持續多天
Agent-Web 可等待使用者登入並恢復 Task
Token、Evidence、Approval 和 Recovery 可觀察
~~~

### Secretary MVP：完成 Phase 9

~~~text
跨 Project 排序 Today
追蹤使用者、Agent 和外部承諾
Decision Queue、Daily Brief、Weekly Review
只在正確時間要求使用者注意
~~~

## 4. 現在應該做什麼

下一步只做 Phase 3，不同時開始 Browser、Device Mesh 或自主進步。

建議順序：

1. 定稿 Phase 3 Schema 與 migration policy。
2. 實作 Project、Goal、Event、Wake、Lease、Outbox。
3. 實作 Goal / Task state transition service。
4. 加入 restart reconciliation 和 idempotency tests。
5. 建立最小 Goal API。
6. 通過 Phase 3 完成標準後再進入 Secretary UI。

第一個 milestone 應該是：

> **在完全不呼叫 LLM 的情況下，Agent-OS 接受一個 Goal、持久保存、跨重啟恢復，並且只有完成驗證或使用者取消才能結束。**

這個 milestone 成立後，後面的 AI、Cron、Browser、Memory 和 Skill 才有可靠的責任核心可以依附。
