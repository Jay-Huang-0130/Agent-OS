# Agent-OS Phase 4：Secretary Portfolio MVP

Phase 4 將 Phase 3 的 durable truth 投影成使用者可以直接管理的 Secretary Portfolio。這一階段不依賴 LLM；所有分類、提醒與狀態轉移都由 deterministic rules 產生。

## 已實作功能

### Secretary Portfolio

首頁直接讀取 SQLite 中的 Project、Goal、Commitment 與 Approval，提供：

```text
Today
Waiting on You
Waiting on Others
Upcoming
Active Projects
Needs Decision
Recently Completed
```

- `Today`：高優先、已到期或當日截止的 active Goal。
- `Waiting on You`：待澄清、待登入、待批准，或由使用者承諾但尚未完成的 Goal。
- `Waiting on Others`：狀態為 waiting，或有外部對象未完成承諾的 Goal。
- `Upcoming`：具有未來 deadline 的 Goal。
- `Needs Decision`：具有 pending Approval 的 Goal，可直接批准或拒絕。
- `Recently Completed`：最近經 evidence 驗證完成的 Goal。

### Project / Goal

- Web UI 可建立 Project 與結構化 Goal Contract。
- Goal 可設定 Desired Outcome、Completion Criteria、Priority、Deadline、Autonomy 與 Attention Policy。
- Project Detail 顯示 Goals、Commitments、Timeline、Artifacts 與 waiting / blocked reason。
- 使用者可明確暫停、恢復或取消 Goal；取消前會再次確認並留下 `goal.cancelled` Event。
- Kernel/API 支援 `goal.progressed`、`goal.blocked` 與帶 evidence 的 `goal.completed`。

### Commitment Ledger

- Commitment 記錄 owner、owed-to、promise、due time、status、follow-up policy 與 evidence refs。
- 支援 `USER`、`AGENT_OS`、`EXTERNAL_PARTY` 三種承諾人。
- 有 due time 的 Commitment 會在同一個 transaction 建立 TIME Wake。
- `remind_24h_before` 會把 Wake 安排在到期前 24 小時。
- Fulfill 或 cancel Commitment 會取消尚未消費的 reminder Wake 並留下 Event。

### Approval / Decision Queue

- Decision Gate 可建立 Approval，Goal 會原子進入 `NEEDS_APPROVAL`。
- Pending Approval 同時出現在 Waiting on You 與 Needs Decision。
- 使用者可以明確批准或拒絕。
- 批准後建立 `APPROVAL_GRANTED` Wake，讓後續 Worker 可以從原責任恢復。

### 單一 Assistant Intake

主要入口是一個自然語言聊天框，不要求使用者先選擇「聊天／交辦／Goal／長期任務」。資料流為：

```text
Natural-language message
→ durable assistant_requests intake
→ Request Router（Phase 6）
→ execution mode / clarification
→ Goal Compiler（只有需要持續責任時）
```

- Intake 與 Goal 是不同 aggregate；保存訊息不等於接受 Goal。
- Gateway 以 `202 Accepted` 回傳目前 routing 狀態。
- Phase 6 Runtime 尚未接入時，請求保持 `PENDING_ROUTING`，不會用前端猜測分類，也不會假裝產生 AI 回答。
- Project／Goal 表單保留為進階管理與測試 Kernel 的入口，不是一般使用者的主要流程。

## API

Phase 4 新增：

```text
POST   /api/v1/assistant/requests
GET    /api/v1/assistant/requests

GET    /api/v1/portfolio
GET    /api/v1/projects/:id

POST   /api/v1/commitments
GET    /api/v1/commitments
POST   /api/v1/commitments/:id/fulfill
POST   /api/v1/commitments/:id/cancel

POST   /api/v1/approvals
GET    /api/v1/approvals
POST   /api/v1/approvals/:id/decision

POST   /api/v1/goals/:id/progress
POST   /api/v1/goals/:id/block
POST   /api/v1/goals/:id/complete
```

所有寫入 route 都要求 owner Session、CSRF 與同源檢查。可重試的建立／狀態操作使用 `Idempotency-Key`。

## 驗收對照

```text
使用者可建立三個不同 Project / Goal              Web 表單 + durable API
可設定優先順序、截止日期與 Autonomy                Goal Contract 表單
Today 顯示快截止與高優先責任                       deterministic portfolio projection
Waiting on You 顯示待澄清和待批准事項              Goal state + Approval / Commitment projection
Commitment 到期前產生正確提醒事件                  TIME Wake + reminder_scheduled Event
取消 Goal 必須是明確操作並留下 Audit               confirmation + append-only goal.cancelled
```

自動測試另外涵蓋 unified intake 不會提早建立 Goal、Project Detail、Approval decision、`APPROVAL_GRANTED` Wake、Commitment fulfill 後取消 reminder，以及 Web mutation 的 CSRF / idempotency headers。

## Phase 邊界

Phase 4 只管理責任與注意力，不執行背景工作。Due Wake scan、通知派送、misfire 與 capability runner 屬於 Phase 5；自然語言 Goal Compiler、模型聊天與 bounded Agent 屬於 Phase 6。Records 頁面的成果／對話仍保留 prototype 標示，不屬於 Phase 4 的完成範圍。
