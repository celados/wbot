# wbot

`@celados/wbot` lets Agents read authorized WeChat conversations and send text and JPEG images through the CLI.
Its MCP tools remain read-only. It ships one executable:

- `wbot` — a JSON-only Agent CLI with an `mcp` subcommand for MCP stdio

See the [changelog](CHANGELOG.md) before upgrading across a minor version.

From 0.4.0-rc.3 the CLI and MCP read and send text through [Platform API v2](../../docs/platform-v2.md).
Two operations are not in v2 yet and still call the frozen `/platform/v1`: JPEG image send
(`/platform/v1/messages/send`) and webhook management (`/platform/v1/webhooks/*`).

## Configure

Install [Bun](https://bun.sh), then install the latest verified GitHub Release artifact:

```sh
bun add --global "@celados/wbot@https://github.com/celados/wbot/releases/latest/download/wbot.tgz"
wbot auth set
```

`wbot auth set` reads the key without echoing it and stores it at `$XDG_CONFIG_HOME/wbot/credentials.json`, or `~/.config/wbot/credentials.json` when `XDG_CONFIG_HOME` is unset. For automation, set `WBOT_API_KEY`; it overrides the stored credential. `WBOT_PLATFORM_URL` is an optional development or self-hosted endpoint override.

The default API is `https://wbot-api-test.celados.com`, where API keys are issued and `/platform/v2` is
served. `https://wbot-api-prod.celados.com` currently serves only `/platform/v1` and is not
compatible with this release; select it only with `WBOT_PLATFORM_URL` once it serves v2.

The `wbot-cloud-prod.celados.com` and `wbot-cloud-test.celados.com` origins belong to Convex browser clients; they are not valid `WBOT_PLATFORM_URL` values.

## Agent CLI

Discover the machine-readable schema without authentication:

```sh
wbot @schema
```

Use `wbot @schema messages.history` for one command, `wbot @schema 'messages.*'` for the group,
and `wbot @search history` to find commands by intent.

The public read surface is:

```sh
wbot accounts.list
wbot conversations.list
wbot messages.history '{ "conversationId": "conversation-id", "limit": 50 }'
wbot messages.updates '{ "conversationId": "conversation-id" }'
wbot messages.updates '{ "conversationId": "conversation-id", "cursor": "updates-cursor", "limit": 50 }'
wbot messages.get '{ "conversationId": "conversation-id", "messageId": "message-id" }'
```

Successful commands write one JSON value to stdout. Errors go to stderr and exit non-zero.

| Command              | Platform v2 request                               | Result                                        |
| -------------------- | ------------------------------------------------- | --------------------------------------------- |
| `accounts.list`      | `GET /accounts`                                   | `{ items: Account[] }`                        |
| `conversations.list` | `GET /conversations`                              | `{ items: Conversation[] }`, not paginated    |
| `messages.history`   | `GET /conversations/{id}/messages?before=&limit=` | `{ items: Message[], nextCursor, hasMore }`   |
| `messages.updates`   | `GET /conversations/{id}/changes?cursor=&limit=`  | `{ items: Change[], nextCursor, hasMore }`    |
| `messages.get`       | `GET /conversations/{id}/messages/{messageId}`    | one `Message` with a freshly signed media URL |

`conversations.list` takes no input and returns every readable conversation, most recent activity
first. Use it to discover conversations, not to detect new messages.

`messages.history` returns the newest page, oldest first within the page. Pass its `nextCursor` as
`cursor` to page toward older messages until `hasMore` is `false`; `nextCursor` is `null` when the
page is empty.

`messages.updates` reads the per-conversation change log. Without `cursor` it returns no items and a
`nextCursor` at the current tail: save it, then read forward from it until `hasMore` is `false`.
Use `messages.history` for backlog before that point. Each change has `sequence`, `kind`
(`message.created`, `message.retracted` or `message.attachment_ready`), `occurredAtMs`, and the
current `message` projection. Merge messages by `id` and keep the highest `revision`. Persist
`nextCursor` in the calling Agent only after your own processing commits; wbot stores no consumer
checkpoint, and re-reading an older cursor is safe. History and updates cursors are not
interchangeable.

`messages.get` re-reads one message, for example after `message.attachment_ready` or when a signed
attachment URL (valid for one hour) has expired.

Each conversation includes `accountId` and `capabilities`, the Tenant's current `read` and `send`
authorization; sending requires an active `send` grant. Capture freshness is reported once per
account by `accounts.list` (`captureFreshness.status` is `current`, `delayed`, `unavailable` or
`unknown`), so an Agent can distinguish a quiet conversation from delayed or unavailable capture.
It is operational recency evidence, not a guarantee of complete message history. Account
`capabilities` (`observe_messages`, `send_text`, `send_image`, `send_mentions`, and possibly future
values) describe the channel adapter.

## Rate limits and polling

The Platform rate-limits requests per API key, per minute:

| Category | Platform requests                                                              | CLI / MCP                                                                                        | Limit per key |
| -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------- |
| List     | `GET /accounts`, `GET /conversations`                                          | `accounts.list`, `conversations.list`, `list_accounts`, `list_conversations`                     | 30/min        |
| Read     | `GET .../messages`, `.../messages/{id}`, `.../changes`, `/outbound-sends/{id}` | `messages.history`, `messages.updates`, `messages.get`, `outbound-sends.get`, and MCP read tools | 300/min       |
| Send     | `POST .../messages` (text), `/platform/v1/messages/send` (JPEG)                | `messages.send`                                                                                  | 60/min        |

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

Supply exactly one of `text` or `imagePath`. JPEG sends are not in `/platform/v2` yet, so the CLI
submits them to the frozen `/platform/v1/messages/send`. Images must be regular JPEG files up to 5 MiB;
there is no automatic conversion. The CLI reads bounded bytes and submits multipart `metadata`
and `image` parts. It never sends the local path. The Platform validates full JPEG structure
and dimensions (at most 16 megapixels and 8192 pixels per side).

Image sending requires an account with the `send_image` capability (see `accounts.list`).
Installing the CLI does not enable the Adapter image switch.

The image result is `{ "id": "...", "conversationId": "...", "status": "queued" }`: the v1 receipt
projected onto the v2 send identity. Query `outbound-sends.get` with that `id` for the full v2
outbound send.

Keep the same caller-owned `requestId` only for the same intent and image bytes. The CLI does
not retry or poll automatically, including after an ambiguous connection failure. Use
`outbound-sends.get` to inspect a known send ID. MCP and Plugin tools remain read-only.

## Send text from the CLI

```sh
wbot messages.send '{ "conversationId": "conversation-id", "requestId": "digest:2026-09-21:conversation-id", "text": "Daily summary", "requestedBy": "agent:grok" }'
wbot outbound-sends.get '{ "outboundSendId": "outbound-send-id" }'
```

Multi-line text is easiest as the whole input in YAML on stdin: the quoted heredoc expands nothing
and `|` keeps the lines verbatim. The same object can come from a file: `wbot messages.send @send.yaml`.

```sh
wbot messages.send - <<'EOF'
conversationId: conversation-id
requestId: digest:2026-09-21:conversation-id
requestedBy: agent:grok
text: |
  Daily summary
  - 3 new threads
EOF
```

All four send fields are required non-empty strings. `requestedBy` identifies the caller for
attribution; it does not change the Tenant or its authorization. Text supports newlines and
Unicode. The CLI sends `POST /platform/v2/conversations/{conversationId}/messages` with
`requestId` as the `Idempotency-Key` header. The result is the current outbound send:

```json
{
	"id": "send_...",
	"conversationId": "conversation-id",
	"status": "queued",
	"attemptCount": 0,
	"error": null,
	"reflectedMessageId": null,
	"createdAtMs": 1795845019686,
	"updatedAtMs": 1795845019686
}
```

Save `id` and query it with `outbound-sends.get` to obtain the current execution outcome.

Choose a stable `requestId` for each logical send, unique within the Tenant (for example, include
the summary date and destination). It shares one namespace with `/platform/v1` request IDs.
Repeating exactly the same input returns the existing send in its current state, which may already
be past `queued`; changing the destination, text, or `requestedBy` with that ID returns a `conflict`
error. The CLI does not generate IDs, retry sends, or poll automatically. If the response is lost,
retry only with the same ID and identical input; a new ID may create a duplicate message.

| Query status    | Meaning                                                               |
| --------------- | --------------------------------------------------------------------- |
| `queued`        | Waiting for execution                                                 |
| `processing`    | Execution is in progress                                              |
| `accepted`      | The channel accepted the invocation; not a recipient delivery receipt |
| `failed`        | Execution failed                                                      |
| `indeterminate` | Execution may have happened; do not automatically resend              |

`attemptCount` and `error` describe execution attempts. `reflectedMessageId`, when non-null,
identifies the corresponding message observed by the Platform; that message carries the send's
`outboundSendId`. It is not a read receipt. A successful result query exits zero even for `failed` or `indeterminate`;
automation must inspect the returned status. Request or contract failures write diagnostics to
stderr, leave stdout empty, and exit non-zero.

Text sends use `/platform/v2`; JPEG sends use `/platform/v1/messages/send`. Result lookup uses
`GET /platform/v2/outbound-sends/{id}` for both. These CLI commands are not MCP tools.

## MCP

Start the stdio server with:

```sh
wbot mcp
```

It exposes five read-only tools with the same inputs and results as the CLI reads:
`list_accounts`, `list_conversations`, `read_message_history`, `read_message_updates`, and
`get_message`. It has no send, grant, operator, webhook, or credential-management tools.

## Message shape

A `Message` has `id`, `conversationId`, `direction` (`in` or `out`), `occurredAtMs`, `revision`,
`state`, `content`, `sender`, `replyTo`, `mentions`, `mentionsAll`, `mentionsSelf`, and optionally
`referenceId`, `retractedAtMs`, `attachment`, and `outboundSendId`. Times and sizes are numbers
(epoch milliseconds, bytes). See [Platform API v2](../../docs/platform-v2.md#shared-shapes) for the
full types.

- Retraction is a state: `state: "retracted"` with `retractedAtMs` and `content: null`. The same
  message `id` comes back with a higher `revision`; merge instead of treating it as a new message.
- Kind-specific fields live inside `content`: `nudge.target` and `group_invitation.members`
  (identities). `file.sizeBytes` is a number or `null`.
- `mentionsSelf` is true only when the bound account is named explicitly; `@all` sets `mentionsAll`.
- `outboundSendId` appears only on outgoing messages sent by your own Tenant.
- `attachment` is `pending` or `ready` (signed URL, `mimeType`, `sizeBytes`, `descriptor`). A
  `pending` attachment is announced later by a `message.attachment_ready` change.

An unfamiliar future content kind is returned as `unknown` with `preview: "Unsupported message type"`,
`originalKind`, and the complete `originalContent` object. This applies to message bodies, quotes,
and conversation previews. Known kinds still require their documented fields; malformed payloads
remain contract errors. No records are dropped, and cursors and pagination flags are preserved.

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

Webhook management is not in `/platform/v2` yet; these commands call `/platform/v1/webhooks/*`.

See the [Bun receiver and setup/recovery guide](https://github.com/celados/wbot/tree/main/examples/webhook)
for HMAC verification, durable cursor handling, retry limits and setup-gap recovery. Webhook
management is CLI-only; MCP and both plugins stay read-only.
