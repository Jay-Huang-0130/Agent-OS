# OpenAI OAuth 整合

Agent-OS 使用 OpenAI 官方 `@openai/codex` 套件提供的 `codex app-server`，不自行模擬 OAuth、不讀取瀏覽器 Cookie，也不把 access token 或 refresh token 傳到 Web UI。

## 預設：瀏覽器 OAuth

1. 在 Agent-OS 的「設定」頁按下「連接 OpenAI」。
2. Gateway 透過 Codex app-server 的 `account/login/start` 啟動 `chatgpt` 瀏覽器 OAuth。
3. Gateway 透過 Agent Web 的受限本機 Unix Socket，把官方授權頁開在樹莓派上的既有 Chromium；此能力只接受 OpenAI 官方 HTTPS OAuth host，不提供一般網頁控制。
4. Web UI 開啟 Agent Web noVNC，讓使用者在樹莓派瀏覽器完成登入或 MFA。
5. OpenAI 重新導向 `localhost` 後仍在同一台樹莓派，因此 Codex app-server 會自動接收 callback，不必複製或貼回網址。
6. Codex app-server 完成 code exchange、保存 OAuth 資料並處理後續 refresh。

舊版 Agent Web 或 Agent Web 不可用時，UI 才會顯示遠端 callback 回送備援。Gateway 只接受目前登入產生的 `http://localhost`、`127.0.0.1` 或 `::1` callback，並驗證完全相同的 port、path 與 OAuth state，避免回送功能被用來請求其他位址。callback URL 含有短效授權碼，因此不會寫入資料庫、活動細節或日誌。

## 備援：裝置代碼

設定視窗仍提供「改用裝置代碼」。這會啟動 `chatgptDeviceCode`；只有瀏覽器 callback 流程不可用時才需要。OpenAI 帳號若停用 Codex 裝置代碼授權，應繼續使用預設瀏覽器 OAuth。

## 隔離與資料位置

- Codex 是 `@agent-os/gateway` 的固定版本 dependency，安裝在每個 Agent-OS release 的 `node_modules`，不會執行全域 `npm install -g`。
- Linux ARM64、Linux x64、Windows 與 macOS 由官方套件的 platform dependency 選擇對應 binary。
- `CODEX_HOME` 預設為 `~/.local/state/agent-os/credentials/codex`。
- 安裝器以 `0700` 建立 credentials 目錄，systemd 服務使用 `UMask=0077`。
- 更新 release 時，state 目錄不會刪除，因此登入狀態可以跨版本保留。
- 瀏覽器只取得登入網址與非敏感的連線摘要；OAuth token 不會出現在 API 回應、WebSocket 或活動紀錄。

## API

所有端點都要求 Agent-OS owner session；變更狀態的端點另外要求 CSRF token。

```text
GET  /api/v1/providers/openai
POST /api/v1/providers/openai/oauth/start
POST /api/v1/providers/openai/oauth/complete
POST /api/v1/providers/openai/oauth/cancel
POST /api/v1/providers/openai/logout
```

`oauth/start` 接受 `{ "method": "browser" }` 或 `{ "method": "device" }`，省略時預設為 `browser`。

WebSocket 事件：

```text
provider.openai.updated
```

## 官方依據

- [Codex app-server Auth endpoints](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints)
- [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication)

一般 OpenAI API 呼叫仍使用 API key 或官方支援的 workload identity；這個整合使用的是 Codex app-server 明確提供的 ChatGPT managed authentication，後續模型執行也必須走相符的 Codex runtime 路徑，不能把 ChatGPT OAuth token 當成一般 API key 使用。
