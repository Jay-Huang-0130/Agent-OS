# Agent-OS Responsibility & Secretary Kernel

> 精簡架構草案 v0.2｜2026-09-01

## 1. 產品承諾

Agent-OS 不是聊天機器人，也不是把所有輸入都交給 ReAct Agent。

它是一個私人秘書作業系統：

> **把自然語言委託轉成可持續執行的責任，使用最低成本的有效方法完成，並在完成或使用者終止前持續持有責任。**

~~~text
Delegation
→ Define responsibility and desired outcome
→ Coordinate priorities and commitments
→ Compile an executable plan
→ Execute / wait / observe / replan
→ Verify
→ Continue until completed or explicitly cancelled
~~~

產品成功指標不是回答了多少問題，而是：

~~~text
verified_outcomes
tokens_per_verified_outcome
missed_commitments
user_attention_required
recovery_success_rate
~~~

## 2. 不可妥協的規則

1. Goal 是責任的唯一真實狀態；Conversation、Cron、Queue、Browser Session 和 Agent Run 都不能取代 Goal。
2. 使用者收到 `goal.accepted` 前，Goal、初始狀態和第一個 Wake Condition 必須已持久化。
3. 斷網、崩潰、重啟、斷電、工具失敗和預算耗盡都不能讓 Goal 消失。
4. Goal 只有兩種終態：經驗證的 `COMPLETED`，或使用者明確要求的 `CANCELLED`。
5. `BLOCKED`、`WAITING_AUTH` 和 `NEEDS_APPROVAL` 都是等待狀態，不是失敗終態。
6. LLM 只能提出 Proposal；只有 Kernel 能驗證並 Commit 狀態。
7. 能由 Cache、規則、API、程式或既有 Capability 完成的工作，不呼叫模型。
8. 每個 Run 結束前必須 Complete、Checkpoint、Wait、Block 或建立下一個 Wake。
9. Task 完成不等於 Plan 完成；Plan 完成不一定等於 Goal 完成。
10. 所有外部副作用都要有 Policy、Idempotency、Evidence 和 Audit。
11. 模型 Context 由 Kernel 組裝，不能依賴模型自己記住過去。
12. 登入帳號不等於批准付款、發文、投遞、刪除或傳訊息。

## 3. 整體架構

~~~text
Web UI / Client
委託、Today、Waiting on You、Projects、Approvals、Results
                          │
                          ▼
Secretary Layer
Intake / Portfolio / Commitments / Calendar / Briefings / Autonomy
                          │
                          ▼
Responsibility Kernel
Goal Compiler / Plan Store / Wake Engine / Policy / Budget / Memory
Decision Gate / Orchestrator / Verifier / Supervisor
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
Agent Runtimes       Capabilities       Human Gates
OpenAI / Codex       API / Program      Approval
Claude / Local       Search / MCP       Authentication
Custom ReAct         Agent-Web          Clarification
~~~

穩定的是 Responsibility 與 Secretary 語意；模型、Agent framework、Browser 和工具都透過 Adapter 替換。

## 4. 使用者輸入與執行模式

### 4.1 處理流程

~~~text
User Input
→ Intake: identity, timezone, attachments, conversation context
→ Router: question, action, automation, watcher, durable goal
→ Goal Compiler: contract, plan, budget, risk, autonomy
→ Validator
→ Persist and acknowledge
→ Execute now or create Wake Condition
~~~

缺少資訊時：

- 安全、可逆：記錄 assumption，繼續。
- 會影響 Outcome 但可之後調整：使用合理預設，批次詢問。
- 高風險、不可逆或無法執行：立即澄清或要求批准。

### 4.2 執行模式

