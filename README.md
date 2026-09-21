# wbot

wbot is an Agent-first interface to authorized WeChat conversations, with reading and text sending
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

For internal dogfood against the test deployment, explicitly select its HTTP Actions origin:

```sh
WBOT_PLATFORM_URL=https://wbot-api-test.celados.com \
  wbot conversations.list '{ "limit": 50 }'
```

See [the package README](packages/wbot/README.md) for CLI, MCP, credential, and cursor semantics, and
the package [changelog](packages/wbot/CHANGELOG.md) for release and migration notes.

Conversation results expose the Tenant's `read` and `send` capabilities. Conversation and message
update results also expose capture freshness, allowing Agents to distinguish quiet conversations
from delayed, unavailable, or insufficient capture evidence without accessing private operator
diagnostics.

The CLI also supports `wbot messages.send` and `wbot outbound-sends.get`. See
[text sending](packages/wbot/README.md#send-text-from-the-cli) for caller-owned idempotency and
send-result semantics. MCP and Plugin tools remain read-only.

## Public endpoints

The Agent CLI and MCP use the production HTTP Actions origin
`https://wbot-api-prod.celados.com`. `https://wbot-cloud-prod.celados.com` is
the separate Convex API/WebSocket origin for browser clients and is not a CLI
or MCP base URL. Internal test dogfood explicitly sets `WBOT_PLATFORM_URL` to
`https://wbot-api-test.celados.com`; no test-specific command is published.

## Development

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
