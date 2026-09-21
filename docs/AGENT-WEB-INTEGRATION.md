# Agent-OS × Agent Web 整合設計

## 用意

Agent-OS 的核心是接受委託並完成結果。很多真實任務需要瀏覽器，而且需要的不只是一次性 headless session，而是能長期登入、保存 Cookie、等待網站事件、讓使用者完成 MFA，並在 Agent 失敗時人工接管的瀏覽器環境。

Agent Web 提供這個基礎設施；Agent-OS 提供上層的目標、能力選擇、權限、審批和生命週期協調。

```text
Agent-OS owns                         Agent Web owns
-------------------------------      -------------------------------
Why an action is needed               Chromium process
Which goal it belongs to              Persistent profile
Whether approval is required          Cookies and website sessions
Which device should execute it        noVNC human interface
Retry / wait / resume policy          Browser service lifecycle
Audit and user-facing result          Future browser control adapter
```

## 為什麼不直接把 Agent Web 複製進 Agent-OS

兩個專案維持獨立可以：

- 單獨修復或更新瀏覽器層。
- 讓其他 Agent 重用 Agent Web。
- 避免 Agent-OS 倉庫包含重複 Chromium 部署程式。
- 清楚區分「瀏覽器基礎設施」與「Agent 決策系統」。
- 保留未來替換 Browser Provider 的可能性。

Agent-OS 安裝器只保存 Agent Web 的 repository、bootstrap URL、能力版本及驗證狀態。

## 自動安裝流程

```text
Agent-OS bootstrap
    │
    ├─ command -v agent-webctl
    │      └─ existing install: include Agent Web compatibility update
    │
    ├─ agent-webctl info
    │      └─ READY=true ? reuse : install/repair
    │
    ├─ Agent Web bootstrap --non-interactive
    │      ├─ existing install: keep current credentials
    │      └─ new install: password file or generated password
    │
    ├─ agent-webctl info
    │      └─ require READY=true
    │
    └─ record non-secret component state
```

狀態記錄位於：

```text
~/.local/state/agent-os/components/agent-web.env
```

只包含 commit、能力版本與驗證時間，不包含密碼、Cookie、Token 或私鑰。

## 非互動密碼處理

Agent Web 接受：

```bash
./install.sh \
  --non-interactive \
  --username browser \
  --password-file /private/path/password
```

Agent-OS 使用 `AGENT_OS_AGENT_WEB_PASSWORD_FILE` 指定密碼檔。若新安裝時沒有提供，安裝器會：

1. 以 `openssl rand` 產生 16 字元隨機密碼。
2. 寫入權限 `0600` 的暫存檔。
3. 把檔案路徑交給 Agent Web。
4. 成功後刪除暫存檔。
5. 在終端顯示帳密一次。

明文密碼不會成為命令列參數，也不會寫入 Agent-OS component state。

## 能力發現契約

Agent-OS 不以程序名稱猜測服務能力，而是執行：

```bash
agent-webctl info
```

必要欄位：

```text
AGENT_WEB_INFO_VERSION=1
INSTALLED=true
READY=true
HUMAN_CONTROL_PROTOCOL=novnc
AGENT_CONTROL_AVAILABLE=false
AGENT_CONTROL_PROTOCOL=none
```

解析規則：

- 只解析已知 Key。
- 忽略未來新增的 Key。
- `READY=true` 才能把 Browser capability 標記為健康。
- `AGENT_CONTROL_AVAILABLE=false` 時，Agent Runtime 不得假裝能自動操作。
- OpenAI 登入不依賴 Agent Web；Agent-OS 使用 device-code 流程，讓使用者在操作 Web UI 的瀏覽器完成授權。
- noVNC URL 是人類介面，不是 Agent Token 或機器控制 API。

## 安裝冪等性

重複執行 Agent-OS bootstrap 時：

- Agent-OS source 使用 fast-forward 更新。
- Agent Web 已健康時不重新安裝。
- Agent Web Profile、Cookie、下載及網頁密碼保持不變。
- `--force-agent-web-update` 才強制執行 Agent Web bootstrap。
- 安裝後重新檢查 `READY=true` 與 Phase 8 adapter protocol。

## 失敗策略

Agent Web 是選用元件。普通 bootstrap 更新若偵測到既有 Agent Web，會嘗試升級與驗證；失敗時保留警告並繼續啟用 Agent-OS 核心，Browser Task 安全保持 `BLOCKED`。只有明確使用 `--with-agent-web` 或 `--force-agent-web-update` 的嚴格模式，以下狀況才會讓整體安裝失敗並停止：

- bootstrap 下載失敗。
- Agent Web 安裝器退出非零。
- `agent-webctl info` 不存在或格式無法讀取。
- 最終 `READY` 不是 `true`。

不應在 Browser capability 未就緒時繼續宣稱 Agent-OS 安裝成功。

## 安全邊界

- Agent Web noVNC 只供可信任內網人類操作。
- 4 字元密碼雖被允許，但自動安裝預設產生 16 字元隨機密碼。
- Agent-OS 不讀取 Chromium Profile 或 Cookie。
- Agent-OS 不使用 noVNC 密碼作為 Agent 控制憑證。
- 未來 CDP 只允許 loopback 或 Unix socket，不得監聽 `0.0.0.0`。
- 遠端裝置透過認證 node／Relay 加入，不直接公開原始 CDP。

## Agent Adapter（Phase 8）

Phase 8 已新增獨立 Browser Adapter：

```text
Agent Runtime
    │ authenticated Unix socket
    ▼
Agent Web Adapter
    │ loopback CDP
    ▼
existing Chromium + existing profile
```

最小介面：

```text
health
capabilities
tabs.list/open/focus/close
page.snapshot
page.navigate
page.act
page.screenshot
downloads.list/wait
session.acquire/release/pause
```

Agent-OS 使用操作租約避免人類與 Agent 同時改變畫面。付款、發信、刪除、發布、帳號設定等外部效果操作必須支援人工批准與審計。

相容的 Agent-Web 安裝必須讓 `agent-webctl info` 回報：

```text
AGENT_CONTROL_AVAILABLE=true
AGENT_CONTROL_PROTOCOL=agent-web-adapter-v1
```

Gateway 只有在上述 capability 與 protocol 都成立時才註冊 `web.*` 工具；舊版 Agent-Web 仍只提供人類操作，Browser Task 會安全保持 `BLOCKED`。
