# Telegram 通訊整合

Agent-OS 可透過 BotFather 建立的 Telegram Bot，在手機與樹莓派之間雙向傳遞訊息。Gateway 使用 Long Polling 主動連線 Telegram，不需要公開 IP、Webhook、網域或路由器 Port Forwarding。

## 目前支援

- 私人對話單一 owner 配對。
- Telegram 文字訊息進入既有 Assistant Intake。
- Agent 回覆傳回原本的 Telegram 私人對話。
- Wake Engine、Watcher 與 Browser Auth 通知轉送至 Telegram。
- `update_id` 去重、持久化 offset、長訊息切割及失敗退避重試。
- `/start`、`/help`、`/status`、`/unlink`。

第一版刻意不接收群組、頻道、檔案、照片或語音訊息。

## 1. 使用 BotFather 建立 Bot

1. 在 Telegram 開啟官方 `@BotFather`。
2. 傳送 `/newbot`。
3. 設定顯示名稱與以 `bot` 結尾的 username。
4. 保存 BotFather 提供的 Bot Token。

Token 等同 Bot 的控制密碼，不要貼到聊天、Issue、Git commit 或 Web 表單。如果 Token 外洩，立即在 BotFather 撤銷並產生新 Token。

可在 BotFather 使用 `/setcommands` 設定：

```text
start - 連接 Agent-OS
help - 顯示使用方式
status - 查看通訊狀態
unlink - 解除配對
```

## 2. 在樹莓派保存 Token

Agent-OS 預設讀取：

```text
~/.local/state/agent-os/credentials/telegram-bot-token
```

透過 SSH 執行以下命令，貼上 Token 時畫面不會顯示內容：

```bash
install -d -m 0700 "$HOME/.local/state/agent-os/credentials"
read -rsp 'Telegram Bot Token: ' token; echo
printf '%s\n' "$token" > "$HOME/.local/state/agent-os/credentials/telegram-bot-token"
chmod 0600 "$HOME/.local/state/agent-os/credentials/telegram-bot-token"
unset token
systemctl --user restart agent-os
```

也可設定 `AGENT_OS_TELEGRAM_BOT_TOKEN_FILE` 指向其他受保護檔案。`AGENT_OS_TELEGRAM_BOT_TOKEN` 可供短期開發測試，但正式部署建議使用檔案。

## 3. 配對 Telegram 帳號

1. 開啟 Agent-OS Web UI 的「設定」。
2. Telegram 顯示「等待配對」後，按「連接 Telegram」。
3. 按「開啟 Telegram」，或手動向 Bot 傳送 `/start 配對碼`。
4. Bot 回覆「已成功連接 Agent-OS」即完成。
5. 回到設定頁按「傳送測試」驗證雙向通訊。

配對碼只保存 SHA-256、有效期 10 分鐘且只能使用一次。完成後以 Telegram 數字 user ID 與私人 chat ID 驗證每一則訊息。

## 運作與復原

- Gateway 必須持續運行，樹莓派也必須能連線 `api.telegram.org`。
- Telegram 暫時無法送信時，delivery 會保留在 SQLite 並以退避策略重試。
- Gateway 重啟後會恢復 Long Polling offset、配對與尚未送達的訊息。
- 相同 Telegram `update_id` 不會重複建立 Assistant Request。
- `/unlink` 或 Web UI「解除配對」只移除帳號綁定，不會刪除既有 Agent-OS Goal 或對話紀錄。

## 管理 API

所有端點皆要求 Agent-OS owner session；變更狀態的端點另外要求 CSRF Token。

```text
GET    /api/v1/channels/telegram
POST   /api/v1/channels/telegram/pairing
POST   /api/v1/channels/telegram/test
DELETE /api/v1/channels/telegram
```