| 模式 | 適用情況 |
|---|---|
| `DIRECT_RESPONSE` | 簡單問答，不建立長期責任 |
| `SINGLE_ACTION` | 一次工具操作 |
| `DETERMINISTIC_AUTOMATION` | 固定 API、程式、模板與排程 |
| `CHANGE_WATCHER` | 只有資料改變才通知 |
| `BOUNDED_AGENT` | 一次有限 ReAct 任務 |
| `HYBRID_GOAL` | 程式長期蒐集，AI 處理語意和策略 |
| `MULTI_TASK_PLAN` | 可獨立拆分並平行驗收的複雜工作 |

多 Agent 不是預設。簡單工作不應為了架構形式而拆分。

## 5. Secretary Layer

Responsibility Kernel 確保單一責任能完成；Secretary Layer 負責使用者所有責任之間的秩序。

### 5.1 Responsibility Portfolio

Portfolio 保存所有 Active Goals，負責：

- 優先順序與截止時間。
- 跨 Project 衝突與依賴。
- Token、Worker、裝置和使用者注意力分配。
- 長期沒有進展、快逾期或等待過久的責任。
- 今天要處理什麼、什麼可以延後。

建議 Priority 欄位：

~~~yaml
priority:
  userRank: 1
  urgency: high
  impact: high
  deadline: 2026-09-05T18:00:00+08:00
  dependencyCount: 2
  riskOfDelay: medium
~~~

Portfolio 可以建議調整順序，但不能偷偷修改使用者的 Goal、Deadline 或 Autonomy。

### 5.2 Commitment Ledger

秘書不只管理 Task，也要記住誰答應了什麼。

~~~yaml
commitmentId: commitment_123
owner: USER | AGENT_OS | EXTERNAL_PARTY
owedTo: USER | EXTERNAL_PARTY
promise: 星期五前完成履歷
dueAt: timestamp
status: OPEN | WAITING | FULFILLED | BROKEN | CANCELLED
goalId: goal_123
followUpPolicy: remind_24h_before
evidenceRefs: []
~~~

Commitment 可由 Goal、對話、郵件或網站事件產生，但 LLM 擷取的承諾必須讓 Kernel 驗證；高影響承諾需要使用者確認。

### 5.3 Calendar、Agenda 與 Wake

三者職責不同：

~~~text
Calendar   使用者的事件與可用時間
Agenda     今天應關注和完成的事情
Wake       系統何時恢復某個 Task
~~~

Secretary 需處理撞期、截止日前準備時間、安靜時段和時區；Wake Engine 處理 timer、event、webhook、approval、authentication、network recovery 等機器事件。

### 5.4 Attention 與 Briefing

回報分四級：

| 類型 | 用途 |
|---|---|
| Urgent Alert | 不立即處理會失去機會或產生風險 |
| Decision Queue | 等待批准、登入、澄清或選擇 |
| Daily Brief | 今日行程、截止事項、重要更新、等待項目 |
| Weekly Review | 成果、無進展責任、下週優先事項 |

沒有變化、正常檢查和可自動恢復的錯誤應保持安靜。多個低優先通知應合併，不逐條打擾使用者。

建議首頁：

~~~text
Today
Waiting on You
Waiting on Others
Upcoming
Active Projects
Needs Decision
Recently Completed
~~~

### 5.5 Autonomy Contract

每個 Goal 都要明確定義 Agent 能做到哪一層：

| 等級 | 權限 |
|---|---|
| `OBSERVE` | 只觀察與回報 |
| `PREPARE` | 可整理資料和準備草稿 |
| `ASK_BEFORE_ACT` | 外部副作用前必須批准 |
| `ACT_WITHIN_POLICY` | 在明確範圍內可自動執行 |
| `FULLY_AUTOMATED` | 低風險確定性工作完全自動化 |

登入、讀取權限和 Action Approval 分開管理。使用者可隨時降低 Autonomy、暫停或取消 Goal。

## 6. Goal Contract 與 Project

### 6.1 Goal Contract

Goal 必須區分使用者想要的最終結果，和 Agent-OS 能承諾的工作。

