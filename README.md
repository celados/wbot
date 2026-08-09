# wbot

wbot is an Agent-first, read-only interface to authorized WeChat conversations. This public repository owns the single `wbot` command, its MCP runtime, and the Codex and Claude Code plugins. The private Switchboard backend remains outside this repository.

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

See [the package README](packages/wbot/README.md) for CLI, MCP, credential, and cursor semantics.

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
