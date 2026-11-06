# wbot

`@celados/wbot` lets Agents read authorized WeChat conversations and send text and JPEG images through the CLI.
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

The API key is resolved lazily, only by commands that call the Platform (`@schema`, `--help` and `auth set` never read it), from the first source that has one: `WBOT_API_KEY`, then the key saved by `wbot auth set`, then — only when `WBOT_PLATFORM_URL` is `https://wbot-api-test.celados.com` — the team's test Tenant key through [latch](https://github.com/celados/latch). `wbot @schema` lists these sources under `values:`. When none has a key, the command fails before any network request with `error: DOMAIN_ERROR`, `code: value_unavailable`, and one `tried:` entry per source with its reason and next step.

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

History cursors page toward older messages. Updates cursors move forward by Platform change-sequence order, including retractions of older messages. Save each updates cursor in the calling Agent and explicitly pass it on the next call; wbot does not store a consumer checkpoint.

Each conversation includes `capabilities` and `captureFreshness`. Capabilities describe the
Tenant's current `read` and `send` authorization. Sending requires an active `send` grant. Every
`messages.updates` result, including an empty page, includes capture freshness so an Agent can
distinguish a quiet conversation from delayed, unavailable, or insufficient capture evidence.
`captureFreshness` is operational recency evidence, not a guarantee of complete message history.

## Rate limits and polling

The Platform rate-limits `/platform/v1/*` per API key, per minute:

| Operation                                                         | CLI / MCP                                                                            | Limit per key |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------- |
| List (`conversations/query`)                                      | `conversations.list`, `list_conversations`                                           | 30/min        |
| Read (`messages/query`, `messages/history`, `outbound-sends/get`) | `messages.updates`, `messages.history`, `outbound-sends.get`, and the MCP read tools | 300/min       |
| Send (`messages/send`)                                            | `messages.send`                                                                      | 60/min        |

A Tenant also has an aggregate budget of three times the per-key limit, which only takes effect
when the Tenant has more than three active keys.

An over-limit request returns HTTP 429 with a `Retry-After` header (seconds) and the body
`{ "error": { "code": "rate_limited", "message": "...", "retryAfterMs": 1500 } }`. A 429 is
rejected before any work happens. The CLI and MCP client wait for `Retry-After` (falling back to
`retryAfterMs`, at most 60 seconds) and retry the same request once; this is the only automatic
retry, and a retried send keeps its `requestId` and body. If the retry is also limited, the command
fails with a `rate_limited` error that reports how long to wait; stdout stays empty and the exit
code is non-zero (MCP returns a tool error). The typed `PlatformRequestError` exposes
`code: "rate_limited"` and `retryAfterMs`.

Polling guidance:

- Read new messages incrementally with `messages.updates` and the saved cursor, or configure
  [webhooks](#incoming-message-webhooks) and read updates only when notified.
- Do not loop over `conversations.list` to detect new messages; list conversations to discover
  them, then follow each conversation's updates cursor.
- `messages.history` is for looking back at older context, not for polling.

`captureFreshness` is maintained by the Platform so read results stay cacheable: `status` is
authoritative, and `asOfMs` is a lower bound on the last successful capture scan. It is exact when
the status changes and otherwise refreshed at most every 10 minutes, so do not compute freshness
yourself from `asOfMs`.

## Send a JPEG image from the CLI

```sh
wbot messages.send '{ "conversationId": "conversation-id", "requestId": "image:unique-intent-id", "imagePath": "/absolute/path/photo.jpg", "requestedBy": "agent:example" }'
```

Supply exactly one of `text` or `imagePath`. Images must be regular JPEG files up to 5 MiB;
there is no automatic conversion. The CLI reads bounded bytes and submits multipart `metadata`
and `image` parts. It never sends the local path. The Platform validates full JPEG structure
and dimensions (at most 16 megapixels and 8192 pixels per side).

Image sending requires a compatible Platform and an Adapter with image sending enabled.
The initial rollout is on the test Platform: explicitly set
`WBOT_PLATFORM_URL=https://wbot-api-test.celados.com` with a matching test Tenant key.
Installing the CLI does not enable the Adapter image switch. The default URL remains production.

Keep the same caller-owned `requestId` only for the same intent and image bytes. The CLI does
not retry or poll automatically, including after an ambiguous connection failure. Use
`outbound-sends.get` to inspect a known send ID. MCP and Plugin tools remain read-only.

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
`/platform/v1/outbound-sends/get`. Text and JPEG image sending are supported. These CLI commands are not MCP tools.

## MCP

Start the stdio server with:

```sh
wbot mcp
```

For internal test-deployment dogfood, start it with `WBOT_PLATFORM_URL=https://wbot-api-test.celados.com wbot mcp`.

It exposes `list_conversations`, `read_message_history`, and `read_message_updates`. Version 1 has no send, grant, operator, or credential-management MCP tools.

## Message type evolution

`retracted` is an explicit content kind; `revision` and `referenceId` are retained when present,
including reference IDs on quotes. Merge repeated message IDs by revision instead of treating a
retraction as a new user message. `group_invitation` uses `sender` for the inviter and optional
`invitedMembers` for the members' stable Platform identity IDs and display names.

An unfamiliar future content kind is returned as `unknown` with `preview: "Unsupported message type"`,
`originalKind`, and the complete `originalContent` object. This applies to message bodies, quotes,
and conversation previews. An unfamiliar latest-message type is `unknown` with `originalType`.
Known kinds still require their documented fields; malformed payloads remain contract errors.
No records are dropped, and cursors, pagination flags, and capture freshness are preserved.
After upgrading from a client that rejected a valid kind, retry the same cursor rather than skipping
past the offending message. This does not recover source records missing from the Platform.

## Incoming-message webhooks

Version 0.2.5 adds optional HTTPS wake-ups for newly received messages. Configure one webhook per
read-authorized conversation. Set `WBOT_WEBHOOK_SIGNING_SECRET` to a random 32-byte base64url secret
through your secret manager; it is distinct from `WBOT_API_KEY`.

```sh
wbot webhooks.configure '{"conversationId":"conversation-id","url":"https://hooks.your-domain.com/webhook"}'
wbot webhooks.list
wbot webhooks.retry '{"conversationId":"conversation-id"}'
wbot webhooks.remove '{"conversationId":"conversation-id"}'
```

`signingSecretEnv` optionally names a different environment variable. The CLI never accepts a
plaintext signing secret argument and does not return it in successful output. HTTPS port 443 and a
public IPv4 hostname are required. Redirects are not followed. Current limits are 20 subscriptions
per tenant and 100 per conversation; configuration requires a read grant.

Notifications contain only event/conversation identity and timing, not message content. Verify the
signature, durably accept/deduplicate the event, then call `messages.updates` from your saved cursor
until `hasMore=false`. Only incoming new messages notify; outgoing messages and retractions remain
queryable. A successful callback does not mean the consumer processed its messages.

See the [Bun receiver and setup/recovery guide](https://github.com/celados/wbot/tree/v0.2.5/examples/webhook)
for HMAC verification, durable cursor handling, retry limits and setup-gap recovery. MCP and both
plugins continue to expose only their existing three read tools.