~~~yaml
goalId: goal_find_internship
title: 持續尋找軟體實習
desiredOutcome: 使用者進入符合條件的公司
agentCommitment:
  - 每日搜尋、去重和篩選
  - 高匹配職缺及時通知
  - 準備申請資料並追蹤結果
completionCriteria:
  - 使用者確認已入職
cancellationCriteria:
  - 使用者明確取消或表示不再尋找
serviceCriteria:
  checkFrequency: daily
  noDuplicateNotification: true
externalDependencies:
  - 公司是否錄取
constraints:
  location: 台北或遠端
autonomy: PREPARE
attentionPolicy:
  notifyWhen: [高匹配, 快截止, 需要決定]
  stayQuietWhen: [沒有新資料, 正常檢查]
budget:
  dailyTokens: configurable
~~~

### 6.2 Project Capsule

Project 是相關 Goal、資料和產物的隔離工作空間；不是責任本身。

~~~text
Person
├── Profile
├── Experience Index
├── Skill Library
└── Projects
    └── Project Capsule
        ├── Manifest and Project Card
        ├── Goals / Plans / Tasks / Checkpoints
        ├── Decisions / Events
        ├── Artifacts / Evidence
        ├── Project Memory
        └── Skill Candidates
~~~

執行期間不把所有內容塞進單一大檔案。完成後可匯出成單一 `.agentproject` 封裝。

## 7. Responsibility Plan

Plan 是可持久化、版本化的中介表示，而不是一段自由文字。

### 7.1 Node 類型

~~~text
AGENT             語意理解或策略
REACT             有限 Context、工具、時間和 Token 的 Agent Run
DETERMINISTIC     固定程式、規則或轉換
TOOL              已註冊 Capability
WATCHER           監控變化
BROWSER           Agent-Web Chrome 操作
WAIT_TIME         等時間
WAIT_EVENT        等 webhook、網路、資料或裝置
WAIT_USER         等澄清
AUTH_GATE         等登入、MFA、Passkey 或 CAPTCHA
APPROVAL_GATE     等外部動作批准
VERIFY            驗證 Task、Plan 或 Goal
NOTIFY            依 Attention Policy 通知
COMPLETE          提出完成，仍需 Verifier
~~~

Plan 優先使用 DAG。只有子任務能獨立執行、有清楚輸入輸出且合併成本合理時才平行化。

### 7.2 Manager、Worker、Verifier

~~~text
Project Manager
→ 建立 Task DAG、依賴、Acceptance Criteria 和 Budget

Worker
→ 接收最小 Task Packet
→ 執行 bounded ReAct 或 deterministic work
→ 回傳 Result Envelope、Evidence、Usage 和 Next Suggestion

Verifier
→ 驗證 Task
→ 合併後驗證 Plan
→ 對照 Goal Contract 驗證 Outcome
~~~

Manager 只讀 Result Envelope 和必要 Evidence，不重讀完整 Worker Transcript。

## 8. Wake、持久化與復原

Cron 只是 Wake Trigger，不是 Goal。

~~~text
TIME / INTERVAL / EVENT / WEBHOOK / USER / APPROVAL
AUTH_COMPLETED / NETWORK_RECOVERED / DEADLINE_NEAR
~~~

### 8.1 Durable Execution

樹莓派第一版建議使用 SQLite WAL 作權威狀態，檔案系統保存大型 Artifact。

~~~text
Persist Intent
→ Commit State Transition
→ Publish Wake through transactional Outbox
→ Worker acquires Lease
→ Execute with Idempotency Key
→ Persist Result and Next Wake
→ Acknowledge
~~~

啟動時執行 Reconciliation：掃描過期 Lease、到期 Wake、未完成 Run、所有非終態 Goal 和待送 Outbox，重建遺失事件。

### 8.2 Misfire Policy

