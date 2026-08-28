# Agent-OS — Vision

> **Give it an outcome. It figures out the rest.**  
> 你只需要告訴它你想要的結果，剩下的由它自己想辦法。

---

## 1. 我們真正想做的是什麼？

Agent-OS 不只是另一個 AI Chatbot，也不只是另一個 Agent Framework。

我們想做的是：

> **把過去只有大公司老闆、高階主管或有錢人才能擁有的「全能私人助理」，普及給每一個人。**

真正好的私人助理，不會要求使用者一步一步告訴他怎麼做。

使用者只需要說：

> 「這件事情交給你。」

然後助理自己理解目標、找方法、處理途中發生的問題、持續追蹤，直到事情真正完成。

因此 Agent-OS 的核心不是「回答問題」，而是：

> **接受委託，對結果負責。**

---

# 2. North Star

Agent-OS 最重要的產品願景：

> **Build a personal AI you can actually delegate your life to.**

中文：

> **打造一個你真的敢把事情交給它處理的私人 AI。**

不是：

- 問它問題
- 叫它搜尋
- 叫它使用工具
- 叫它跑一次 workflow

而是：

> **事情交給它，你可以離開。**

等你回來，它應該告訴你：

> **「處理好了。」**

---

# 3. 我們要改變的核心假設

今天的電腦有一個根本限制：

> **電腦只能按照人類事先定義好的方式完成事情。**

我們希望 Agent-OS 打破這個假設。

未來的電腦應該是：

> **人類只表達意圖，AI 自己找出完成目標的方法。**

也就是：

```text
Human Intent
     ↓
Understand the real goal
     ↓
Figure out what needs to happen
     ↓
Find / learn / create the required abilities
     ↓
Use available devices and resources
     ↓
Handle failures and changes
     ↓
Keep working
     ↓
Outcome completed
```

---

# 4. Agent-OS 的核心互動不是 Chat，而是 Delegation

ChatGPT 類型產品的核心互動：

```text
Question → Answer
```

一般 Agent：

```text
Command → Action
```

Agent-OS：

```text
Delegation → Responsibility → Outcome
```

使用者不是在「Prompt AI」。

而是在：

> **把一件事情交出去。**

我們希望產品最自然的一句話不是：

> What can I help with?

而是：

> **What do you want me to take care of?**

中文：

> **有什麼事情要交給我？**

---

# 5. Goal 不是一個 Prompt

現在大部分 AI interaction 都是一次性的。

例如：

> 幫我找暑期實習。

一般 AI：

```text
搜尋一次
↓
回傳結果
↓
任務結束
```

Agent-OS 應該把它理解成一個真正存在的長期目標：

```text
Goal: 找到暑期軟體實習

Status: In Progress

Day 1
→ 搜尋與整理職缺

Day 3
→ 發現新的職缺

Day 5
→ 某個職缺即將截止

Day 7
→ 協助準備履歷

Day 12
→ 收到面試通知

Day 13
→ 安排時間

Day 15
→ 協助準備面試

...

直到：

Goal Completed
```

因此：

> **Goal 是持續存在的狀態，不是一句 Prompt。**

---

# 6. AI 必須會「自己想辦法」

Agent-OS 最核心的能力之一：

> **不要只會執行 Workflow，而是要能自己發明 Workflow。**

使用者說：

> 下個月我要去日本五天，預算四萬，不想自己排行程。

AI 不應該要求使用者指定：

- 用哪個網站
- 搜什麼
- 第一步做什麼
- 第二步做什麼

而應該自己理解：

```text
真正目標：
完成一次符合條件的旅行

可能需要：
→ 確認日期
→ 了解偏好
→ 查看行事曆
→ 搜尋交通
→ 搜尋住宿
→ 比較預算
→ 安排行程
→ 處理訂位
→ 出發前確認
→ 行程發生變化時重新調整
```

「怎麼做到」不應該是使用者的責任。

---

# 7. 不會做的事情，應該想辦法學會

現在的 Agent 常常遇到：

> 沒有這個 Tool，所以做不到。

Agent-OS 的方向應該是：

> **如果不知道怎麼做，就想辦法取得這個能力。**

理想流程：

```text
遇到未知任務
↓
理解需要什麼能力
↓
尋找現有能力
↓
沒有？
↓
研究如何完成
↓
建立 / 學習新的操作方法
↓
驗證
↓
完成任務
↓
把這次經驗變成未來可重用的能力
```

