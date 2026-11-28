---
type: Reference
title: Platform API v2
description: >
  HTTP reference for /platform/v2: accounts, conversations, the message timeline, the
  per-conversation change log, text sends, outbound-send status, and the SSE doorbell.
---

# Platform API v2

`/platform/v2` is the second Platform API Major. It is a REST contract for direct HTTP integrations
built on the same facts as `/platform/v1`. v1 is frozen and receives bug fixes only; see
[versioning](adr/0001-versioning-and-platform-compatibility.md) for how majors evolve and retire.

> **Availability.** v2 is live on `https://wbot-api-test.celados.com`, the default origin of the
> `wbot` CLI and MCP. `https://wbot-api-prod.celados.com` still serves v1 only. The CLI and MCP use
> v2 from 0.4.0-rc.3 for every read and for text sends; JPEG image send and webhook management are
> not in v2 yet and still call v1.

## What changed from v1

| Concern            | v1                                                   | v2                                                                    |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------------- |
| Style              | `POST /<noun>/<verb>` with JSON bodies               | `GET` / `POST` on resources; reads take query parameters              |
| Time and sizes     | Mix of strings and numbers                           | Always numbers (epoch milliseconds, bytes)                            |
| Retraction         | Fake content kind `retracted`                        | `state: "retracted"`, `retractedAtMs`, `content: null`                |
| Capture freshness  | Repeated on every conversation and updates page      | Once per account on `GET /accounts`                                   |
| Late attachments   | `pending` was never announced again                  | `message.attachment_ready` change and an `attachment` doorbell reason |
| Expired media URLs | Re-read a whole page                                 | `GET .../messages/{id}` signs a fresh URL                             |
| Send idempotency   | `requestId` in the body; replay always said `queued` | `Idempotency-Key` header; replay returns the current send             |
| Mentions           | Not exposed                                          | `mentions`, `mentionsAll`, `mentionsSelf` on every message            |

Webhooks remain on v1 (`/platform/v1/webhooks/*`). Image sending remains on v1.

## Conventions

- Authenticate every request with `Authorization: Bearer <tenant API key>`. It is the same key as
  v1. Calls are stateless, and the Platform keeps no consumer progress.
- Success bodies are JSON. Errors are `{ "error": { "code": "...", "message": "..." } }`. Branch
  on `code` only, never on `message`. Codes: `unauthorized` (401), `forbidden` (403), `not_found`
  (404), `invalid_request` / `invalid_cursor` / `unsupported_cursor_version` (400), `conflict`
  (409), `rate_limited` (429), `internal_error` (500), and `upstream_error` (502) when
  `GET /events` cannot open its stream.
- An unknown path or method returns a plain-text 404, not JSON.
- Cursors are opaque strings, bound to one tenant and one conversation. Pass back only a
  `nextCursor` the Platform returned. A hand-built value such as a timestamp is rejected.
- Ignore fields you do not recognise. v2 grows by additions only.

### Rate limits

v2 shares the v1 per-key budgets.

| Category | Endpoints                                                                        | Limit per key |
| -------- | -------------------------------------------------------------------------------- | ------------- |
| List     | `GET /accounts`, `GET /conversations`                                            | 30/min        |
| Read     | `GET /conversations/{id}`, `.../messages`, `.../changes`, `/outbound-sends/{id}` | 300/min       |
| Send     | `POST /conversations/{id}/messages`                                              | 60/min        |

A 429 carries `Retry-After` (seconds) and `error.retryAfterMs`, and is rejected before any work
happens. `GET /events` is not metered per request. A tenant can hold at most 20 concurrent event
streams; the 21st returns 429.

## Shared shapes

```ts
type Identity = {
	identityId: string
	displayName: string | null
	avatar: { status: 'pending' } | { status: 'ready'; url: string }
}

type Attachment =
	| { status: 'pending' }
	| {
			status: 'ready'
			url: string // signed, valid for 1 hour
			mimeType: string
			sizeBytes: number
			descriptor:
				| { kind: 'image'; width: number; height: number }
				| { kind: 'file' }
				| { kind: 'audio'; durationMs: number }
	  }

type Message = {
	id: string
	conversationId: string
	direction: 'in' | 'out'
	occurredAtMs: number
	referenceId?: string
	revision: number
	state: 'active' | 'retracted'
	retractedAtMs?: number
	content: Content | null // null when retracted
	sender: Identity | null
	replyTo: {
		messageId: string | null
		referenceId?: string
		sender: Identity | null
		occurredAtMs: number | null
		state: 'active' | 'retracted'
		content: Content | null
	} | null
	mentions: Identity[]
	mentionsAll: boolean
	mentionsSelf: boolean
	attachment?: Attachment
	outboundSendId?: string
}
```

