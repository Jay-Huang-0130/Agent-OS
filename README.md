# Agent-OS

> Give it an outcome. It figures out the rest.  
> 你只需要告訴它想要的結果，剩下的由它自己想辦法。

Agent-OS 的目標不是再做一個聊天機器人，而是建立一個能接受委託、持續工作、使用不同裝置能力，並對結果負責的私人 AI 作業層。

專案目前已完成 Phase 0–3：可攜式基礎架構、隔離式安裝器、Gateway/Web 管理介面，以及可跨重啟保存 Project、Goal、Task、Event、Wake、Lease 與 Outbox 的 Durable Responsibility Store。OpenAI 官方 Codex app-server／ChatGPT OAuth 連線也已就緒；Secretary Portfolio、背景 Wake Worker 與模型執行層會在後續 Phase 接入。

## Phase 0–3 已完成

- Agent-OS 自帶固定版本的 Node.js 24 LTS，不安裝系統 Node、不執行全域 `npm install`。
- 正式支援 64-bit Raspberry Pi OS／Debian／Ubuntu 的 ARM64 與 x64。
- 使用 systemd user service 常駐；程式、狀態、設定與 runtime 都位於使用者的 XDG 目錄。
- Web 管理介面支援首次配對、安全登入、系統資源、服務狀態、活動紀錄、裝置設定與即時事件。
- Gateway 使用本機 SQLite，Session Cookie 為 HttpOnly／SameSite，寫入操作有 CSRF 與同源檢查。
- Agent Web 是選用的瀏覽器能力，不是 Phase 2 的必要依賴。
- Responsibility Kernel 以版本化 migration 管理 Project、Goal、Task、Run、Event、Wake、Lease、Outbox、Approval 與 Artifact reference。
- Goal 接受、版本、首個 Wake、Event 與 Outbox intent 以單一 transaction 提交；支援 idempotent retry、狀態機與啟動 recovery。

完整說明與開發流程請見 [Phase 0–2 實作說明](docs/PHASE-0-2.md)。

## 為什麼 Agent-OS 需要 Agent Web

瀏覽器是 Agent 接觸真實數位世界的重要介面。搜尋、登入、填表、下載、後台管理和許多沒有 API 的服務，都需要一個長期存在的瀏覽器工作環境。

Agent-OS 不把 Chromium 直接寫死在核心中，而是把 Agent Web 當成可安裝、可偵測、可替換的能力元件：

```text
Agent-OS
├── Goal / Delegation / Responsibility       未來核心
├── Device Mesh / Capability Discovery       未來核心
└── Browser capability
    └── Agent Web
        ├── Persistent Chromium
        ├── Cookie / Session / Downloads
        ├── HTTPS + noVNC human control
        ├── systemd 24/7 lifecycle
        └── future protected Agent Adapter
```

這個邊界讓 Agent Web 可以獨立更新，其他 Agent 也可以重用；Agent-OS 則負責安裝協調、能力發現、健康驗證，以及未來的任務與權限決策。

## 一條指令安裝

正式支援 Raspberry Pi OS、Debian 與 Ubuntu 的 64-bit ARM64／x86_64 Linux；Raspberry Pi 5 請使用 64-bit 作業系統。

以一般登入使用者執行，不要先切換成 root：

```bash
curl -fsSL https://raw.githubusercontent.com/Jay-Huang-0130/Agent-OS/main/bootstrap.sh | bash
```

安裝流程：

1. 下載固定的 Agent-OS release/source archive。
2. 偵測 Linux 架構、64-bit userspace 與 glibc 版本。
3. 下載固定的官方 Node.js 24 LTS ARM64／x64 runtime，並驗證內嵌 SHA-256。
4. 在 Agent-OS 自己的 staging 目錄建置前後端，不修改系統 Node/npm/Python。
5. 建立本機 TLS 憑證、首次配對碼與 systemd user service。
6. 以 atomic symlink 啟用 release，失敗時保留前一版。
7. 顯示 `https://IP:8787`、配對碼與憑證指紋；之後所有設定都在瀏覽器完成。

第一次用其他裝置開啟 `https://樹莓派IP:8787` 時，瀏覽器會提示自簽憑證；確認指紋後即可用終端顯示的配對碼建立管理密碼。

安裝器可能會為 `systemd user lingering` 要求一次 sudo 授權，確保 SSH 登出後服務仍持續運行；它不會用 sudo 安裝 Node 或 npm 套件。

## 更新

安裝與更新使用同一條指令：

```bash
curl -fsSL https://raw.githubusercontent.com/Jay-Huang-0130/Agent-OS/main/bootstrap.sh | bash
```

更新會建立全新的 release 目錄，再原子切換 `current` symlink 並重新啟動服務；不會把新檔案覆蓋混入舊程式碼。SQLite、管理密碼、設定、TLS 與選用元件都位於 release 之外，因此會保留。上一個 release 也不會刪除，啟動失敗時安裝器會自動切回。

已自訂的 IP 綁定位址與 port 會沿用；若這次要變更，可在指令前提供環境變數，例如：

```bash
curl -fsSL https://raw.githubusercontent.com/Jay-Huang-0130/Agent-OS/main/bootstrap.sh | AGENT_OS_PORT=9000 bash
```

`main` 適合目前開發階段。正式發布後應改用固定 tag 並提供 SHA-256，避免每次取得不同內容。

## 安裝後檢查

