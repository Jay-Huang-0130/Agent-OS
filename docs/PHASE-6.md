# Phase 6：Model Runtime、Goal Compiler 與 Bounded Agent

狀態：`COMPLETED`（2026-09-01）

Phase 6 把既有 ChatGPT device-code OAuth 從「只驗證登入」接到 Responsibility Kernel。使用者仍只看到一個聊天輸入框；系統自行判斷問答、固定排程、Watcher、單次 Agent 或長期 Goal，不要求使用者先分類。

## 實作架構

```text
自然語言訊息
  → durable assistant_requests
  → domain-free known rules
  → structured Request Router（模糊時）
  → 低信心／高風險：澄清
  → 直接問答：Codex structured response
  → 持續責任：Goal Compiler
       → Goal Contract v1
       → Plan IR v1
       → bounded Task Packets
       → Capability + Wake 或 AI_EXECUTION Wake
```

### Codex Model Runtime

- 共用同一個官方 Codex app-server process 與 ChatGPT OAuth，不要求另一組 API key。
- 使用 `thread/start`、`turn/start`、`turn/interrupt`。
- 每次 turn 使用 JSON Schema 限制最終輸出。
- `item/agentMessage/delta` 經既有 WebSocket 發送串流事件。
- token usage、duration、provider、model、thread、turn、error 與 budget 持久化到 `model_runs`。
- timeout、interrupt、authentication、invalid output 與 provider failure 正規化為穩定錯誤碼。
- Model Run 只是一筆執行紀錄；不能把 Goal 標成完成。

### Router 與 Goal Compiler

- 規則只辨識通用語意形狀（問句、固定時間、狀態變化、高風險），沒有天氣、公車、地圖等領域硬編碼。
- 模糊輸入才呼叫 structured classifier。
- confidence 低於 `0.7` 或可能不可逆時必須詢問，不猜測執行。
- Compiler 產生 Desired Outcome、Agent Commitment、Completion／Cancellation Criteria、Dependencies、Constraints、Priority、Attention、Autonomy、Budget 與版本化 Plan IR。
- 固定排程只有在 Compiler 能產生 LOW-risk、可自測、可決定性執行的 Python JSON Capability 時才走 0-token path；否則建立 `AI_EXECUTION`。

### Plan Runtime 與 Worker

- Plan node 具有 dependency、completion criteria、allowed tools、max tokens、max duration 與 max attempts。
- Task Packet 只帶目標、相關 context slice、工具白名單與硬預算。
- Worker 必須回傳 Result Envelope：status、summary、outputs、evidence、next actions。
- `COMPLETED` 但沒有 evidence 會被拒絕並在剩餘 attempt 內重試。
- Manager Context 只讀 Goal 摘要與 Task Result Envelopes，不讀完整 Worker transcript。

## Schema migration v5

- `assistant_requests.assistant_message`
- `assistant_requests.model_run_id`
- `model_runs`
- `plans` 與 `tasks` 沿用 Phase 3 durable schema，由 Kernel 新增版本化 Plan materialization。

## API 與 UI

- `POST /api/v1/assistant/requests`：自動 Router、回答或 materialize responsibility。
- `GET /api/v1/assistant/requests`：回傳完整 user／assistant conversation record。
- `POST /api/v1/model-runs/:id/interrupt`：只允許 owner 中斷仍在執行的 run。
- Assistant UI 顯示 AI 判定的 execution mode 與持久化回覆，不顯示要求使用者選類型的控制項。

## 驗收證據

Gateway 測試涵蓋：

- 問答、固定排程、Watcher 與高風險澄清。
- 模糊輸入使用 classifier，低信心不執行。
- Plan IR／Task Packet 持久化，Goal 仍由 Kernel 持有。
- Manager context 不包含 transcript。
- prose-only completion 被拒絕，Evidence envelope 才能完成 Worker 回報。
- model usage 正規化並寫入 `model_runs`。
- Phase 5 deterministic Wake 維持 `model_calls = 0`。

Phase 7 才會加入 delta fingerprint、semantic change analysis 與完整 Hybrid long-term watcher；Phase 6 只建立它需要的 Router、Plan 與模型執行邊界。
