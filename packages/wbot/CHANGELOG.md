# Changelog

All notable changes to the public wbot client are documented in this file.

## Unreleased

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
