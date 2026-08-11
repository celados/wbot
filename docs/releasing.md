---
type: Playbook
title: Release and compatibility policy
description: SemVer, changelog, Platform compatibility, and verification rules for wbot releases.
when: Preparing or reviewing a wbot client release or a Platform contract change.
status: accepted # draft | accepted | superseded
generated: { by: codex/gpt-5, at: "2026-08-11T11:31:16+08:00" }
---

# Release and compatibility policy

This playbook implements [ADR-0001](./adr/0001-versioning-and-platform-compatibility.md). The wbot
repository enforces its client-side gates; the candidate-backend gate remains owned and implemented
in the separate Switchboard repository.

## Version identities

`packages/wbot/package.json#version` is the single source of the wbot Release Version. The following
must report or pin exactly that version:

- package metadata and packaged filename;
- `wbot --version`;
- the MCP server handshake;
- Codex and Claude Plugin manifests and their runtime artifact URLs;
- Git tag `v<version>` and immutable release assets.

The Platform API Major is a separate identity encoded in the HTTP path. A wbot release does not
imply an API-major change, and a compatible backend deployment does not imply a wbot release.

## Public contract

The wbot Public Contract includes:

- installation artifact names, contents, checksums, and runtime requirements;
- executable names, commands, inputs, stdout JSON, stderr, exit behavior, and `@schema` output;
- MCP server identity, tools, schemas, annotations, structured results, and error behavior;
- configuration names, precedence, credential storage, and default hosted endpoint;
- exported TypeScript client and result types;
- Platform paths, authentication, error codes, cursors, result shapes, and existing field semantics;
- Codex and Claude Plugin entrypoints and manifests.

Internal refactors that preserve these observations are not public-contract changes.

## SemVer before 1.0.0

Use a patch increment for compatible additions and fixes. Use a minor increment for any incompatible
change to the wbot Public Contract. Do not hide a breaking change in a patch merely because SemVer
allows instability before `1.0.0`.

Adding an optional response field is compatible for existing clients. Adding a required property to
an exported TypeScript result type is breaking for consumers that construct or narrow that type and
therefore requires a minor increment before `1.0.0`.

Compatible patches may publish as stable releases after all gates pass. A breaking minor first uses
`0.Y.0-rc.N` against the test Platform; publish the stable version only after dogfood and both sides
of the compatibility matrix pass.

## Platform API compatibility

An active Platform API Major is additive-only. Existing fields and operations may not be removed,
renamed, narrowed, or assigned incompatible semantics in place. A change that cannot preserve the
existing contract requires a new path such as `/platform/v2`.

Unknown response fields are valid compatible additions. wbot response validators must ignore or
preserve them rather than reject the response. Known required fields, discriminated unions, cursors,
and error envelopes are validated at the HTTP boundary. A successful HTTP response that violates
those requirements fails closed with `PlatformContractError` and stable machine code
`invalid_platform_response`. Diagnostics may identify the endpoint and failing field paths, but must
not contain API keys, message content, or complete response payloads.

The wire contract applies to any conformant Platform implementation selected through
`WBOT_PLATFORM_URL`. Celados operational commitments, including the deprecation period, apply only
to Celados-hosted endpoints; self-hosted operators own their deployment upgrades.

## Deprecation and sunset

Before retiring a Celados-hosted Platform API Major:

1. publish a stable successor client and migration guide;
2. announce a sunset date at least 90 days ahead in the package changelog, GitHub Release, and
   public documentation;
3. return standard `Deprecation`, `Sunset`, and migration `Link` headers;
4. surface one warning on CLI or MCP stderr without contaminating JSON or MCP stdout;
5. keep the old major compatible until the sunset date.

A security, legal, or provider emergency may shorten the period. The exception and resulting
migration action must still be documented explicitly.

## Changelog

The canonical changelog lives at `packages/wbot/CHANGELOG.md`, is included in the packaged artifact,
and contains `Unreleased` plus one section for every published version, including the backfilled
`0.1.0`, `0.1.1`, and `0.1.2` history.

Each version section uses only the categories that apply:

- Breaking Changes;
- Added;
- Changed;
- Fixed;
- Migration.

Every version change must have an exactly matching changelog section. GitHub Release notes use that
section as their curated body and may append a compare link; automatically generated commit lists do
not replace the changelog.

## Verification ownership

The repository changing one side of the client/backend seam owns the corresponding compatibility
proof:

- wbot release CI runs the candidate artifact against the current test Platform;
- Switchboard backend deployment CI runs the current immutable published artifact against the
  candidate backend;
- both use contract fixtures that cover every public operation, success result, stable error shape,
  cursor direction, and MCP projection affected by the change.

The wbot release gate also verifies version equality across all release surfaces, changelog presence,
artifact contents, immutable tag and asset semantics, checksums, local tests, and tokenless install.
No version is stable merely because packaging succeeded.
