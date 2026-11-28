# wbot

wbot is an Agent-first interface to authorized WeChat conversations, with reading and text/JPEG sending
in the CLI and read-only MCP tools. This public repository owns the single `wbot` command, its MCP
runtime, and the Codex and Claude Code plugins. The private Switchboard backend remains outside this repository.

Web viewer (test): [wbot-web-test.celados.com](https://wbot-web-test.celados.com/).

## Install

Install [Bun](https://bun.sh), then install the latest verified GitHub Release artifact:

```sh
bun add --global "@celados/wbot@https://github.com/celados/wbot/releases/latest/download/wbot.tgz"
wbot auth set
wbot @schema
```

The CLI connects to `https://wbot-api-test.celados.com` by default; set `WBOT_PLATFORM_URL` only to
select another conformant Platform:

```sh
wbot accounts.list
wbot conversations.list
```

See [the package README](packages/wbot/README.md) for CLI, MCP, credential, and cursor semantics, and
the package [changelog](packages/wbot/CHANGELOG.md) for release and migration notes.

Conversation results expose the Tenant's `read` and `send` capabilities. `accounts.list` exposes
capture freshness per account, allowing Agents to distinguish quiet conversations from delayed,
unavailable, or insufficient capture evidence without accessing private operator diagnostics.

The CLI also supports `wbot messages.send` and `wbot outbound-sends.get`. See
[text sending](packages/wbot/README.md#send-text-from-the-cli) for caller-owned idempotency and
send-result semantics. MCP and Plugin tools remain read-only.

## Public endpoints

The Agent CLI and MCP default to the HTTP Actions origin `https://wbot-api-test.celados.com`, which
serves `/platform/v2` and is where API keys are issued. `https://wbot-api-prod.celados.com` still
serves only `/platform/v1`, so current releases do not work against it. `wbot-cloud-test.celados.com`
and `wbot-cloud-prod.celados.com` are Convex API/WebSocket origins for browser clients and are not
CLI or MCP base URLs.

## Platform API v2

[docs/platform-v2.md](docs/platform-v2.md) documents `/platform/v2`: accounts, conversations, the
timeline, the per-conversation change log, text sends and the SSE doorbell. From 0.4.0-rc.3 the CLI
and MCP use v2 for every read and for text sends. JPEG image send and webhook management are not in
v2 yet and still call the frozen `/platform/v1`.

## Development

Development dependencies include `@celados/argc` from the private team registry `npm.celados.com`. Before `bun install`, write a gitignored `.npmrc` that maps `@celados` to that registry with the team token (template: `.npmrc.tpl` in `celados/argc`, rendered with `latch render`). CI does the same from the `NPM_TOKEN` secret. The release artifact is a bundle and needs no registry access.

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run verify:package
```

Changing `packages/wbot/package.json` version on `main` creates an immutable tag and public GitHub Release after all gates pass.

## Daily digest integration

[integrations/digest](integrations/digest/README.md) contains the daily group-chat digest integration
scaffold. It uses an independent Convex project and deployment, and accesses Switchboard through
the public Platform HTTP interface. Its code is maintained in this workspace and is excluded from
the CLI release artifact. Digest generation, scheduling, and sending are not implemented yet.

After configuring `integrations/digest/.env.local`, start development from the repository root:

```sh
bun run digest:dev
```

## Incoming-message notifications

The CLI can configure signed HTTPS webhooks and consume notifications through `messages.updates`.
See the [commands](packages/wbot/README.md#incoming-message-webhooks) and
[durable receiver example](examples/webhook). MCP remains read-only.
