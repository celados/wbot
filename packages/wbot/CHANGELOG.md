# Changelog

All notable changes to the public wbot client are documented in this file.

## Unreleased

## 0.4.0-rc.4 - 2026-11-28

### Breaking Changes

- Webhook management moves from the removed `/platform/v1/webhooks/*` RPCs to endpoint-level REST
  `/platform/v2/webhooks`. There is no v1 fallback.
- CLI webhook commands are replaced with `webhooks.create`, `webhooks.list`, `webhooks.get`,
  `webhooks.update`, `webhooks.retry`, and `webhooks.delete` (removing `webhooks.configure` and
  `webhooks.remove`). Operations now target a `webhookId` instead of a single `conversationId`.
- Exported client webhook methods change from `configureWebhook`, `listWebhooks`, `retryWebhook`,
  `removeWebhook` to `createWebhook`, `listWebhooks`, `getWebhook`, `updateWebhook`, `retryWebhook`,
  and `deleteWebhook`, returning `WebhookEndpointSummary` / `WebhookEndpointDetail`.
- Webhook delivery payloads move to v2 (`version: 2`, `type: "conversation.updated"`,
  `reasons: Array<'message' | 'retraction' | 'attachment'>`), identical to `GET /platform/v2/events`
  (SSE). All three change reasons now trigger webhook deliveries. `examples/webhook/verify.ts`
  rejects v1 payloads.

### Added

- Endpoint-level subscriptions: one webhook endpoint can watch all readable conversations
  (`conversationIds: null`) or an explicit allowlist of up to 100 conversations (up to 5 endpoints
  per tenant).
- `webhooks.get` for per-conversation delivery inspection (`deliveries[]`) and derived
  `summary.health` (`idle`, `healthy`, `degraded`, `failing`).
- `webhooks.update` for changing `url`, `conversationIds`, `status` (`active` / `disabled`), or
  rotating secrets via `rotateSecret` / `signingSecretEnv`.
- Multi-conversation SQLite checkpoint example in `examples/webhook/receiver.ts` using optional
  `WBOT_CONVERSATION_IDS`.

### Changed

- `verify-platform-compatibility` now exercises `GET /platform/v2/webhooks` via `webhooks.list`.
- Documentation updated to reflect public-network egress (`global_fetch_strictly_public` + HTTPS
  port 443 host validation) instead of IPv4-only DNS wording.

### Migration

- Replace `wbot webhooks.configure` with `wbot webhooks.create '{"url":"..."}'` (optionally passing
  `"conversationIds":[...]`), and replace `wbot webhooks.remove` with
  `wbot webhooks.delete '{"webhookId":"..."}'`.
- Update webhook receivers to accept `version: 2`, `type: "conversation.updated"`, and `reasons`
  (HMAC header names and `v1=` signature calculation are unchanged).
- Because all three change reasons trigger notifications and `messages.updates` includes outgoing
  messages, auto-reply consumers should continue filtering on `message.direction`.

## 0.4.0-rc.3 - 2026-11-28

### Breaking Changes

- The default Platform URL is now `https://wbot-api-test.celados.com`, where API keys are issued
  and `/platform/v2` is served. `https://wbot-api-prod.celados.com` still serves only
  `/platform/v1` and does not work with this release. `WBOT_PLATFORM_URL` remains an override.
- Reads and text sends move from `/platform/v1` to `/platform/v2`. There is no v1 fallback.
- `conversations.list` and MCP `list_conversations` take no input and return
  `{ items: Conversation[] }`, every readable conversation, newest activity first. `cursor`,
  `limit`, `nextCursor` and `hasMore` are gone. Conversations add `accountId` and
  `lastActivityAtMs`, `avatar` is always present, and `latestMessage` is a full `Message`.
- `captureFreshness` moves from conversations and updates pages to the new `accounts.list`, once
  per account, and `asOfMs` is a number.
- `messages.updates` and MCP `read_message_updates` read the per-conversation change log. Without
  `cursor` they return no items and a tail cursor (they no longer return a first page). Items are
  `{ sequence, kind, occurredAtMs, message }` with `kind` `message.created`, `message.retracted` or
  `message.attachment_ready`. Updates cursors from earlier releases are rejected; bootstrap again
  and use `messages.history` for backlog.
- `messages.history` returns `{ items, nextCursor, hasMore }` with `nextCursor` `null` on an empty
  page. History cursors from earlier releases are rejected.
