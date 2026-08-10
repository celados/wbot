# wbot

`@celados/wbot` gives Agents read-only access to the WeChat conversations granted to an API key. It ships one executable:

- `wbot` — a JSON-only Agent CLI with an `mcp` subcommand for MCP stdio

## Configure

Install [Bun](https://bun.sh), then install the latest verified GitHub Release artifact:

```sh
bun add --global "@celados/wbot@https://github.com/celados/wbot/releases/latest/download/wbot.tgz"
wbot auth set
```

`wbot auth set` reads the key without echoing it and stores it at `$XDG_CONFIG_HOME/wbot/credentials.json`, or `~/.config/wbot/credentials.json` when `XDG_CONFIG_HOME` is unset. For automation, set `WBOT_API_KEY`; it overrides the stored credential. `WBOT_PLATFORM_URL` is an optional development or self-hosted endpoint override.

The default public API is `https://wbot-api-prod.celados.com`. Internal dogfood API keys created by the test deployment require `WBOT_PLATFORM_URL=https://wbot-api-test.celados.com`. This reuses `WBOT_API_KEY`, the local credentials file, and the same read-only command and tool schemas; there is no test-specific executable.

The `wbot-cloud-prod.celados.com` and `wbot-cloud-test.celados.com` origins belong to Convex browser clients; they are not valid `WBOT_PLATFORM_URL` values.

## Agent CLI

Discover the machine-readable schema without authentication:

```sh
wbot @schema
```

The public read surface is:

```sh
wbot conversations.list '{ "limit": 50 }'
wbot messages.history '{ "conversationId": "conversation-id", "limit": 50 }'
wbot messages.updates '{ "conversationId": "conversation-id", "cursor": "updates-cursor", "limit": 50 }'
```

Successful commands write one JSON value to stdout. Errors go to stderr and exit non-zero.

For internal test-deployment dogfood, prefix the same commands with `WBOT_PLATFORM_URL=https://wbot-api-test.celados.com`.

History cursors page toward older messages. Updates cursors move forward by Platform ingestion order. Save each updates cursor in the calling Agent and explicitly pass it on the next call; wbot does not store a consumer checkpoint.

Each conversation includes `capabilities` and `captureFreshness`. Capabilities describe the
Tenant's current `read` and `send` authorization, while wbot itself remains read-only. Every
`messages.updates` result, including an empty page, includes capture freshness so an Agent can
distinguish a quiet conversation from delayed, unavailable, or insufficient capture evidence.
`captureFreshness` is operational recency evidence, not a guarantee of complete message history.

## MCP

Start the stdio server with:

```sh
wbot mcp
```

For internal test-deployment dogfood, start it with `WBOT_PLATFORM_URL=https://wbot-api-test.celados.com wbot mcp`.

It exposes `list_conversations`, `read_message_history`, and `read_message_updates`. Version 1 has no send, grant, operator, or credential-management MCP tools.
