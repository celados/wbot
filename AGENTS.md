---
type: Reference
---

# Wbot

公开分发的 WeChat Agent 客户端：单一 `wbot` CLI 支持读取与文本发送，MCP runtime 及 Codex / Claude plugins 保持只读。私有 Switchboard 后端留在其自己的仓库。

## 公开合同

- 修改 CLI、MCP、配置或响应语义前读 [package README](packages/wbot/README.md)；版本与兼容性变化读 [GLOSSARY.md](GLOSSARY.md) 和 [兼容性 ADR](docs/adr/0001-versioning-and-platform-compatibility.md)。
- wbot Release Version 统一 package、CLI、MCP、plugins、tag 和产物；Platform API Major 独立演进。同一 API major 保持向后兼容。
- 成功 HTTP 响应不符合协议时报告 Platform Contract Error，与传输错误、业务错误区分。
- 保留服务端提供的 capability 与 capture freshness 语义；安静会话不等于采集及时，客户端不暴露私有 operator diagnostics。
- CLI / MCP 使用 HTTP Actions origin；测试显式设置 `WBOT_PLATFORM_URL`。具体地址见根 [README.md](README.md)，Convex API/WebSocket origin 不能用作 CLI base URL。
- CLI 发送要求调用方提供稳定 `requestId`；只提交一次请求，以 `outbound-sends.get` 查询结果。`accepted` 不是送达回执，`indeterminate` 不得自动重发。

## 验证与发布

- 使用 Bun 与 `package.json` scripts，按改动运行检查与测试；分发、入口或打包变更运行 `bun run verify:package`。
- 发布前读 [releasing.md](docs/releasing.md)，完成其中的产物与 Platform 兼容性验证。
- `main` 上修改 `packages/wbot/package.json` 的版本会触发公开 release；仅在发布任务中升级版本，已发布 tag / 产物保持不可变。
