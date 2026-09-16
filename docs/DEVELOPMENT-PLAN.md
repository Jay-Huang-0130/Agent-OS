# Agent-OS 開發計劃表

更新日期：2026-09-16

計劃來源：[完整 Phase 規格](PHASE.md)與 [Responsibility Kernel](RESPONSIBILITY-KERNEL.md)

## 狀態標示

- `[x]`＋刪除線：已完成並通過驗證。
- `[ ]`：尚未完成。
- 每個 Phase 必須完成測試、文件與故障情境驗證後，才能劃掉。

## Phase 0–13

- [x] ~~**Phase 0：可重現的執行基礎**~~
  - ~~固定 Node.js 版本、平台與 SHA-256。~~
  - ~~支援 Raspberry Pi OS／Debian／Ubuntu 64-bit ARM64 與 x64。~~
  - ~~程式、狀態、設定與 Runtime 分離保存。~~

- [x] ~~**Phase 1：安裝、服務與更新生命週期**~~
  - ~~一條指令完成安裝。~~
  - ~~systemd user service、linger、health check。~~
  - ~~版本化 release、原子切換、更新失敗自動 rollback。~~

- [x] ~~**Phase 2：安全 Web 管理基礎**~~
  - ~~Fastify Gateway、React Web UI、HTTPS 與 WebSocket。~~
  - ~~首次配對、管理員登入、Session、CSRF、同源檢查與登入限流。~~
  - ~~SQLite、系統狀態、Activity、Settings 與 ChatGPT device-code OAuth。~~
  - 詳細驗收：[Phase 0–2](PHASE-0-2.md)

- [x] ~~**Phase 3：Durable Responsibility Store**~~
  - ~~Project、Goal、Plan、Task、Run、Wake、Event、Lease、Outbox。~~
  - ~~Goal／Task 狀態機、idempotency、append-only ledger。~~
  - ~~服務重啟後 reconciliation，責任不遺失。~~
  - 詳細驗收：[Phase 3](PHASE-3.md)

- [x] ~~**Phase 4：Secretary Portfolio MVP**~~
  - ~~Today、Waiting on You、Waiting on Others、Upcoming。~~
  - ~~Commitment Ledger、Approval、Project／Goal Detail。~~
  - ~~單一自然語言聊天入口，不要求使用者先分類。~~
  - 詳細驗收：[Phase 4](PHASE-4.md)

- [x] ~~**Phase 5：Wake Engine 與 0-Token Automation**~~
  - ~~Durable scheduling、misfire、retry、notification 與 usage ledger。~~
  - ~~AI 判斷簡單任務後才建立受控 Python JSON Capability。~~
  - ~~Production code 不硬編碼天氣、公車、地圖等領域流程。~~
  - 詳細驗收：[Phase 5](PHASE-5.md)

- [x] ~~**Phase 6：Model Runtime、Goal Compiler 與 Bounded Agent**~~
  - ~~Codex structured runtime、模型選擇、串流回覆與執行紀錄。~~
  - ~~Request Router、Goal Contract、Plan IR、Task Packet。~~
  - ~~背景 Worker、Result Envelope、Evidence 與 verifier。~~
  - ~~缺少真實工具時阻擋，不允許 AI 假裝使用工具。~~
  - 詳細驗收：[Phase 6](PHASE-6.md)

- [x] ~~**Phase 7：Watcher 與 Hybrid Long-term Goal**~~
  - ~~公開 HTTP/HTTPS Fetch、Normalize、Fingerprint、Delta、Checkpoint。~~
  - ~~無變更時 0 model calls／0 notifications。~~
  - ~~有變更才進行有限語意分析與通知。~~
  - ~~跨重啟恢復、失敗退避、Token Budget、期限到才完成 Goal。~~
  - 詳細驗收：[Phase 7](PHASE-7.md)