- The message shape is the v2 `Message`: `id` replaces `messageId`; `occurredAtMs` and
  `file.sizeBytes` are numbers; `revision` is always present; retraction is
  `state: "retracted"` with `retractedAtMs` and `content: null` instead of the `retracted` content
  kind; quotes carry `state`; `nudge.target` and `group_invitation.members` move inside `content`
  (top-level `target` and `invitedMembers` are gone); identities always carry `avatar`; every
  message has `mentions`, `mentionsAll` and `mentionsSelf`, and own-Tenant outgoing messages carry
  `outboundSendId`. The latest-message `type`, `text` and `originalType` fields are gone.
- `messages.send` with `text` calls `POST /platform/v2/conversations/{id}/messages` with
  `requestId` as the `Idempotency-Key` header and returns the current outbound send
  `{ id, conversationId, status, attemptCount, error, reflectedMessageId, createdAtMs, updatedAtMs }`.
  A replay with the same `requestId` returns the send in its current state instead of always
  `queued`.
- `messages.send` with `imagePath` still uses `/platform/v1/messages/send` (no v2 image send yet) and
  returns `{ id, conversationId, status: "queued" }`; `outboundSendId` is renamed `id`.
- `outbound-sends.get` calls `GET /platform/v2/outbound-sends/{id}` and returns the outbound send
  shape above; `outboundSendId` in the result is renamed `id` (the input field keeps its name).
- `PlatformContractError.endpoint` is `<METHOD> <route template>`, for example
  `GET /platform/v2/conversations/{id}/changes`.
- The exported client replaces `queryConversations`, `queryMessageHistory`, `queryMessages` and
  `sendMessage` with `listAccounts`, `listConversations`, `listMessages`, `listChanges`,
  `getMessage`, `sendText` and `sendImage`.

### Added

- `accounts.list` and MCP `list_accounts`: accounts with adapter capabilities, self identity and
  capture freshness.
- `messages.get` and MCP `get_message`: one message with a freshly signed attachment URL.

### Changed

- Webhook management stays on `/platform/v1/webhooks/*` because v2 has no webhooks yet.
- The release compatibility gate also checks `accounts.list`, `messages.get`, and an updates
  bootstrap followed by a forward read.

### Migration

- Unset any `WBOT_PLATFORM_URL=https://wbot-api-test.celados.com` override, or keep it; both reach
  the same Platform.
- Re-bootstrap every saved updates cursor with `messages.updates` without `cursor`, then backfill
  from `messages.history` if needed.
- Merge messages by `id` and highest `revision`; treat `state: "retracted"` as a retraction.
- Read freshness from `accounts.list` and join conversations by `accountId`.
- Read the send ID from `id` in `messages.send` and `outbound-sends.get` results.

## 0.4.0-rc.2 - 2026-11-28

### Breaking Changes

- The argc 12 migration changes command discovery from the previous stable release.
  Use `wbot @schema messages.history` for a command signature,
  `wbot @schema 'messages.*'` for a group, and `wbot @search history` to search by intent.

### Changed

- Verify call-path schema selection and scoped search from the installed release bundle.

## 0.4.0-rc.1 - 2026-11-26

### Breaking Changes

- Upgrade to argc 12. Use call paths for `@schema`: `wbot @schema messages.history`
  shows one command and `wbot @schema 'messages.*'` lists the commands in a group.
  Use `wbot @search history` to find commands by keyword.

## 0.3.0-rc.2 - 2026-11-12

### Breaking Changes

- Update the CLI framework from `@celados/argc` 10.2 to 11.0. Breaking for callers that read `@schema`
  text: it is flat Markdown now. `## Commands` lists one `### <path>` block per command (for example
  `### messages.send`): the description, the input object `{ field: Type  // note }` with `= default`
  for defaulted fields, and no nested `wbot: { messages: { send(input: …) } }` type or `/** */`
  blocks. A namespace is `### messages.*`; the hidden `auth` group is still accessible by exact path. Command names, fields, results, MCP tools and the Platform API are unchanged.

## 0.3.0-rc.1 - 2026-11-12

### Breaking Changes

