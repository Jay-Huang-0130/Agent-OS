# Phase 8：Agent-Web Browser Authentication Gate

Phase 8 把 Plan 內的 Browser tool 名稱接到真實、可替換的 Agent-Web Adapter，並在登入、MFA 或 CAPTCHA 時把控制權安全交還使用者。Goal ownership 始終留在 Responsibility Kernel。

## Adapter protocol

Gateway 透過 `agent-webctl adapter request '<json>'` 使用 `agent-web-adapter-v1`。`agent-webctl info` 必須回報：

```text
READY=true
AGENT_CONTROL_AVAILABLE=true
AGENT_CONTROL_PROTOCOL=agent-web-adapter-v1
HUMAN_URL=https://...
```

Adapter 方法：

- `session.acquire`、`session.release`、`session.pause`、`session.resume`、`session.takeoverUrl`
- `page.navigate`、`page.snapshot`、`page.act`
- `downloads.wait`
- `auth.probe`

Session 與 Profile 只以 opaque reference 進入 Gateway。Adapter 以 `AUTH_REQUIRED` 回報 LOGIN、MFA、CAPTCHA 與不含秘密的 checkpoint。

## Tool Registry

Plan Worker 現在有真正的 host-side tool loop，而非只把 `allowedTools` 當提示文字：

- `web.open`
- `web.snapshot`
- `web.click`
- `web.find`
- `web.download`

模型只能呼叫 Task Packet 明確允許、且 Adapter health 確認可用的工具。缺少工具時 Task 與 Goal 進入 `BLOCKED`；Browser component 恢復前，API 不允許無效的 Resume。

## Durable authentication gate

```text
AUTH_REQUIRED
→ scrub secret-like fields
→ persist Browser checkpoint
→ release Agent lease
→ Task + Goal WAITING_AUTH
→ issue owner/origin/profile/task-bound takeover token
→ USER exclusive control
→ deterministic auth.probe
→ revoke takeover token
→ reacquire Agent lease
→ AUTH_COMPLETED Wake
→ Task READY + Goal ACTIVE
```

資料庫 migration v8 新增 `browser_sessions`、`browser_checkpoints`、`browser_auth_challenges`、`browser_takeover_tokens` 與 `browser_notifications`。Gateway 重啟後可從這些 durable records 重建狀態；Challenge 過期只會保持暫停，不會取消 Goal。

## Web UI 與 API

- `GET /api/v1/browser/status`
- `GET /api/v1/browser/challenges`
- `POST /api/v1/browser/challenges/:id/takeover`
- `GET /api/v1/browser/takeovers/:token`
- `POST /api/v1/browser/challenges/:id/complete`

Goal Detail 在 `WAITING_AUTH` 時顯示來源、Challenge 類型、安全接管與登入完成按鈕。通知中心會顯示 durable Browser notification。

## 安全不變量

- 密碼、Cookie、Authorization、Secret、Token、Credential 與 MFA code 會在 checkpoint 寫入前移除。
- Takeover token 只保存 SHA-256，並綁定 owner、Gateway origin、Profile 與 Task。
- `USER` 控制期間，Agent tool call 會被拒絕。
- `auth.probe` 成功才允許恢復；使用者按按鈕本身不代表驗證成功。
- Browser login 不會自動批准付款、發信、刪除或發布等外部效果。

## 驗收證據

- 型別檢查與 production build 通過。
- 測試覆蓋 secret-free checkpoint、人機互斥、takeover token、登入探測、AUTH_COMPLETED Wake、Task/Goal 恢復及受保護的 capability API。
- 沒有相容 Adapter 時 health 明確回報 unavailable，Browser Task 保持 BLOCKED，不假裝已瀏覽。
