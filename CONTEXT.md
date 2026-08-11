---
type: Glossary
title: wbot domain language
description: Canonical language for wbot releases and Platform compatibility.
generated: { by: codex/gpt-5, at: "2026-08-11T11:31:16+08:00" }
---

# wbot

wbot is a publicly distributed Agent client for reading authorized conversations through a
versioned Platform API.

## Language

**wbot Release Version**:
The SemVer identity of one published wbot client release, shared by its package, CLI, MCP server,
Codex and Claude plugins, Git tag, and release artifacts.
_Avoid_: Package version, CLI version, MCP version

**Platform API Major**:
The independently versioned major contract of the hosted Platform API, identified by a path such
as `/platform/v1`. An active major evolves only through compatible additions; incompatible changes
require a new major, and retiring an old major requires an announced migration window.
_Avoid_: Backend version, deployment version, wbot version

**wbot Public Contract**:
The externally observable behavior shared by wbot releases, including installation artifacts, CLI
and MCP behavior, Plugin entrypoints, configuration, exported types, and Platform response semantics.
_Avoid_: Package API, CLI contract, MCP contract

**Platform Contract Error**:
A client-side failure proving that a successful Platform HTTP response does not conform to the
active Platform API Major; it is distinct from transport and Platform business errors.
_Avoid_: Internal error, parse error, request error

**Platform API Deprecation**:
The announced migration period before Celados retires a hosted Platform API Major, lasting at least
90 days unless a security, legal, or provider emergency requires a shorter period.
_Avoid_: Field removal, client release, backend deployment