`Content` is keyed by `kind`:

- `text`: `text`
- `file`: `filename`, `sizeBytes: number | null`
- `link`: `title`, `description`, `url`, `thumbnailUrl`
- `mini_program`: `title`, `appId`, `username`, `pagePath`, `thumbnailUrl`
- `nudge`: `suffix`, `target: Identity | null`
- `group_invitation`: `members: Identity[]`
- `unknown`: `preview` — a message type the Platform itself could not classify. A quote whose
  original content is missing also arrives as `{ "kind": "unknown", "preview": "" }`.
- `image`, `audio`, `video`, `emoji`, `location`: no extra fields

String fields such as `text`, `filename` and `title` may be `null` when the device did not report
them.

Treat an unknown `kind` as unsupported and keep the record. Do not drop it or fail the page.

Message semantics:

- Merge by `id` and keep the highest `revision`. The same message is returned again when it is
  retracted or its attachment becomes ready.
- Fields that only apply to one kind live inside `content`, for example `nudge.target` and
  `group_invitation.members`. v1 put these at the top level.
- `mentionsSelf` is true only when the bound account is named explicitly. `@all` sets
  `mentionsAll` and leaves `mentionsSelf` false. Mention fields are empty when the device did not
  report them.
- `outboundSendId` appears only on an outgoing message that your own tenant sent. Other tenants
  granted the same conversation never see it.
- `attachment` is present only on media messages, and a message has at most one. `pending` turns
  into `ready` later and is announced by a `message.attachment_ready` change.

## Endpoints

### `GET /platform/v2/accounts`

Returns the accounts behind the conversations you may read: `{ items: Account[] }`.

```ts
type Account = {
	id: string
	channel: string
	capabilities: Array<
		'observe_messages' | 'send_text' | 'send_image' | 'send_mentions'
	>
	selfIdentity: Identity | null
	captureFreshness: {
		status: 'current' | 'delayed' | 'unavailable' | 'unknown'
		asOfMs: number | null
	}
}
```

`captureFreshness` is account-level evidence that capture is keeping up. It tells a quiet
conversation apart from delayed or unavailable capture, but it does not guarantee complete
history. Use `status` as given and do not derive freshness from `asOfMs` yourself.

### `GET /platform/v2/conversations`

Lists every conversation you hold a `read` grant for: `{ items: Conversation[] }`. The list is
sorted by `lastActivityAtMs` descending and is not paginated.

```ts
type Conversation = {
	id: string
	accountId: string
	channel: string
	channelConversationId: string
	kind: 'direct' | 'room'
	title: string | null
	avatar:
		| { kind: 'fallback' }
		| { kind: 'image'; url: string }
		| { kind: 'composite'; urls: string[] }
	latestMessage: Message | null
	lastActivityAtMs: number | null
	capabilities: Array<'read' | 'send'> // your grant on this conversation
}
```

Use this to discover conversations. Do not poll it to detect new messages.

### `GET /platform/v2/conversations/{id}`

Returns one `Conversation`. Without a read grant it returns 403.

### `GET /platform/v2/conversations/{id}/messages?before=&after=&limit=`

Timeline snapshot in ingest order, returned as `{ items: Message[], nextCursor: string | null, hasMore }`.

- `limit` is 1–100 and defaults to 50.
- Use at most one of `before` and `after`.
- With no cursor you get the newest page. `before=<nextCursor>` pages toward older messages.
- `after=<cursor>` pages toward newer messages.
- `nextCursor` is `null` whenever the page is empty, for example an empty conversation or an empty
  `after` page. After an empty `after` page, keep the cursor you already had.
- Within a page, `items` are always oldest first.

This is for context and backfill. To follow new activity, use `changes`.

### `GET /platform/v2/conversations/{id}/messages/{messageId}`

Returns the latest projection of one `Message` and signs a fresh attachment URL. Use it after a
`message.attachment_ready` change, or when a signed URL has expired.

### `GET /platform/v2/conversations/{id}/changes?cursor=&limit=`