- [ ] **Phase 8：Agent-Web Browser Authentication Gate**
  - [ ] 建立可替換的 Browser Adapter：navigate、snapshot、act、download。
  - [ ] 建立 Tool Registry，讓 `web.open`、`web.click`、`web.find` 對應真實工具，而非只有名稱。
  - [ ] Browser Session／Profile opaque reference、Task checkpoint 與 Agent lease。
  - [ ] 登入、MFA、CAPTCHA 時進入 `WAITING_AUTH`。
  - [ ] 建立短效 User Takeover，確保人與 Agent 不會同時控制瀏覽器。
  - [ ] 使用者完成登入後，以 `AUTH_COMPLETED` Wake 恢復原 Task。
  - [ ] 缺少 Browser capability 時顯示 `BLOCKED`，停用無效的「恢復 Goal」。
  - [ ] Timeline 將內部 transition 轉成可讀的執行紀錄。

- [ ] **Phase 9：Attention、Agenda 與 Briefing**
  - [ ] Calendar event 與 availability 資料模型。
  - [ ] Agenda Builder、Deadline conflict detector、Urgent Alert。
  - [ ] Decision Queue、Daily Brief、Weekly Review。
  - [ ] Quiet hours、digest、通知去重與停滯偵測。
  - [ ] 沒有重要變化時不產生空 Brief。

- [ ] **Phase 10：File Broker 與完整 Generated Capability Lifecycle**
  - [ ] Workspace grant、read-only／read-write 與路徑安全。
  - [ ] Hash、patch、diff、atomic write、backup、rollback。
  - [ ] Sandbox 的 CPU、RAM、時間、網路與 mount policy。
  - [ ] Capability 搜尋、規格、生成、測試、批准、版本、健康檢查與 rollback。
  - [ ] 未知程式不得直接在 Host 執行。

- [ ] **Phase 11：Project Memory、Experience 與 Skill**
  - [ ] Project Capsule、Project Card、Decision 與 Artifact projection。
  - [ ] L0–L3 分層檢索，不載入不相關的完整歷史。
  - [ ] 只有已驗證且可追溯的內容能提升為 Person Memory。
  - [ ] 重複方法可形成帶 permissions、tests、version 的 Skill Candidate。
  - [ ] Project 刪除後重評估衍生 Memory 與 Skill。

- [ ] **Phase 12：Controlled Self-Improvement**
  - [ ] 收集 Outcome、Failure、Token、Latency 與 Tool-call 指標。
  - [ ] Pattern Miner 與 Improvement Proposal。
  - [ ] Offline replay、固定 regression dataset、Shadow／Canary。
  - [ ] 人工 Promote／Reject／Rollback。
  - [ ] 禁止自行修改 Kernel invariants、權限與 Goal Contract。

- [ ] **Phase 13：Device Mesh**
  - [ ] Device identity、pairing 與 mTLS。
  - [ ] Heartbeat、capability report 與 offline detection。
  - [ ] 跨裝置 Task lease 與 device selection。
  - [ ] Desktop／Laptop node 與 Phone notification bridge。
  - [ ] 裝置離線或 lease 過期不造成重複副作用。

## 主要里程碑

- [x] ~~**Kernel MVP（Phase 5）**：責任、Portfolio、Commitment、排程與跨重啟恢復。~~
- [ ] **Agent MVP（Phase 8）**：自然語言 Goal、長期 Watcher、真實 Browser Tool、登入接管與恢復。
- [ ] **Secretary MVP（Phase 9）**：跨 Project 排序、注意力管理、Daily Brief 與 Weekly Review。
- [ ] **Safe Capability Platform（Phase 10）**：安全檔案操作與完整 Capability lifecycle。
- [ ] **Learning Agent-OS（Phase 12）**：可量測、可回滾、需人工批准的改善流程。
- [ ] **Personal Device Mesh（Phase 13）**：安全使用個人裝置能力。

## 現在的下一步

目前只開始 **Phase 8**。完成標準是：

1. Agent 能以真實 Browser Adapter 執行公開網頁任務。
2. 遇到登入、MFA 或 CAPTCHA 時安全停止，不把秘密交給模型。
3. 使用者接管完成後，原 Task 從 checkpoint 繼續。
4. 缺少工具時 Goal 保持 `BLOCKED`，工具可用後才允許恢復。
5. Browser、Gateway 或 Agent 重啟後，Session reference 與責任狀態仍可恢復。
