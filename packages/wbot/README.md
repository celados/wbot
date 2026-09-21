# wbot

`@celados/wbot` lets Agents read authorized WeChat conversations and send text through the CLI.
Its MCP tools remain read-only. It ships one executable:

- `wbot` — a JSON-only Agent CLI with an `mcp` subcommand for MCP stdio

See the [changelog](CHANGELOG.md) before upgrading across a minor version.

## Configure

Install [Bun](https://bun.sh), then install the latest verified GitHub Release artifact:

```sh
bun add --global "@celados/wbot@https://github.com/celados/wbot/releases/latest/download/wbot.tgz"
wbot auth set
```

`wbot auth set` reads the key without echoing it and stores it at `$XDG_CONFIG_HOME/wbot/credentials.json`, or `~/.config/wbot/credentials.json` when `XDG_CONFIG_HOME` is unset. For automation, set `WBOT_API_KEY`; it overrides the stored credential. `WBOT_PLATFORM_URL` is an optional development or self-hosted endpoint override.

The default public API is `https://wbot-api-prod.celados.com`. Internal dogfood API keys created by the test deployment require `WBOT_PLATFORM_URL=https://wbot-api-test.celados.com`. This reuses `WBOT_API_KEY`, the local credentials file, and the same CLI and MCP schemas; there is no test-specific executable.

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
Tenant's current `read` and `send` authorization. Sending requires an active `send` grant. Every
`messages.updates` result, including an empty page, includes capture freshness so an Agent can
distinguish a quiet conversation from delayed, unavailable, or insufficient capture evidence.
`captureFreshness` is operational recency evidence, not a guarantee of complete message history.

## Send text from the CLI

```sh
wbot messages.send '{ "conversationId": "conversation-id", "requestId": "digest:2026-09-21:conversation-id", "text": "Daily summary", "requestedBy": "agent:grok" }'
wbot outbound-sends.get '{ "outboundSendId": "outbound-send-id" }'
```

All four send fields are required non-empty strings. `requestedBy` identifies the caller for
attribution; it does not change the Tenant or its authorization. JSON text supports newlines and
Unicode. The send result contains `outboundSendId`, `conversationId`, and `status: "queued"`.
Save `outboundSendId` and query it to obtain the current execution outcome.

Choose a stable `requestId` for each logical send, unique within the Tenant (for example, include
the summary date and destination). Repeating exactly the same input uses the same Platform send
intent; changing the destination, text, or `requestedBy` with that ID causes a conflict. The CLI
does not generate IDs, retry sends, or poll automatically. If the response is lost, retry only
with the same ID and identical input; a new ID may create a duplicate message. Even a repeated
send request returns `queued`; use `outbound-sends.get` for the current status.

| Query status    | Meaning                                                               |
| --------------- | --------------------------------------------------------------------- |
| `queued`        | Waiting for execution                                                 |
| `processing`    | Execution is in progress                                              |
| `accepted`      | The channel accepted the invocation; not a recipient delivery receipt |
| `failed`        | Execution failed                                                      |
| `indeterminate` | Execution may have happened; do not automatically resend              |

`reflectedMessageId`, when non-null, identifies the corresponding message observed by the Platform.
It is not a read receipt. A successful result query exits zero even for `failed` or `indeterminate`;
automation must inspect the returned status. Request or contract failures write diagnostics to
stderr, leave stdout empty, and exit non-zero.

Sending uses the existing `/platform/v1/messages/send` endpoint; result lookup uses
`/platform/v1/outbound-sends/get`. Only text sending is supported. These CLI commands are not MCP tools.

## MCP

Start the stdio server with:

```sh
wbot mcp
```

For internal test-deployment dogfood, start it with `WBOT_PLATFORM_URL=https://wbot-api-test.celados.com wbot mcp`.

It exposes `list_conversations`, `read_message_history`, and `read_message_updates`. Version 1 has no send, grant, operator, or credential-management MCP tools.