The durable per-conversation change log. It is the forward-reading primitive. The response is
`{ items: Change[], nextCursor: string, hasMore }`.

```ts
type Change = {
	sequence: number
	kind: 'message.created' | 'message.retracted' | 'message.attachment_ready'
	occurredAtMs: number
	message: Message // current projection, not a snapshot at change time
}
```

- `limit` is 1–100 and defaults to 50.
- Without `cursor` the call returns no items and a `nextCursor` at the current tail. Store it,
  then read forward from it. Use `messages` if you need backlog before that point.
- With `cursor`, the call returns changes after it in `sequence` order. Read until
  `hasMore: false`.
- Persist `nextCursor` only after your own processing has committed. Re-reading from an older
  cursor is safe, because merging by `id` and `revision` makes it idempotent.

### `POST /platform/v2/conversations/{id}/messages`

Sends a text message. Requires a `send` grant. Image sends are not available on v2 yet.

```http
POST /platform/v2/conversations/{id}/messages
Authorization: Bearer <key>
Idempotency-Key: digest:2026-11-28:conv_123
Content-Type: application/json

{ "content": { "kind": "text", "text": "Daily summary" }, "requestedBy": "agent:digest" }
```

- `Idempotency-Key` is required, 1–256 characters, and unique per logical send within your
  tenant. It shares one namespace with the v1 `requestId`.
- `requestedBy` is optional and only attributes the send. When omitted it defaults to the
  calling key.
- Retrying with the same key and identical body returns the existing send in its current state.
  The same key with a different conversation, text, mentions or `requestedBy` returns 409
  `conflict`. Never switch to a new key to retry a lost response, because that can send twice.
- `mentions: { identityIds?: string[], all?: boolean }` is accepted only when the account has the
  `send_mentions` capability. Otherwise the call returns 400.

The response is an `OutboundSend`, the same shape as below.

### `GET /platform/v2/outbound-sends/{id}`

```ts
type OutboundSend = {
	id: string
	conversationId: string
	status: 'queued' | 'processing' | 'accepted' | 'failed' | 'indeterminate'
	attemptCount: number
	error: string | null
	reflectedMessageId: string | null
	createdAtMs: number
	updatedAtMs: number
}
```

Only your own tenant's sends are visible. Others return 404.

- `accepted` means the channel accepted the invocation. It is not a delivery or read receipt.
- `indeterminate` means the send may have happened. Do not resend it automatically.
- `reflectedMessageId`, once set, links to the observed outgoing `Message`.

### `GET /platform/v2/events?conversationId=` (SSE)

A content-free doorbell. It tells you which conversation changed, not what changed.

```text
id: evt_...
event: conversation.updated
data: {"version":2,"type":"conversation.updated","eventId":"evt_...","conversationId":"conv_...","reasons":["message"],"createdAtMs":1795840786648}
```

- `reasons` is a de-duplicated subset of `message`, `retraction` and `attachment`. Events for one
  conversation coalesce, so treat each event as "read `changes` for this conversation" and never
  count events.
- `conversationId` is optional and repeatable; comma-separated values are also accepted. It
  narrows the stream to those conversations. Only conversations you can read are delivered.
  Grant changes take effect within about 5 minutes.
- On reconnect, send `Last-Event-ID` (or `?lastEventId=`). Events from the last 24 hours, up to
  1000, are replayed. Beyond that window each conversation's latest event is replayed instead.
- The server sends `retry: 3000`, a comment keepalive every 25 seconds, and closes the stream
  after 1 hour. Reconnect when it closes.
- The doorbell is a hint, not a delivery guarantee. Correctness comes from the `changes` cursor.
  After any gap, read `changes` from your saved cursor.

## Recommended consumer loop

1. Call `GET /accounts` and `GET /conversations`. For each conversation, call `GET .../changes`
   without a cursor and store the tail cursor. Backfill with `messages` if you need it.
2. Open `GET /events`. On each event, or on a periodic sweep as a fallback, read
   `.../changes?cursor=<saved>` until `hasMore` is false. Merge messages by `id` and `revision`,
   then save `nextCursor`.
3. On `message.attachment_ready` or an expired media URL, fetch `.../messages/{messageId}`.
4. Send with a stable `Idempotency-Key`. Poll `GET /outbound-sends/{id}` until the status is
   terminal, and do not auto-retry `indeterminate`.