最終目標：

> **A computer that figures out how to do things it was never taught to do.**

一台可以自己想辦法完成「從未被教過的事情」的電腦。

---

# 8. One Assistant, Every Device

私人助理不能被困在某一台電腦裡。

Agent-OS 應該存在於使用者的整個數位環境中。

例如：

```text
               Personal Agent
                     │
       ┌─────────────┼─────────────┐
       ↓             ↓             ↓
   Raspberry Pi    Desktop       Laptop
      24/7          GPU           Files
       │
       └─────────────┬─────────────┘
                     ↓
                   Phone
             Camera / Location /
                Notification
```

Raspberry Pi 可以作為 24/7 永遠在線的核心節點。

其他裝置上線後，可以主動加入 Personal Device Mesh，告訴 Agent：

> 「我現在在線，我有哪些能力。」

例如：

```text
Jay-Desktop

Status:
Online

Capabilities:
- Browser
- Files
- Terminal
- Desktop Apps
- GPU
- Screen
- Audio
```

Agent 不應該只看到「五台裝置」。

它應該看到：

> **一整個屬於使用者的能力池。**

---

# 9. Personal Device Mesh

裝置不是被 Agent 隨機掃描與控制。

而是：

> **由使用者授權的裝置主動加入自己的 AI Mesh。**

概念：

```text
Device Online
↓
Join Personal Mesh
↓
Authenticate
↓
Report Capabilities
↓
Become Available Resource
```

Agent 可以依照任務，自動決定使用哪個資源。

例如：

```text
24 小時監控
→ Raspberry Pi

GPU 運算
→ Desktop

一般 Web Research
→ Server

需要使用者通知
→ Phone

需要相機
→ Phone

需要大量運算
→ Cloud
```

核心概念：

> **AI 不住在某一台裝置裡。**
>
> **AI 存在於你的整個數位世界裡。**

---

# 10. Waiting Is Part of the Task

真正的私人助理不會因為「現在做不到」就直接把任務結束。

例如：

> 幫我把昨天的 Blender 專案 Render 完。

但桌機現在關機。

Agent 不應該說：

> 無法完成。

而應該：

```text
Task:
Render Blender Project

Status:
Waiting for capable device
```

當桌機晚上上線：

```text
Desktop Online
↓
GPU Available
↓
Blender Available
↓
Resume Task
↓
Render
↓
Complete
```

所以：

> **等待，是任務生命週期的一部分。**

---

# 11. Agent 要對事情「負責」

Agent-OS 與一般 AI 最大的差異之一：

一般 AI：

> 「我可以幫你。」

Agent-OS：

> **「這件事交給我。」**

「負責」代表：

- 記得這件事
- 知道目前做到哪
- 知道還缺什麼
- 知道現在在等待誰
- 發現問題時繼續處理
- 條件改變時重新規劃
- 有重要決策才找使用者
- 一直到事情真的完成

---

# 12. 主動，而不是永遠等 Prompt

真正好的私人助理不會每件事都等老闆開口。

Agent-OS 最終應該理解：

```text
你的長期目標
你的行程
你答應過的事情
正在等待的事情
即將到期的事情
重要變化
可能的機會
可能的風險
```

例如：

> 「你上週交代我要找的實習，今天新增三個符合條件的職缺，其中一個後天截止。」

或：

> 「明天的會議提前一小時，我檢查過你的交通時間，原本安排會來不及。」

這不是 Notification System。

而是：

> **Agent 在持續照顧被委託的事情。**

---

# 13. Human Attention Is Expensive

Agent-OS 應該盡可能保護使用者的注意力。

不應該：

```text
可以嗎？
下一步可以嗎？
我要搜尋嗎？
我要打開嗎？
我要繼續嗎？
```

真正私人助理不會每五分鐘找老闆一次。

Agent 應該理解：

```text
可以自己決定
→ 自己做

有風險但可逆
→ 依照使用者設定做

高風險 / 不可逆 / 重要
→ 請使用者決定
```

最終目標：

> **最大化完成度，最小化人類需要介入的次數。**

---

# 14. AI 可以建立臨時的 Agent Organization

大型任務可能不是單一 Agent 最適合完成。

例如：

