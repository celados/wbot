# wbot

wbot is an Agent-first, read-only interface to authorized WeChat conversations. This public repository owns the `wbot` CLI, the `wbot-mcp` runtime, and the Codex and Claude Code plugins. The private Switchboard backend remains outside this repository.

## Install

Install [Bun](https://bun.sh), then install the latest verified GitHub Release artifact:

```sh
bun add --global "@celados/wbot@https://github.com/celados/wbot/releases/latest/download/wbot.tgz"
wbot auth set
wbot @schema
```

See [the package README](packages/wbot/README.md) for CLI, MCP, credential, and cursor semantics.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run verify:package
```

Changing `packages/wbot/package.json` version on `main` creates an immutable tag and public GitHub Release after all gates pass.