```bash
agent-osctl doctor
agent-osctl status
agent-osctl pairing
agent-osctl logs
```

正常狀態包含：

```text
[PASS] Managed runtime: v24.20.0
[PASS] Agent-OS service is active.
[PASS] Gateway health endpoint responds.
```

如果尚未完成首次設定，doctor 也會提示目前正在等待配對。Agent Web 未安裝時只會顯示資訊，不會把核心判定為故障。

## 自訂 Agent Web 密碼

只有執行 `--with-agent-web` 時才需要這個設定。若不想使用 Agent Web 自動產生的密碼，先建立只有自己能讀取的密碼檔並匯出路徑：

```bash
umask 077
printf '%s\n' 'your-password' > "$HOME/agent-web-password"
export AGENT_OS_AGENT_WEB_PASSWORD_FILE="$HOME/agent-web-password"
curl -fsSL https://raw.githubusercontent.com/Jay-Huang-0130/Agent-OS/main/bootstrap.sh | bash -s -- --with-agent-web
unset AGENT_OS_AGENT_WEB_PASSWORD_FILE
rm -f "$HOME/agent-web-password"
```

密碼至少 4 字元，但 4 字元只適合完全可信任的私人內網。

首次安裝 Agent Web 仍需加上 `--with-agent-web`。之後執行一般 bootstrap 更新時，安裝器會偵測既有 Agent Web 並保留瀏覽器資料、登入狀態與密碼，同時補上 Agent-OS 所需的新相容能力；若要刻意略過，可使用 `--skip-agent-web`。

## 管理指令

```bash
agent-osctl doctor
agent-osctl status
agent-osctl start
agent-osctl stop
agent-osctl restart
agent-osctl logs
agent-osctl pairing
agent-osctl browser info
agent-osctl browser status
agent-osctl browser url
agent-osctl browser update
agent-osctl browser password
```

目前 `agent-osctl` 管理 Gateway、Web 介面與選用的瀏覽器元件；Goal Engine、Agent Runtime、模型與 Device Mesh 等仍是後續階段。

## 目前人類操作與未來 Agent 操作

目前已完成：

```text
人類瀏覽器 -> HTTPS/WSS -> Agent-OS Web 管理介面
```

選用 Agent Web 後，另外提供 `HTTPS/noVNC -> Chromium` 的人工操作入口。

未來預計：

```text
人類 -> HTTPS/noVNC ─────────┐
                              ├-> 同一個 Chromium
Agent-OS -> protected Adapter ┘
```

noVNC 負責觀看、登入、MFA 和人工接管；Agent Adapter 負責 Snapshot、點擊、輸入、下載與操作租約。原始 CDP 不會直接暴露到內網。

詳見 [Agent Web 整合設計](docs/AGENT-WEB-INTEGRATION.md)。

## 專案資料位置

```text
~/.local/share/agent-os/runtimes             Agent-OS 私有 Node.js
~/.local/share/agent-os/releases             不可變 release
~/.local/share/agent-os/current              目前啟用的 release symlink
~/.local/state/agent-os                      SQLite、TLS、配對碼與快取
~/.config/agent-os                           runtime 設定與 user service
~/.local/bin/agent-osctl                     管理指令
```

如果選裝 Agent Web，它仍維持自己的來源、服務與 Chromium Profile；Agent-OS 不會建立第二份 Profile。

## 開發與驗證

```bash
git clone https://github.com/Jay-Huang-0130/Agent-OS.git
cd Agent-OS
bash ./validate.sh
bash ./install.sh
```

安裝 Web 管理介面，或另外加入選用的 Agent Web 瀏覽器元件：

```bash
bash ./install.sh
bash ./install.sh --with-agent-web
bash ./install.sh --force-agent-web-update
```

## 文件

- [VISION.md](VISION.md)：Agent-OS 的完整產品願景。
- [Phase 0–2 實作說明](docs/PHASE-0-2.md)：支援平台、隔離方式、API、安全與安裝流程。
- [Phase 3 Durable Responsibility Store](docs/PHASE-3.md)：資料模型、狀態機、Event/Outbox、Lease、recovery、idempotency 與 Goal API。
- [Agent Web 整合設計](docs/AGENT-WEB-INTEGRATION.md)：元件生命週期、能力探測、自動安裝、安全與未來 Adapter。
- [OpenAI OAuth 整合](docs/OPENAI-OAUTH.md)：Codex app-server、headless 裝置代碼登入、隔離與 API。

## 專案狀態

目前版本建立的是可以實際執行的 foundation 與 durable responsibility kernel，不代表完整 Agent-OS 已完成。Phase 3 會以 transaction 原子接受 Goal、保存版本化 Goal Contract、寫入 append-only Event、建立 first Wake 與 Outbox intent；同時提供狀態機、idempotency、lease 與啟動復原。OpenAI 登入使用適合樹莓派與遠端伺服器的 ChatGPT device-code 流程，OAuth 權杖由官方 Codex 管理並保存在 Agent-OS 私有 state 目錄，不會送到瀏覽器。

後續建議依序實作：

1. Secretary Portfolio 與 Commitment views（Phase 4）。
2. Wake Engine、背景 Worker 與 deterministic Capability runner（Phase 5）。
3. Agent Runtime、Goal Compiler 與模型抽象層（Phase 6）。
4. Watcher 與 Agent Web protected Adapter。
5. Approval、Audit、Memory 與 Human Takeover。
6. Device identity 與 Personal Device Mesh。
