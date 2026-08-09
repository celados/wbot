# wbot

`@celados/wbot` gives Agents read-only access to the WeChat conversations granted to an API key. It ships four executables from one package:

- `wbot` — a JSON-only Agent CLI
- `wbot-mcp` — the same three operations over MCP stdio
- `wbot-test` — the same CLI with the test HTTP endpoint as its default
- `wbot-test-mcp` — the same MCP runtime with the test HTTP endpoint as its default

## Configure

Install [Bun](https://bun.sh), then install the latest verified GitHub Release artifact:

```sh
bun add --global "@celados/wbot@https://github.com/celados/wbot/releases/latest/download/wbot.tgz"
wbot auth set
```

`wbot auth set` reads the key without echoing it and stores it at `$XDG_CONFIG_HOME/wbot/credentials.json`, or `~/.config/wbot/credentials.json` when `XDG_CONFIG_HOME` is unset. For automation, set `WBOT_API_KEY`; it overrides the stored credential. `WBOT_PLATFORM_URL` is an optional development or self-hosted endpoint override.

The default public API is `https://wbot-api-prod.celados.com`. API keys created by the current dogfood website belong to the test deployment, so use `wbot-test` or `wbot-test-mcp` with those keys. Both test aliases default to `https://wbot-api-test.celados.com`. The aliases reuse `WBOT_API_KEY`, the local credentials file, every command and tool schema, and the existing `WBOT_PLATFORM_URL` override.

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

For a test-deployment API key, replace `wbot` with `wbot-test` in the examples above.

History cursors page toward older messages. Updates cursors move forward by Platform ingestion order. Save each updates cursor in the calling Agent and explicitly pass it on the next call; wbot does not store a consumer checkpoint.

## MCP

Start the stdio server with:

```sh
wbot-mcp
```

Use `wbot-test-mcp` when the API key was created by the test deployment.

It exposes `list_conversations`, `read_message_history`, and `read_message_updates`. Version 1 has no send, grant, operator, or credential-management MCP tools.
