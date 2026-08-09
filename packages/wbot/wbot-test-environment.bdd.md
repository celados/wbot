---
type: Behavior Spec
title: Agent 通过 wbot-test 访问测试环境签发的 API Key
description: Dogfood Agent 使用明确的测试入口访问测试 deployment，其他 CLI 与认证行为保持不变。
status: accepted # draft | accepted | superseded
---

# Agent 通过 wbot-test 访问测试环境签发的 API Key - BDD 规格

> `wbot-test` 只是 `@celados/wbot` package 内改变默认 endpoint 的临时 dogfood 入口。
> API Key 格式、凭据读取、只读工具和结果语义都与 `wbot` 相同。
> 状态：**已确认**

---

## 范围边界

**包含：**

- 同一个 package 提供 production 与 test 两组入口
- test 入口默认连接 wbot 测试服务
- 两组入口复用现有 API Key 配置规则和只读能力

**不包含：**

- 新建 `@celados/wbot-test` package
- 新增 API Key 类型、权限模型、后端 schema 或认证流程
- 新增 test 专用环境变量或凭据文件
- 在 production 接受 test deployment 签发的 API Key
- 改变会话、消息、分页或游标语义

## 功能 1：Agent 连接签发 API Key 的对应环境

**场景 1.1：测试入口默认连接测试服务**
Given 用户已经安装 `@celados/wbot`
And 用户提供由测试环境签发的 API Key
When Agent 通过 `wbot-test` 发起只读请求
Then 请求发送到 `https://wbot-api-test.celados.com`
And Agent 不需要另外配置 Platform URL

**场景 1.2：正式入口继续连接生产服务**
Given 用户已经安装 `@celados/wbot`
And 用户提供由生产环境签发的 API Key
When Agent 通过 `wbot` 发起只读请求
Then 请求发送到 `https://wbot-api-prod.celados.com`
And `wbot-test` 不改变正式入口的默认行为

**场景 1.3：测试入口复用现有凭据规则**
Given 用户通过现有本地配置或 `WBOT_API_KEY` 提供 API Key
When Agent 通过 `wbot-test` 或 `wbot-test-mcp` 发起读取
Then 工具按照与正式入口相同的优先级读取 API Key
And 不要求 test 专用环境变量或第二份凭据文件

**场景 1.4：环境与 API Key 不匹配时明确失败**
Given 用户提供的 API Key 由另一个 deployment 签发
When Agent 向当前入口发起读取
Then Agent 得到稳定的认证错误
And 错误不泄漏完整 API Key

## 功能 2：测试入口不复制产品能力

**场景 2.1：一个 package 同时提供正式和测试入口**
Given 用户需要验证测试环境
When 用户安装 Agent 工具
Then 用户只安装 `@celados/wbot`
And 同一个安装产物提供 `wbot`、`wbot-mcp`、`wbot-test` 和 `wbot-test-mcp`

**场景 2.2：测试 CLI 与正式 CLI 暴露相同命令**
Given Agent 查看 `wbot` 与 `wbot-test` 的 schema
When Agent 比较两个入口
Then 两个入口暴露相同的只读命令和输入结构
And 唯一默认差异是目标环境

**场景 2.3：测试 MCP 与正式 MCP 暴露相同工具**
Given MCP host 分别启动 `wbot-mcp` 与 `wbot-test-mcp`
When Agent 查询两个 server 的工具
Then 两个 server 暴露相同的三个只读工具
And 授权、分页、游标和错误语义保持一致

## 环境选择真值表

| 入口            | 默认服务                    | API Key 来源                  |
| --------------- | --------------------------- | ----------------------------- |
| `wbot`          | `wbot-api-prod.celados.com` | 现有本地配置或 `WBOT_API_KEY` |
| `wbot-mcp`      | `wbot-api-prod.celados.com` | 现有本地配置或 `WBOT_API_KEY` |
| `wbot-test`     | `wbot-api-test.celados.com` | 现有本地配置或 `WBOT_API_KEY` |
| `wbot-test-mcp` | `wbot-api-test.celados.com` | 现有本地配置或 `WBOT_API_KEY` |