- Update the CLI framework from `@celados/argc` 8.0 to 10.2. Breaking for callers that read
  `@schema` text or branch on input error codes:
  - argc 9.0 removes the agent pipe guard: `wbot @skill`, `wbot @schema` and help are no longer
    refused with `OUTPUT_CAPTURED` when stdout is captured.
  - The whole input object may come from stdin (`wbot messages.send - <<'EOF' … EOF`) or a file
    (`wbot messages.send @send.yaml`) as YAML or JSON5, so multi-line `text` needs no escaping.
  - A malformed input is `error: BAD_INPUT` (with `source`, `format`, `line`/`col`) instead of
    `BAD_INPUT_JSON`.
  - `@schema` renders input-side types (fields with defaults are optional, e.g. `limit?: number`) and
    its `call:` frontmatter is a list that includes the heredoc form. The hidden `auth` group is no
    longer listed (argc 8.2 honours `hidden`); direct selection and `wbot auth set` still work.
  - Command names, fields, results, MCP tools and the Platform API are unchanged.

## 0.2.8 - 2026-11-06

### Changed

- Update the CLI framework to `@celados/argc` 8.0.0, which removes the `@run` builtin and `--json`.
  wbot never used either: commands, `@schema` output and the Public Contract are unchanged.

## 0.2.7 - 2026-11-04

### Changed

- Update the CLI framework to `@celados/argc` 7.12.0. When an agent captures stdout through a pipe or
  `$(…)`, `wbot @skill`, `wbot @schema` and bare help are refused with `error: OUTPUT_CAPTURED` and a
  runnable rewrite (run alone, or redirect to a file). Command output and the Public Contract are
  otherwise unchanged; no wbot command is marked whole-output.

## 0.2.6 - 2026-11-03

### Added

- The shared Platform client recognizes the `rate_limited` error code. On HTTP 429 it waits for
  `Retry-After` (falling back to the body `retryAfterMs`, at most 60 seconds) and retries the same
  request once; a second 429 raises `PlatformRequestError` with `code: "rate_limited"` and
  `retryAfterMs`. CLI and MCP both use this path. Other errors are still not retried.
- README documents the Platform rate limits: per key, list (`conversations.list`) 30/min, reads
  (`messages.updates`, `messages.history`, `outbound-sends.get`) 300/min, sends 60/min; the Tenant
  aggregate is three times the per-key limit and applies when a Tenant has more than three active keys.

### Changed

- 429 responses were previously reported as `internal_error` without retry.

### Migration

- Poll incrementally with `messages.updates` and the saved cursor, or use webhooks. Do not loop over
  `conversations.list`; `messages.history` is for looking back, not polling.
- `captureFreshness.status` is authoritative; `asOfMs` is a lower bound on the last successful
  scan (exact at status changes, otherwise refreshed at most every 10 minutes). Do not derive
  freshness from `asOfMs` yourself.

## 0.2.5 - 2026-11-02

### Added

- CLI `webhooks.configure`, `webhooks.list`, `webhooks.remove`, and `webhooks.retry` for incoming-message HTTPS notifications. Signing secrets are read from an environment variable and are never returned in command results.
- Typed webhook client methods and validated responses; the existing `PlatformClient` interface remains compatible.
- A Bun receiver example with HMAC verification, durable wake-ups, cursor recovery, and revision merging. Notifications wake `messages.updates`; they do not contain message bodies or replace cursors.

### Compatibility

- Existing reads, text/JPEG sends and the three read-only MCP tools are unchanged. Webhook configuration requires a current conversation read grant. Retractions and outgoing messages do not trigger notifications.

## 0.2.4 - 2026-10-31

### Added

- CLI `messages.send` accepts `imagePath` for JPEG files up to 5 MiB, mutually exclusive
  with `text`, and submits the Platform multipart image contract without exposing local paths.
- The shared Platform client supports typed image sends. Existing text JSON sends remain compatible.
- Bounded file reads, invalid-input checks, transport/error tests, and installed artifact image smoke tests.

### Migration

- Image sending requires a compatible Platform and an enabled Adapter image capability.
  The initial rollout is on the test Platform; CLI installation does not enable that capability.
- Caller-owned idempotency and no automatic retry/poll remain unchanged. MCP and Plugins stay read-only.

## 0.2.3 - 2026-10-24

### Changed

- The release artifact is a single Bun bundle (`dist/wbot.js`) with its runtime dependencies
  inlined. Installing it no longer resolves any dependency, including argc, which moved to a
  private registry; CLI and MCP behavior are unchanged.

## 0.2.2 - 2026-10-13

### Fixed

- CLI and MCP no longer reject an entire message page or conversation list when it contains a
  retracted message, a retracted quote, or a group invitation.
