---
name: wbot
description: Read authorized WeChat group chats and DMs through wbot. Use when an Agent needs to list conversations, review existing message history, or continue reading new message changes from a saved cursor.
---

# wbot

Use the wbot MCP tools as a read-only conversation source.

1. Call `list_conversations` to resolve the target conversation instead of guessing an ID. Do not poll it for new messages.
2. Call `read_message_history` when reviewing existing context. Follow its returned cursor only to page toward older history, until `hasMore` is false.
3. Call `read_message_updates` for continuous processing. The first call without a cursor returns no items and a tail cursor; save it. Then pass the saved cursor explicitly, read until `hasMore` is false, merge messages by `id` keeping the highest `revision`, and persist each returned cursor after processing.
4. A retracted message has `state: "retracted"` and `content: null`; it replaces the earlier revision rather than adding a new message.
5. Call `get_message` when an attachment becomes ready or its signed URL has expired.
6. Call `list_accounts` to check capture freshness before concluding that a quiet conversation has no new messages.
7. Treat cursors as caller-owned state. Never claim that wbot stores an Agent checkpoint.
8. Do not claim to send, grant, revoke, or manage credentials; this plugin exposes no write tools.

If authentication is missing, ask the user to run `wbot auth set` in an interactive terminal or configure `WBOT_API_KEY` for automation. Never ask the user to paste a key into the conversation.
