# Phase 9：Attention、Agenda 與 Briefing

狀態：`COMPLETED`

Phase 9 把既有 Responsibility Kernel 的 Goal、Commitment、Approval 與 Project 資料，投影成可日常使用的秘書工作面。所有排序、衝突和通知決策均採 deterministic 規則；不需要模型即可產生 Agenda 與 Brief。

## 已完成能力

- `calendar_events` 與 `availability_windows`：持久化行事曆、取消狀態、冪等建立與每週可用時段。
- Agenda Builder：跨 Project 合併 Calendar、Goal deadline 與 Decision Queue，依 urgent、waiting、today 與時間穩定排序。
- Conflict detector：偵測行事曆重疊、deadline 落在會議中，以及事件落在 availability 之外。
- Urgent Alert：偵測逾期、24 小時內到期和 broken commitment。
- Waiting projection：`Waiting on You` 與 `Waiting on Others` 保持分離。
- Daily Brief：只在存在重要項目時建立與通知；空 Brief 不寫入、不推送。
- Weekly Review：列出七日內完成、停滯、阻塞與下一批優先事項。
- Attention policy：quiet hours 會暫存非緊急通知；低優先更新可合併成 digest；dedupe key 防止重複掃描造成重複通知。
- 通知會進入 Web notification center，並沿用既有 Telegram channel 推送。

## API

- `GET /api/v1/agenda`
- `GET|POST /api/v1/calendar/events`
- `POST /api/v1/calendar/events/:id/cancel`
- `GET|PUT /api/v1/calendar/availability`
- `GET|PUT /api/v1/attention/settings`
- `POST /api/v1/attention/scan`
- `GET /api/v1/briefings`
- `POST /api/v1/briefings/daily`
- `POST /api/v1/briefings/weekly`

所有寫入 API 都要求 owner session、CSRF，Calendar 建立另支援 `Idempotency-Key`。

## 可驗證證據

`phase9Secretary.test.ts` 固定時間與資料，驗證 migration、跨專案排序、三種衝突、Urgent Alert、Waiting 分流、quiet hours、去重、空 Brief 抑制，以及 Weekly Review 四個區段。`app.test.ts` 另從 HTTP 邊界驗證 Calendar、Agenda、認證與 CSRF。

~~~powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
~~~

驗收不是靠畫面或文字宣告，而是由 SQLite 狀態、API 回應與可重跑測試共同證明。