- Future message content kinds are returned as `unknown` with `originalKind` and `originalContent`,
  retaining every record and the server cursor. Future conversation preview types similarly use
  `unknown` with `originalType`. Malformed known types still report `invalid_platform_response`.

### Added

- Optional typed `revision`, `referenceId`, and `invitedMembers` response fields. For group
  invitations, `sender` is the inviter and `invitedMembers` identifies the invited members.

### Migration

- Upgrade, then retry the same failed cursor. Do not skip a record or reset a valid checkpoint.
- Merge repeated message IDs by `revision`; a retraction can update an older message. Old unsupported
  cursor versions still require a new bootstrap when the Platform explicitly reports that error.
- No credentials, consumer checkpoints, or server history are modified by this release.

## 0.2.1 - 2026-09-21

### Added

- Added CLI `messages.send` for authorized text sends with caller-owned `requestId`, and
  `outbound-sends.get` to query execution status and reflected message evidence.
- Validated required send inputs before requests and preserved Platform response validation,
  authentication, and idempotency behavior. The CLI does not automatically retry or poll.
- Kept MCP and Plugin tools read-only.

### Fixed

- Corrected the repository website to `https://wbot-web-test.celados.com/`.

### Migration

- Existing read commands and MCP tools are unchanged. Sending requires a `send` grant and explicit
  `conversationId`, `requestId`, `text`, and `requestedBy` fields. Save the returned `outboundSendId`
  and query it with `outbound-sends.get`; accepted invocation is not a delivery receipt.

## 0.2.0 - 2026-09-21

### Breaking Changes

- Replaced the legacy message `media` projection with the unified `attachment` projection used by
  the active Platform contract.
- Added required `capabilities` and `captureFreshness` properties to conversation results and a
  required `captureFreshness` property to message-update results.
- Added current `nudge`, conversation avatar, target identity, and attachment descriptor variants
  to the exported result types.

### Added

- Validated successful Platform responses at the HTTP boundary while tolerating unknown additive
  fields.
- Added the sanitized `PlatformContractError` with machine code `invalid_platform_response`.
- Surfaced Platform API deprecation and sunset metadata on stderr without contaminating CLI JSON or
  MCP protocol output.
- Added one release identity across the package, CLI, MCP server, Plugins, tags, and artifacts.
- Added curated changelog release notes and a stable-release compatibility gate against the current
  test Platform.

### Migration

- Read message binary state from `attachment` instead of `media`.
- Handle the required conversation capabilities and capture freshness fields, including empty
  message-update pages.
- Consumers upgrading from `0.1.x` must handle the result changes above.
- Consumers already using `0.2.0-rc.1` have no additional API migration steps.

## 0.2.0-rc.1 - 2026-08-11

### Breaking Changes

- Replaced the legacy message `media` projection with the unified `attachment` projection used by
  the active Platform contract.
- Added required `capabilities` and `captureFreshness` properties to conversation results and a
  required `captureFreshness` property to message-update results.
- Added current `nudge`, conversation avatar, target identity, and attachment descriptor variants
  to the exported result types.

### Added

- Validated successful Platform responses at the HTTP boundary while tolerating unknown additive
  fields.
- Added the sanitized `PlatformContractError` with machine code `invalid_platform_response`.
- Surfaced Platform API deprecation and sunset metadata on stderr without contaminating CLI JSON or
  MCP protocol output.
- Added one release identity across the package, CLI, MCP server, Plugins, tags, and artifacts.
- Added curated changelog release notes and a stable-release compatibility gate against the current
  test Platform.

### Migration

- Read message binary state from `attachment` instead of `media`.
- Handle the required conversation capabilities and capture freshness fields, including empty
  message-update pages.
- Dogfood this release candidate against the test Platform before promoting `0.2.0` to stable.

## 0.1.2 - 2026-08-09

### Fixed

- Published one `wbot` executable for CLI and MCP use and rejected the retired environment- and
  MCP-specific executable aliases during release verification.

## 0.1.1 - 2026-08-09

### Added

- Added explicit internal test-deployment configuration while keeping the hosted production API as
  the public default.

## 0.1.0 - 2026-08-09

### Added

- Published the initial read-only wbot CLI, MCP server, Codex Plugin, and Claude Code Plugin.
- Added conversation listing, bounded message history, caller-owned update cursors, and local API-key
  configuration.
