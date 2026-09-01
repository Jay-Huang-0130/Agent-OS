# Agent-OS Phase 3：Durable Responsibility Store

Phase 3 將 Project、Goal 與執行責任從暫時的 HTTP request 提升為 SQLite 中可稽核、可重啟復原的 durable state。這一層不呼叫模型；它負責保證之後的 Secretary、Wake Engine 與 Agent Runtime 都使用同一份可信任狀態。

## 已實作範圍

- 版本化、可重複執行的 SQLite migration，既有 Phase 0–2 使用者、Session、設定與活動資料會保留。
- `projects`、`goals`、`goal_versions`、`commitments`、`plans`、`tasks`、`runs`、`events`、`wake_conditions`、`leases`、`outbox`、`approvals`、`artifact_refs` 核心資料表。
- Goal 與 Task 的明確狀態轉移規則；Goal 只有經過驗證並附 evidence 才能進入 `COMPLETED`，只有使用者取消才能進入 `CANCELLED`。
- `goal_versions` 不可修改，Event Ledger 不可更新或刪除。
- 每次事件寫入都在同一個 transaction 建立 Outbox intent，避免狀態已提交但通知遺失。
- 帶 TTL 的 lease acquire、renew、release 與 expire；同一資源同一時間只能由一個 holder 取得。
- 啟動 reconciliation：沒有有效 lease 的 `LEASED`／`RUNNING` Task 會回到 `READY`，執行中的 Run 會標記為 `INTERRUPTED`，並留下 `task.recovered` 事件。
- Project、Goal 建立與 Goal 控制操作支援 `Idempotency-Key`；相同 payload 會回傳原資源，不會重複副作用，同一 key 搭配不同 payload 會回傳衝突。
- HTTP route 只處理驗證、Session、CSRF 與回應；所有 SQL 與 invariant 位於 `ResponsibilityKernel` service boundary。

## 原子性保證

接受一個 Goal 時，下列資料會在同一個 `BEGIN IMMEDIATE` transaction 完成：

```text
Goal
├── Goal Version 1（完整 Goal Contract）
├── goal.accepted Event
├── EVENT / RUN_ONCE_NOW First Wake
└── Transactional Outbox intent
```

任何一步失敗時全部 rollback，不會留下只有 Goal、沒有 Wake 或 Event 的半完成狀態。

## API

所有 API 都需要 owner Session；`POST` 另外需要 CSRF。建議每個可能重試的 `POST` 都傳送最多 200 字元的 `Idempotency-Key` header。

```text
POST   /api/v1/projects
GET    /api/v1/projects
POST   /api/v1/goals
GET    /api/v1/goals?projectId=<uuid>&status=ACTIVE
GET    /api/v1/goals/:id
POST   /api/v1/goals/:id/pause
POST   /api/v1/goals/:id/resume
POST   /api/v1/goals/:id/cancel
GET    /api/v1/goals/:id/events?limit=100
```

建立 Goal 的最小 body：

```json
{
  "title": "完成 Phase 3",
  "desiredOutcome": "Responsibility Kernel 可以跨重啟保留責任狀態。",
  "completionCriteria": ["Phase 3 acceptance tests 全部通過。"]
}
```

可選欄位包含 `projectId`、`agentCommitment`、`cancellationCriteria`、`externalDependencies`、`constraints`、`priority`、`attentionPolicy`、`budget` 與 `autonomy`。

## 驗證

```bash
npm run build
npm test
npm run typecheck
```

測試涵蓋 migration 重入與資料保留、Goal 原子建立、append-only ledger、idempotency replay/conflict、Goal/Task 非法轉移、completion evidence、競爭 lease，以及模擬服務重啟後的 abandoned Task recovery。

## Phase 邊界

Phase 3 提供 durable truth 與執行協調原語，但不啟動背景 Worker，也不呼叫 LLM。Secretary Portfolio UI 屬於 Phase 4；due Wake 掃描、重試排程與 capability runner 屬於 Phase 5；Goal Compiler 與 bounded model runtime 屬於 Phase 6。
