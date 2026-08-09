---
name: wbot
description: Read authorized WeChat group chats and DMs through wbot. Use when an Agent needs to list conversations, review existing message history, or continue reading newly ingested messages from a saved cursor.
---

# wbot

Use the wbot MCP tools as a read-only conversation source.

1. Call `list_conversations` to resolve the target conversation instead of guessing an ID.
2. Call `read_message_history` when reviewing existing context. Follow its returned cursor only to page toward older history.
3. Call `read_message_updates` for continuous processing. Save and explicitly pass its returned updates cursor on the next call.
4. Treat cursors as caller-owned state. Never claim that wbot stores an Agent checkpoint.
5. Do not claim to send, grant, revoke, or manage credentials; this plugin exposes no write tools.

If authentication is missing, ask the user to run `wbot auth set` in an interactive terminal or configure `WBOT_API_KEY` for automation. Never ask the user to paste a key into the conversation.
