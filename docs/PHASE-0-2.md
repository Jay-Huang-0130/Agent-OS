# Agent-OS Phase 0–2

這份文件描述目前已可執行的範圍。模型、OAuth、Agent 工具迴圈與持久任務不在 Phase 2 內；管理介面會清楚標示為下一階段，不會假裝已連線。

## 支援平台

| 平台 | CPU | Runtime | 支援 |
|---|---|---|---|
| Raspberry Pi OS / Debian / Ubuntu 64-bit | `aarch64` / `arm64` | Node.js 24.20.0 `linux-arm64` | 正式 |
| Debian / Ubuntu 64-bit | `x86_64` | Node.js 24.20.0 `linux-x64` | 正式 |
| 32-bit Raspberry Pi OS | `armv7l` | 無 Node 24 官方 binary | 拒絕並提示改用 64-bit OS |
| Alpine / musl | 任意 | 非正式目標 | Phase 0–2 不支援 |

Node runtime 版本、下載 URL 與 SHA-256 都固定在 release 中，不會在安裝時追蹤 `latest`。這讓相同 Agent-OS release 在不同裝置上可重現。

## 安裝隔離

```text
~/.local/share/agent-os/
├── runtimes/node/v24.20.0-linux-*/
├── releases/<release-id>/
└── current -> releases/<release-id>

~/.local/state/agent-os/
├── agent-os.db
├── pairing-code
└── tls/

~/.config/agent-os/
├── runtime.env
└── systemd/user/agent-os.service

~/.local/bin/agent-osctl
```

安裝器不會執行 `apt install nodejs`、`npm install -g`、`pip install`、nvm 或修改 shell profile。正式 release 應由 CI 預先建置；目前 source 安裝模式會在 staging 目錄使用 Agent-OS 自帶的 npm 建置，完成後移除 dev dependencies。

為了登出 SSH 後仍持續運行，安裝器會確認 systemd user lingering 已啟用；若一般使用者權限不足，會透過 `sudo loginctl enable-linger` 要求一次管理員授權。這不會安裝全域套件。可用 `--session-only` 明確停用，但服務會隨使用者 session 結束。

## 執行架構

```text
瀏覽器
  ├── HTTPS REST API ── Gateway / Fastify
  └── WSS 即時事件 ───┘
                         ├── SQLite：使用者、Session、設定、活動
                         ├── 系統資源：CPU、記憶體、磁碟、溫度
                         └── Web 靜態檔案：React + Vite
```

Gateway 預設監聽 `0.0.0.0:8787`。安裝器會產生包含 `agent-os.local`、`localhost`、`127.0.0.1` 與當前 LAN IP 的自簽 TLS 憑證。

## 安全邊界

- 首次啟動產生 8 位隨機配對碼，檔案權限為 `0600`，完成設定後刪除。
- 管理密碼使用 scrypt 與隨機 salt；不保存明文。
- Session token 只以 SHA-256 雜湊保存，Cookie 設為 HttpOnly、SameSite=Strict，HTTPS 時加上 Secure。
- 設定更新與登出必須通過 CSRF token；所有變更請求另外檢查 Origin。
- 登入失敗按來源 IP 限流。
- systemd 服務開啟 `NoNewPrivileges`、`PrivateTmp` 與核心/系統保護選項。

目前是單一擁有者、可信任 LAN 的 MVP。正式對外網路部署仍應透過 VPN 或受控 reverse proxy，不建議直接將 8787 port 暴露到 Internet。

## API

```text
GET  /healthz
GET  /readyz
GET  /api/v1/meta
POST /api/v1/setup/complete
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/session
GET  /api/v1/system/status
GET  /api/v1/activity
GET  /api/v1/settings
PUT  /api/v1/settings
GET  /api/v1/providers/openai
POST /api/v1/providers/openai/oauth/start
POST /api/v1/providers/openai/oauth/complete
POST /api/v1/providers/openai/oauth/cancel
POST /api/v1/providers/openai/logout
WS   /api/v1/events
```

`/providers/openai` 是 Phase 3 開始後加入的相容擴充，詳細流程見 [OpenAI OAuth 整合](OPENAI-OAUTH.md)。

## 本機開發

開發機建議使用 Node.js 24：

```bash
npm install
npm run build
npm test
bash ./validate.sh
```

開發模式分成 Gateway 與 Vite：

```bash
npm run dev
npm run dev:web
```

Vite 使用 `4173`，並把 `/api` 與 WebSocket 代理到 Gateway 的 `8787`。

## 樹莓派安裝

```bash
curl -fsSL https://raw.githubusercontent.com/Jay-Huang-0130/Agent-OS/main/bootstrap.sh | bash
```

同一條指令也用於更新。每次更新會：

1. 將新程式建置到新的 `releases/<release-id>`，不覆蓋現有 release。
2. 保留 `~/.local/state/agent-os` 與 `~/.config/agent-os` 中的資料、登入設定、TLS 和自訂 port。
3. 原子切換 `current` symlink，重新啟動 systemd user service，讓新版本立即生效。
4. 保留上一版；如果新服務無法啟動，自動切回舊 release。

這不是把新檔案直接覆蓋到舊目錄，因為那會留下已被移除的舊檔案。程式碼採乾淨 release 切換，持久資料則獨立保留。

本機 checkout 測試：

```bash
bash ./install.sh
```

選用 Agent Web 瀏覽器能力：

```bash
bash ./install.sh --with-agent-web
```

管理指令：

```bash
agent-osctl status
agent-osctl start
agent-osctl stop
agent-osctl restart
agent-osctl logs
agent-osctl pairing
agent-osctl doctor
```
