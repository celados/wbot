# wbot

wbot is an Agent-first, read-only interface to authorized WeChat conversations. This public repository owns the `wbot` CLI, the `wbot-mcp` runtime, and the Codex and Claude Code plugins. The private Switchboard backend remains outside this repository.

## Install

Install [Bun](https://bun.sh), then install the latest verified GitHub Release artifact:

```sh
bun add --global "@celados/wbot@https://github.com/celados/wbot/releases/latest/download/wbot.tgz"
wbot auth set
wbot @schema
```

For the current test deployment, use the aliases from the same package:

```sh
wbot-test auth set
wbot-test conversations.list '{ "limit": 50 }'
```

See [the package README](packages/wbot/README.md) for CLI, MCP, credential, and cursor semantics.

## Public endpoints

The Agent CLI and MCP use the production HTTP Actions origin
`https://wbot-api-prod.celados.com`. `https://wbot-cloud-prod.celados.com` is
the separate Convex API/WebSocket origin for browser clients and is not a CLI
or MCP base URL. Test uses the matching `wbot-api-test.celados.com` and
`wbot-cloud-test.celados.com` pair. `wbot-test` and `wbot-test-mcp` select the
test HTTP Actions origin while reusing the same API key and read-only behavior.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run verify:package
```

Changing `packages/wbot/package.json` version on `main` creates an immutable tag and public GitHub Release after all gates pass.