> 幫我建立一個線上課程事業。

Main Agent 可以自己判斷：

```text
                 Main Agent
                      │
        ┌─────────────┼─────────────┐
        ↓             ↓             ↓
    Research       Content       Business
        ↓             ↓             ↓
    Market         Course        Finance
    Analysis       Creation      Planning
```

重點不是預先寫死：

- Research Agent
- Coding Agent
- Marketing Agent

而是：

> **AI 根據目標自己形成臨時工作組織。**

任務完成後，組織可以解散。

因此 Multi-Agent 不只是「很多 AI 互相聊天」。

而是：

> **AI 為了完成事情，可以自己組織工作。**

---

# 15. Personal AI ≠ Personal Chatbot

我們最終想建立的東西，不是一個更強的聊天框。

而比較像：

> **使用者人生的數位後台。**

可能的產品主畫面：

```text
Your Assistant

Today

● 日本旅行
  等待航空公司確認改票

● 暑期實習
  新找到 3 個符合條件的職缺

● Project Agent-OS
  有 2 個任務正在執行

● 報告
  星期五截止，目前完成 70%

● Desktop
  Online — GPU available
```

下方只有：

> **交代一件事情…**

---

# 16. 核心產品哲學

Agent-OS 未來所有功能，都應該回頭用以下問題檢查。

## 16.1 使用者是在告訴 AI「結果」，還是在教 AI「步驟」？

如果需要使用者一直教它步驟，還不夠好。

---

## 16.2 Agent 是在回答問題，還是在負責事情？

我們要後者。

---

## 16.3 Agent 遇到未知問題時，是放棄，還是自己找方法？

我們要後者。

---

## 16.4 Agent 是否被某一台裝置綁住？

理想答案：不是。

---

## 16.5 裝置離線、網站改變、工具失敗後，任務會不會直接死亡？

理想答案：不會。

---

## 16.6 使用者需要一直盯著 Agent 嗎？

理想答案：不需要。

---

## 16.7 Agent 最後給使用者的是「建議」，還是「完成的結果」？

我們優先追求後者。

---

# 17. 我們真正的競爭對手

Agent-OS 不應該只把 OpenClaw、LangGraph、CrewAI 等 Agent Framework 當成競爭對手。

真正應該比較的是：

> **一個世界頂級的真人私人助理。**

我們應該不斷問：

> 一個非常好的真人私人助理，可以替老闆做到什麼？

然後再問：

> AI 有沒有辦法做到？

如果現在還做不到，

> **那可能正是 Agent-OS 最值得研究的地方。**

---

# 18. 核心願景關鍵字

Agent-OS 的核心不是：

- Chat
- Prompt
- Tool Calling
- Workflow
- Automation

而是：

- **Delegation**
- **Responsibility**
- **Outcome**
- **Autonomy**
- **Persistent Goals**
- **Personal Context**
- **Device Mesh**
- **Capability Discovery**
- **Self-Learning**
- **Adaptation**
- **Proactivity**
- **Trust**

---

# 19. 我們現在不要急著做的事情

目前專案還在 Vision 階段。

暫時不要讓討論過早掉進：

- 用 Go 還是 Rust
- Database 選什麼
- API 怎麼設計
- MCP 怎麼接
- Message Queue 用什麼
- Agent Loop 怎麼寫
- UI Framework
- Model Provider

這些都重要。

但不是現在最重要的問題。

現在最重要的是：

> **Agent-OS 到底想讓哪一件今天看起來很不可思議的事情，變成未來每個人的日常？**

---

# 20. Dream Test

未來每次想到新功能，都可以問：

> **這個功能有沒有讓 Agent-OS 更接近一個真正的私人全能助理？**

如果沒有，

可能就不是核心。

我們真正追求的 Demo 應該讓人看到之後第一反應是：

> **「幹，這怎麼做到的？」**

而不是：

> 「喔，又一個 AI Agent。」

---

# 21. 最終願景

Agent-OS 最終希望創造一個世界：

你不再管理：

- App
- Browser
- Files
- Devices
- Workflows
- Automations
- Agents
- Models
- Tools

你只需要管理：

> **你想要什麼。**

剩下的：

> **Agent-OS 自己想辦法。**

---

## One Assistant. Every Device.

## Give it an outcome. It figures out the rest.

## 有什麼事情要交給我？
