# Changelog

All notable changes to the public wbot client are documented in this file.

## Unreleased

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