| Policy | 行為 |
|---|---|
| `RUN_ONCE_NOW` | 立即補跑一次 |
| `RUN_LATEST_ONLY` | 只處理最新有效資料 |
| `RUN_ALL` | 全部補跑，適合不可漏事件 |
| `SKIP_AND_RESUME` | 略過過期 occurrence |
| `REPLAN` | 交由策略層判斷 |

略過一次 Occurrence 不等於取消 Goal。

## 9. Agent-Web 與登入等待

Agent-Web 是 Browser Runtime；Agent-OS 保存 Goal、Checkpoint 和等待狀態。

~~~text
Agent 操作網站
→ 發現 Login / MFA / CAPTCHA
→ Persist Browser Checkpoint
→ Create Authentication Challenge
→ Release Worker and model context
→ WAITING_AUTH
→ User takes exclusive control through short-lived link
→ User finishes authentication
→ Deterministic Auth Probe
→ Return control to Agent
→ Resume original Task
~~~

規則：

- 等待期間不佔 Worker、不保留模型 Run、不輪詢 LLM。
- User Control 期間 Agent 停止 click、type、navigate 和 screenshot。
- 接管 token 短效、一次性、綁定 user、origin、profile 和 task。
- 使用者直接在 Chrome 輸入密碼；密碼、Cookie、MFA 和 Session Token 不進 LLM、Memory、Transcript 或 Project Archive。
- Agent-OS 只保存 opaque `profileId`；Browser Profile 按使用者隔離。
- 使用者關閉 Browser 或 Challenge 過期不等於取消 Goal。
- 登入完成只恢復存取；高風險動作仍需 `APPROVAL_GATE`。

Capability 順序：API / Webhook → HTTP / Feed → Search → Browser automation → User takeover。

## 10. Memory、資料與 Skill

### 10.1 儲存分層

~~~text
SQLite                         Goal、Task、Wake、Event、Memory metadata
Filesystem Artifact Store     報告、資料集、程式、圖片、Evidence
Encrypted Secret Store        API credential handles
Agent-Web Profile Store       Cookie 和 Browser Session
~~~

Secret 和 Cookie 與一般 Memory 完全分離。

### 10.2 Memory Scope

~~~text
Person Memory    已確認且跨專案穩定的事實、偏好和限制
Project Memory   此專案的背景、決策、教訓和狀態
Experience       使用者或系統以前做過什麼，指向 Project
Skill            經測試、可重複使用的方法
Artifact         大型內容和 Evidence
Event Ledger     完整可稽核事件
~~~

Memory Item 至少保存 scope、type、source、confidence、sensitivity、validity、provenance 和 supersedes。模型推測不能直接提升為 Person Fact。

### 10.3 完成後彙整

~~~text
Verify Project Outcomes
→ Freeze important Evidence
→ Generate compact Project Card
→ Extract Memory Candidates
→ Project-only detail stays in Project
→ Stable confirmed preference proposes Person Memory
→ Past work becomes Experience + project_ref
→ Repeatable procedure becomes Skill Candidate
→ Archive Project Capsule
~~~

Experience 不等於 Skill。Skill Candidate 必須去除專案敏感資料，定義 input、output、permissions、tests 和 acceptance criteria，通過歷史案例才成為 Verified Skill。

### 10.4 按需取回

~~~text
L0 Person constraints and relevant Skill names
L1 compact Project Cards
L2 relevant decisions, lessons and Goal state
L3 exact Artifact fragments and Evidence
L4 raw Event history only for audit or recovery
~~~

先用 owner、status、tag、time、capability 和 outcome 做結構化篩選，再用語意排序。通常停在 L0 或 L1。

刪除 Project 時沿 provenance 移除 Experience、重新評估衍生 Memory 和 Skill；使用者能查看來源、更正、限制跨專案使用或要求遺忘。

## 11. Token 與成本

核心原則：`Compile Once, Execute Many`。

~~~text
第一次
Request → Goal Contract → Plan → Capability / Rules / Templates

後續
Wake → Load compiled plan → Deterministic execution
     → Call model only for semantic delta, exception or strategy
