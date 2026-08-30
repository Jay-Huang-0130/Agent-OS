# OpenAI OAuth 整合

Agent-OS 使用 OpenAI 官方 `@openai/codex` 套件提供的 `codex app-server`，不自行模擬 OAuth、不讀取瀏覽器 Cookie，也不把 access token 或 refresh token 傳到 Web UI。

## 使用流程

1. 在 Agent-OS 的「設定」頁按下「連接 OpenAI」。
2. Gateway 透過 Codex app-server 的 `account/login/start` 啟動 `chatgptDeviceCode` 流程。
3. Web UI 顯示 OpenAI 驗證網址與一次性代碼。
4. 使用者在自己的瀏覽器完成 ChatGPT 登入。
5. Codex app-server 收到完成通知、保存 OAuth 資料並自行處理後續 refresh。
6. Gateway 只把連線狀態、帳號 Email 與方案類型傳給已登入的 Agent-OS 擁有者。

樹莓派採用 device-code 而不是 localhost callback，因為使用者通常是在另一台電腦或手機用 `https://IP:8787` 操作；localhost callback 會指向操作端裝置，而不是樹莓派。

## 隔離與資料位置

- Codex 是 `@agent-os/gateway` 的固定版本 dependency，安裝在每個 Agent-OS release 的 `node_modules`，不會執行全域 `npm install -g`。
- Linux ARM64、Linux x64、Windows 與 macOS 由官方套件的 platform dependency 選擇對應 binary。
- `CODEX_HOME` 預設為 `~/.local/state/agent-os/credentials/codex`。
- 安裝器以 `0700` 建立 credentials 目錄，systemd 服務使用 `UMask=0077`。
- 更新 release 時，state 目錄不會刪除，因此登入狀態可以跨版本保留。
- 瀏覽器只取得 device code 和非敏感的連線摘要；OAuth token 不會出現在 API 回應、WebSocket 或活動紀錄。

## API

所有端點都要求 Agent-OS owner session；變更狀態的端點另外要求 CSRF token。

```text
GET  /api/v1/providers/openai
POST /api/v1/providers/openai/oauth/start
POST /api/v1/providers/openai/oauth/cancel
POST /api/v1/providers/openai/logout
```

WebSocket 事件：

```text
provider.openai.updated
```

## 官方依據

- [Codex app-server Auth endpoints](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints)
- [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication)

一般 OpenAI API 呼叫仍使用 API key 或官方支援的 workload identity；這個整合使用的是 Codex app-server 明確提供的 ChatGPT managed authentication，後續模型執行也必須走相符的 Codex runtime 路徑，不能把 ChatGPT OAuth token 當成一般 API key 使用。
