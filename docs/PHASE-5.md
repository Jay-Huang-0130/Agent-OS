# Agent-OS Phase 5：Wake Engine 與動態 0-Token Automation

Phase 5 完成通用的 durable scheduling 與 generated Capability 執行層。Production code 不認識天氣、公車、地圖或任何使用情境；每個人的自然語言需求先由 Request Router 分流，再選擇 deterministic code 或 AI execution。

## 核心資料流

```text
Natural-language request
→ Request Router / Goal Compiler（Phase 6）
→ DETERMINISTIC_AUTOMATION 或 AI_EXECUTION

DETERMINISTIC_AUTOMATION
→ generated Python JSON Capability
→ source policy + permissions + self-test + JSON Schema
→ durable Wake
→ 0-model-call occurrence

AI_EXECUTION
→ durable Wake
→ Phase 6 Model Runtime at occurrence time
```

Phase 5 是 Router 的下游，不用規則猜測使用者說的是哪個領域，也不會因為文字出現「每天」就直接執行生成程式。

## Durable Wake Engine

- SQLite due-wake scan，不使用 OS cron 作為責任真實來源。
- 有限 worker concurrency；等待排程不占 worker。
- SQLite claim、Wake lease 與 startup reconciliation。
- `RUN_ONCE_NOW`、`RUN_LATEST_ONLY`、`RUN_ALL`、`SKIP_AND_RESUME`、`REPLAN`。
- 失敗採 exponential backoff + jitter，達上限後保留 occurrence 結果並前進下一個排程。
- Goal 不會因單次 occurrence 失敗、略過或 automation 取消而自動結束。

## Generated Capability

Capability 是 owner-specific、版本化、可雜湊驗證的執行單位：

- Runtime contract：JSON stdin → `main(payload)` → 單一 JSON stdout。
- Input / output JSON Schema。
- 註冊前執行 self-test，再驗證 output schema。
- timeout 與 1 MB output limit。
- 每次執行使用獨立暫存目錄與 Python isolated mode。
- Phase 5 只接受 `LOW` risk。
- 權限僅允許 `notification:send` 與明確 `network:https:<host>`。
- 阻擋 subprocess、任意檔案 I/O、socket、dynamic eval/import 等能力。

這是 Phase 5 policy isolation，不宣稱等同容器安全邊界；容器、mount 與完整 sandbox lifecycle 屬於 Phase 10。

## Notification 與 Usage

- Notification 使用 durable outbox 與 occurrence idempotency key，避免重複通知。
- 每個 occurrence 記錄 model calls、tokens、tool calls、duration 與 success。
- Deterministic Capability 的正常 usage 固定為 `model_calls = 0`。
- AI execution 透過可替換 adapter 回填實際模型 usage。

## API

```text
POST /api/v1/capabilities
GET  /api/v1/capabilities

POST /api/v1/automations
GET  /api/v1/automations
POST /api/v1/automations/:id/cancel
```

生成 source 不會透過 list API 回傳。所有 mutation 都要求 owner Session、CSRF 與同源檢查。

## 驗收證據

自動測試涵蓋：

- 動態 Capability 正常 occurrence 為 0 model calls。
- 通知 outbox 去重。
- 關機跨過多次 interval 後，`RUN_LATEST_ONLY` 只執行最新 occurrence。
- 暫時性失敗排到未來重試，不形成 hot loop。
- 不安全 Python 在 registry 前被拒絕。
- Automation 取消不取消 Goal，Goal 保持 `ACTIVE`。
- API 沒有任何 domain-specific weather / bus / map route。