~~~

成本階梯：

~~~text
L0 Cache / Fingerprint / Rule / Program               0 tokens
L1 Template / Schema / Threshold                      0 tokens
L2 Small model: classify / extract                    low
L3 Standard model: bounded ReAct                      medium
L4 Strong model: plan / conflict / strategy           high
L5 Human: irreversible or preference-dependent choice
~~~

節省規則：

- No-change 不呼叫模型，只傳 Delta。
- Worker 只拿最小 Task Context；Manager 只讀 Result Envelope。
- 先規則過濾，再批次送模型，不逐筆呼叫。
- 穩定 Prompt 前綴可使用 Provider caching，但必須量測實際成本。
- 規則驗證優先；模型驗證依風險抽樣或升級。
- 多 Agent 只降低 wall-clock，不天然節省 Token。
- Budget 耗盡時依序縮小 Context、Batch、降級模型、延後非緊急工作或請示；Goal 留在 WAITING。

## 12. Verification、安全與權限

驗證層級：

~~~text
Deterministic data     Schema / checksum / assertion
Low-risk semantics     small model or sampling
Important outcome      independent strong verifier
External side effect   Policy + Human Approval + Evidence
~~~

副作用流程：

~~~text
Record Intent
→ Check Idempotency
→ Permission and Approval
→ Execute
→ Record Evidence
→ Verify
~~~

Generated Capability 必須經過 Spec、Sandbox、Tests、Policy、Version、Health Check 和 Rollback。模型不能自行修改 Kernel invariants、權限邊界、Audit、Goal Contract 或 Completion Criteria。

## 13. 受控自主進步

自主進步是可量測、版本化、可回滾的能力演化，不是讓 Agent 無限制修改正式系統。

~~~text
Production Traces
→ Find repeated success or failure patterns
→ Improvement Proposal
→ Offline replay and regression eval
→ Shadow mode
→ Low-risk canary
→ Promote or roll back
~~~

優先改善：Routing rule、Prompt、Context policy、Model tier、Plan Template、Retry/Batch/Cache，以及 deterministic Capability。

最有價值的學習：

~~~text
Unknown task → strong model and ReAct
Repeated success → reusable Plan
Stable pattern → routing rule or small model
Deterministic steps → tested Capability
Mature occurrence → 0 model calls unless exception
~~~

第一版只做：

- Level 0：收集 Outcome、Trace、Token、Latency 和 Failure。
- Level 1：產生 Improvement Proposal，由人審核。

有可靠 Eval Dataset、Shadow 和 Rollback 後，才開放低風險自動升級。Candidate 不可用自己的輸出當唯一 Grader；固定保留 regression holdout。

## 14. 現有框架的角色

| 框架 | 借用 | 不交給它 |
|---|---|---|
| OpenAI Agents SDK | Agent Run、handoff、guardrail、trace、eval | Goal ownership 和跨排程責任 |
| LangGraph | Graph、checkpoint、interrupt、HITL | 產品 Outcome 與 Portfolio |
| Temporal | Durable timer、retry、crash recovery | 語意規劃和 Memory truth |
| Microsoft Agent Framework | Typed executor、多 Agent pattern、checkpoint | Kernel 資料模型 |
| CrewAI | Role、Flow、hierarchical process | 所有任務預設多 Agent |
| OpenClaw | Gateway、channel、cron、heartbeat、本地體驗 | Cron/Session 取代 Durable Goal |
| Letta | Persistent memory blocks | 未驗證 Memory 當事實 |
| DSPy / Prompt Optimizer | Metric-driven optimization | 未經 Eval 自動上線 |

Adapter 邊界：Model Runtime、Agent Runtime、Durable Execution、Browser Runtime、Capability、Trigger、Notification、Memory Store、Evaluator。

## 15. 代表案例

