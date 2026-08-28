# Agent-OS

> Give it an outcome. It figures out the rest.  
> 你只需要告訴它想要的結果，剩下的由它自己想辦法。

Agent-OS 的目標不是再做一個聊天機器人，而是建立一個能接受委託、持續工作、使用不同裝置能力，並對結果負責的私人 AI 作業層。

專案目前位於 foundation／vision 階段。第一個正式加入的基礎能力是 [Agent Web](https://github.com/Jay-Huang-0130/Agent-Web)：在沒有 GUI 的 Raspberry Pi 上提供 24 小時運行、保存 Cookie 與登入 Session、可由人類從內網觀看及操作的 Chromium。

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

目前 foundation 安裝器支援 Agent Web 相同的目標環境：Raspberry Pi 5、ARM64、Debian 13 Trixie。

以一般登入使用者執行，不要先切換成 root：

```bash
curl -fsSL https://raw.githubusercontent.com/Jay-Huang-0130/Agent-OS/main/bootstrap.sh | bash
```

安裝流程：

1. 下載或更新 Agent-OS 到 `~/.local/share/agent-os/source`。
2. 安裝最小必要工具。
3. 執行 Agent Web 能力探測。
4. 若 Agent Web 已安裝且 `READY=true`，直接沿用。
5. 若缺少或不健康，自動下載、安裝或修復 Agent Web。
6. 使用 `agent-webctl info` 驗證瀏覽器子系統。
7. 安裝 `agent-osctl` 管理入口。

第一次全自動安裝若沒有提供密碼檔，會產生 16 字元隨機 Agent Web 網頁密碼並在終端顯示一次。請立即保存，之後可以執行 `agent-osctl browser password` 修改。

## 安裝後檢查

```bash
agent-osctl doctor
agent-osctl browser info
agent-osctl browser url
```

正常狀態包含：

```text
READY=true
BROWSER_SERVICE=active
NOVNC_SERVICE=active
WEB_SERVICE=active
HTTPS_AUTH_CHECK=401
```

`401` 代表 HTTPS 與密碼驗證正常，不是故障。

## 自訂 Agent Web 密碼

若不想使用自動產生的密碼，先建立只有自己能讀取的密碼檔並匯出路徑：

```bash
umask 077
printf '%s\n' 'your-password' > "$HOME/agent-web-password"
export AGENT_OS_AGENT_WEB_PASSWORD_FILE="$HOME/agent-web-password"
curl -fsSL https://raw.githubusercontent.com/Jay-Huang-0130/Agent-OS/main/bootstrap.sh | bash
unset AGENT_OS_AGENT_WEB_PASSWORD_FILE
rm -f "$HOME/agent-web-password"
```

密碼至少 4 字元，但 4 字元只適合完全可信任的私人內網。

## 管理指令

```bash
agent-osctl doctor
agent-osctl browser info
agent-osctl browser status
agent-osctl browser url
agent-osctl browser update
agent-osctl browser password
```

目前 `agent-osctl` 只管理 foundation 與瀏覽器元件；Goal Engine、Agent Runtime、Device Mesh 等仍是後續階段，不會在文件中假裝已經完成。

## 目前人類操作與未來 Agent 操作

目前已完成：

```text
人類瀏覽器 -> HTTPS/noVNC -> Agent Web Chromium
```

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
~/.local/share/agent-os/source              Agent-OS 原始碼
~/.local/state/agent-os/components          元件驗證狀態
~/.local/share/agent-web/source             Agent Web 原始碼
/var/lib/agent-web                          Chromium Profile 與下載
/etc/agent-web                              Agent Web 驗證與設定
```

Agent-OS 不會複製 Agent Web 原始碼到自己的倉庫，也不會建立第二份 Chromium Profile。

## 開發與驗證

```bash
git clone https://github.com/Jay-Huang-0130/Agent-OS.git
cd Agent-OS
./validate.sh
./install.sh
```

略過瀏覽器元件或強制更新：

```bash
./install.sh --skip-agent-web
./install.sh --force-agent-web-update
```

## 文件

- [VISION.md](VISION.md)：Agent-OS 的完整產品願景。
- [Agent Web 整合設計](docs/AGENT-WEB-INTEGRATION.md)：元件生命週期、能力探測、自動安裝、安全與未來 Adapter。

## 專案狀態

目前版本建立的是可以實際執行的安裝與能力管理 foundation，不代表完整 Agent-OS 已完成。後續建議依序實作：

1. Agent Web protected Adapter。
2. Capability Registry。
3. Device identity 與 Personal Device Mesh。
4. Persistent Goal Engine。
5. Approval、Audit 與 Human Takeover。
6. Agent Runtime 與模型抽象層。
