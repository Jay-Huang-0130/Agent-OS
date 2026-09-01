# OpenAI OAuth 整合

Agent-OS 使用 OpenAI 官方 `@openai/codex` 套件提供的 `codex app-server`，不自行模擬 OAuth、不讀取瀏覽器 Cookie，也不把 access token 或 refresh token 傳到 Web UI。

## Headless 登入流程

1. 在 Agent-OS 的「設定」頁按下「連接 OpenAI」。
2. Gateway 透過 Codex app-server 的 `account/login/start` 啟動 `chatgptDeviceCode`。
3. Web UI 顯示 OpenAI 驗證網址與一次性代碼，並在使用者目前的瀏覽器開啟驗證頁。
4. 使用者登入 ChatGPT 並輸入一次性代碼；樹莓派不需要 GUI、Chromium 或 localhost callback。
5. Codex app-server 收到 `account/login/completed`，保存 OAuth 資料並自行處理後續 refresh。
6. Gateway 只把連線狀態、帳號 Email 與方案類型傳給已登入的 Agent-OS 擁有者。

這與 OpenClaw 在 headless／callback-hostile 環境使用 `--device-code` 的設計相同。OpenAI 帳號或 workspace 必須允許 Codex 裝置代碼登入。

## 隔離與資料位置

- Codex 是 `@agent-os/gateway` 的固定版本 dependency，安裝在每個 Agent-OS release 的 `node_modules`，不會執行全域 `npm install -g`。
- Linux ARM64、Linux x64、Windows 與 macOS 由官方套件的 platform dependency 選擇對應 binary。
- `CODEX_HOME` 預設為 `~/.local/state/agent-os/credentials/codex`。
- 安裝器以 `0700` 建立 credentials 目錄，systemd 服務使用 `UMask=0077`。
- 更新 release 時，state 目錄不會刪除，因此登入狀態可以跨版本保留。
- 瀏覽器只取得驗證網址、一次性代碼與非敏感的連線摘要；OAuth token 不會出現在 API 回應、WebSocket 或活動紀錄。

## API

所有端點都要求 Agent-OS owner session；變更狀態的端點另外要求 CSRF token。

```text
GET  /api/v1/providers/openai
POST /api/v1/providers/openai/oauth/start
POST /api/v1/providers/openai/oauth/cancel
POST /api/v1/providers/openai/logout
```

`oauth/start` 固定啟動 device-code 流程，不接受瀏覽器或 callback 模式。

WebSocket 事件：

```text
provider.openai.updated
```

## 官方依據

- [Codex app-server Auth endpoints](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints)
- [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication)

一般 OpenAI API 呼叫仍使用 API key 或官方支援的 workload identity；這個整合使用的是 Codex app-server 明確提供的 ChatGPT managed authentication，後續模型執行也必須走相符的 Codex runtime 路徑，不能把 ChatGPT OAuth token 當成一般 API key 使用。
