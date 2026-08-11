---
type: ADR
title: Separate wbot releases from Platform API compatibility
description: Why wbot uses independent client SemVer and additive Platform API majors.
status: accepted # proposed | accepted | deprecated | superseded
generated: { by: codex/gpt-5, at: "2026-08-11T11:31:16+08:00" }
---

# Separate wbot releases from Platform API compatibility

wbot is a publicly distributed client whose installed releases and hosted Platform deployments
have independent lifecycles. The `wbot Release Version` is therefore one SemVer shared by the
package, CLI, MCP server, Codex and Claude plugins, Git tag, and release artifacts, while the
`Platform API Major` remains independently identified by paths such as `/platform/v1`.

Before `1.0.0`, a compatible wbot change increments patch and any incompatible change to the wbot
Public Contract increments minor. An active Platform API Major evolves only through compatible
additions; removal, renaming, input narrowing, or changed existing semantics requires a new major.
Celados may retire an old hosted major only after an announced migration period of at least 90
days, except when a security, legal, or provider emergency makes that impossible.

The alternatives were lockstep client and backend versions, in-place mutation of `/platform/v1`,
and independently versioned Plugin wrappers. They were rejected because they either couple
unrelated deployment lifecycles, silently break installed clients, or create version drift without
an independent Plugin release lifecycle.

## Consequences

- Breaking pre-1.0 releases use a prerelease such as `0.2.0-rc.1` for test dogfood before the stable
  release; compatible patches may publish directly after their gates pass.
- wbot validates successful responses at the HTTP boundary, tolerates unknown additive fields, and
  raises a sanitized Platform Contract Error when known requirements are violated.
- wbot release CI proves the candidate client against the current test Platform; Switchboard deploy
  CI proves the current published client against the candidate backend.
- GitHub release notes are curated from the package changelog rather than treated as a substitute
  for it.
