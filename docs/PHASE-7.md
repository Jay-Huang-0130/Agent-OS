# Phase 7：Watcher 與 Hybrid Long-term Goal

狀態：`COMPLETED`（2026-09-02）

Phase 7 讓同一個 Responsibility Kernel 能持續監看公開 HTTP/HTTPS 資料來源。Watcher 不硬編碼天氣、漫畫、商品或求職領域；它只負責 Fetch、Normalize、Fingerprint、Delta、Checkpoint、Wake、Evidence 與有限的語意升級。

## 執行流程

```text
Due Watcher
  → public URL / SSRF policy
  → bounded HTTP fetch（15 秒、512 KiB、最多 3 次 redirect）
  → deterministic normalize
  → SHA-256 fingerprint
  → unchanged：Observation + next check，0 model calls、0 notifications
  → changed：durable Checkpoint + Delta + Evidence
       → semanticReview=false：直接通知
       → semanticReview=true 且尚有 token budget：一次 WAKE 分析後通知
       → model unavailable / budget exhausted：保留 deterministic Delta 並降級通知
```

## Durable schema migration v7

- `watchers`：來源、週期、狀態、下次檢查、錯誤退避與總 token 預算。
- `watcher_checkpoints`：只有初始或內容變更才新增版本；保存正規化內容與來源 metadata。
- `watcher_observations`：每次檢查的 INITIAL／UNCHANGED／CHANGED／FAILED／FINAL_REVIEW 結果與 Evidence。
- `watcher_notifications`：只保存變更、持續異常與長期 Goal 完成通知。
- 每次 watcher lifecycle 都寫入 append-only Goal Event Ledger。

## Hybrid Goal

- 無限期 Watcher 保持 Goal `ACTIVE`，直到使用者取消。
- 有 `endAt` 的 Watcher 到期後建立 `FINAL_REVIEW`，以 `watcher:<id>` Evidence 完成 Goal。
- 抓取失敗採 exponential backoff，第三次及其倍數才要求使用者注意；Goal 不會遺失或被錯誤完成。
- 啟動時會掃描 SQLite 中已到期的 Watcher，因此重啟後可接續。
- Lease 防止多個 Worker 同時檢查同一 Watcher。

## 安全邊界

- 只允許沒有內嵌帳密的 HTTP/HTTPS URL。
- DNS 解析後拒絕 loopback、private、link-local、multicast 位址；每次 redirect 都重新檢查。
- 回應限制 512 KiB，逾時 15 秒。
- Phase 7 不操作登入頁、Cookie、MFA 或 CAPTCHA；這些屬於 Phase 8 Browser Authentication Gate。

## API 與 UI

- `POST /api/v1/watchers`
- `GET /api/v1/watchers`
- `GET /api/v1/watchers/:id`
- `POST /api/v1/watchers/:id/check`
- `POST /api/v1/watchers/:id/cancel`
- Goal detail 回傳關聯 Watcher；Web UI 顯示來源、週期、checkpoint、token 使用、錯誤與下次檢查，並支援立即檢查和取消。
- Chat Compiler 對 `CHANGE_WATCHER`／`HYBRID_GOAL` 只在取得具體公開 URL 時建立 Watcher；沒有來源時仍會誠實顯示缺少能力。

## 驗收證據

Gateway tests 覆蓋：

- migration v7 與四個 durable tables。
- JSON key order 不同但內容相同時：1 個 checkpoint、0 model calls、0 notifications。
- 真實 Delta：新增 checkpoint、保存 HTTP Evidence、只呼叫一次語意分析並送一次通知。
- 連續失敗：退避、低頻警告、Goal 保持 `ACTIVE`。
- 有限期 Hybrid Goal：到期才以 durable Evidence 完成。
- Authenticated API：建立、手動檢查、Goal detail 與 Watcher detail 都讀取真實 SQLite 狀態。