| 案例 | 日常路徑 | 模型使用 |
|---|---|---|
| 每日 09:00 天氣 | Wake → Weather API → Schema → Template → Notify | 建立時使用，平時 0 |
| 漫畫更新 | Fetch → Parse → Fingerprint → No change stop | 有變化且需語意時 |
| 七天市場報告 | 程式每日蒐集，事件壓縮，第七天彙整 | 最終分析或重大事件 |
| 找實習直到入職 | API/Browser 蒐集、規則去重、批次語意排名 | 新職缺、策略失效、履歷判斷 |
| 登入網站 | Agent-Web → AUTH_GATE → User takeover → Auth Probe → Resume | 等待期間 0 |

## 16. 狀態模型

### Goal

~~~text
INBOX → CLARIFYING → PLANNING → ACTIVE
ACTIVE ↔ WAITING / WAITING_AUTH / NEEDS_APPROVAL / RETRYING / BLOCKED
ACTIVE → COMPLETED
ANY NON-TERMINAL → CANCELLED by explicit user instruction
~~~

### Task

~~~text
PENDING → READY → LEASED → RUNNING
RUNNING → WAITING / WAITING_AUTH / VERIFYING / COMPLETED / FAILED
FAILED → RETRY / REPLAN / BLOCK; it does not terminate the Goal
~~~

## 17. MVP 驗證範圍

第一版先證明七件事：

1. `DIRECT_RESPONSE`：簡單問答不建立不必要的多 Agent Plan。
2. `DETERMINISTIC_AUTOMATION`：每日天氣，正常執行 0 model calls。
3. `CHANGE_WATCHER`：漫畫沒有更新時 0 model calls。
4. `HYBRID_GOAL`：市場或實習由程式蒐集、AI 分析。
5. `BROWSER_AUTH_GATE`：Agent-Web 等使用者登入後恢復原 Task。
6. `DURABLE_RECOVERY`：斷網、程序崩潰和斷電後 Goal 不遺失、不重複副作用。
7. `SECRETARY_PORTFOLIO`：跨 Goal 排序、Commitment、Decision Queue 和 Daily Brief。

MVP 不需要先做 Device Mesh、全自動自我修改或所有框架 Adapter。

## 18. 實作前待決策

1. Request Router 第一版採規則、小模型或混合信心門檻？
2. Goal、Project、Commitment、Plan 和 Memory 的正式 Schema 與 migration 規則？
3. Portfolio 的優先順序公式，以及使用者如何覆寫？
4. Calendar 和 Commitment 如何從對話擷取並確認？
5. Daily Brief、Urgent Alert 和提醒的預設頻率？
6. 各 Autonomy 等級允許哪些 Tool 和副作用？
7. Generated Capability 的 Sandbox、測試和批准門檻？
8. SQLite、Artifact、Secret 和 Agent-Web Profile 的加密、備份與刪除政策？
9. 第一版支援哪些 Site Adapter 與 Auth Probe？
10. Verification 何時使用規則、小模型、強模型或人工？
11. Token Budget 超標時各優先級 Goal 的降級政策？
12. Improvement Proposal、Eval Dataset、Canary 和 Rollback 的門檻？

## 19. 核心總結

~~~text
Secretary Layer
管理所有責任、承諾、時間、優先順序與使用者注意力

Responsibility Kernel
把每個委託變成不會因斷線、關機或模型結束而消失的 Durable Goal

Execution Layer
讓 API、程式、Browser 和 Agent 各自只處理最適合的部分

Memory and Skills
把完成的 Project 保存成 Experience，把驗證過的方法沉澱成 Skill

Controlled Improvement
讓系統越做越可靠、越省 Token，但永遠受 Eval、權限、版本和回滾控制
~~~

> **Agent-OS 的差異化不是能定時呼叫 AI，而是能像可信任的秘書一樣管理使用者的責任，安靜地完成可自動化的工作，在正確時間要求人的注意，並持續追蹤到 Outcome 成立。**
