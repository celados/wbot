---
type: Behavior Spec
title: Agent 只通过一个 wbot 命令使用 CLI 与 MCP
description: 外部用户只看到一个公开命令，生产环境是默认值，测试环境由内部运行配置显式选择。
status: accepted # draft | accepted | superseded
---

# Agent 只通过一个 wbot 命令使用 CLI 与 MCP - BDD 规格

> `wbot` 是 `@celados/wbot` 唯一公开的可执行命令。
> CLI 与 MCP 共享认证和只读能力；测试环境属于内部 dogfood 配置，不成为外部产品概念。
> 状态：**已确认**

---

## 范围边界

**包含：**

- 一个 package 只提供一个公开命令
- Agent 通过 `wbot` 使用只读 CLI，通过 `wbot mcp` 启动 MCP
- production 是默认服务，内部 dogfood 可以显式指定 test 服务
- Codex 与 Claude Code Plugin 使用同一个公开命令启动 MCP

**不包含：**

- 新建测试专用 package、命令、环境变量或凭据文件
- 新增 API Key 类型、权限模型、后端 schema 或认证流程
- 改变会话、消息、分页、游标或 MCP tool 语义
- 让 production 接受 test deployment 签发的 API Key

## 功能 1：外部用户只看到一个产品入口

**场景 1.1：安装产物只提供 wbot 命令**
Given 用户安装 `@celados/wbot`
When 用户检查安装后可执行的命令
Then 安装产物只提供 `wbot`
And 不提供 production、test 或 MCP 专用的平行命令

**场景 1.2：Agent 通过 wbot 使用只读 CLI**
Given Agent 已安装 `@celados/wbot`
When Agent 查看 `wbot` 的命令规格
Then Agent 看到现有会话与消息读取命令
And Agent 看到启动 MCP 的 `mcp` 子命令
And Agent 看不到发送或管理命令

**场景 1.3：MCP host 通过 wbot mcp 启动服务**
Given MCP host 已安装 `@celados/wbot`
When MCP host 运行 `wbot mcp`
Then Agent 看到现有三个只读 MCP tools
And tool 的授权、分页、游标和错误语义保持不变

## 功能 2：环境选择不扩张公开命令面

**场景 2.1：默认连接生产服务**
Given Agent 提供 production 签发的 API Key
And Agent 没有显式指定服务地址
When Agent 通过 `wbot` 发起读取
Then 请求发送到 `https://wbot-api-prod.celados.com`

**场景 2.2：内部 dogfood 显式连接测试服务**
Given Agent 提供 test deployment 签发的 API Key
And 内部运行环境将 `WBOT_PLATFORM_URL` 设为 `https://wbot-api-test.celados.com`
When Agent 通过 `wbot` 或 `wbot mcp` 发起读取
Then 请求发送到测试服务
And Agent 继续复用 `WBOT_API_KEY` 或现有本地凭据

**场景 2.3：环境与 API Key 不匹配时明确失败**
Given 用户提供的 API Key 由另一个 deployment 签发
When Agent 向当前服务发起读取
Then Agent 得到稳定的认证错误
And 错误不泄漏完整 API Key

## 功能 3：Plugin 复用公开入口

**场景 3.1：Codex 与 Claude Code Plugin 启动同一个 MCP 入口**
Given 用户安装 wbot Plugin
When Codex 或 Claude Code 启动 wbot MCP server
Then Plugin 运行 `wbot mcp`
And Plugin 配置不携带 API Key、secret 或 token

## 环境选择真值表

| 调用方式   | 未设置 `WBOT_PLATFORM_URL`  | 显式设置 `WBOT_PLATFORM_URL` | API Key 来源                  |
| ---------- | --------------------------- | ---------------------------- | ----------------------------- |
| `wbot`     | `wbot-api-prod.celados.com` | 使用显式地址                 | 现有本地配置或 `WBOT_API_KEY` |
| `wbot mcp` | `wbot-api-prod.celados.com` | 使用显式地址                 | 现有本地配置或 `WBOT_API_KEY` |
