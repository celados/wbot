---
type: Reference
title: wbot-digest 集成后端
description: 独立的 US East Convex 开发部署，作为每日群聊摘要集成的运行环境。
status: provisioned
---

# wbot-digest

代码位于 wbot 仓库的 `integrations/digest`，使用独立 Convex 项目和开发部署。
日报业务、定时任务及消息发送尚未接入。

## 云资源

| 配置         | 值                                        |
| ------------ | ----------------------------------------- |
| Team         | `celados-llc`（493669）                   |
| Project      | `wbot-digest`（3040004）                  |
| Deployment   | `third-cat-939`                           |
| Environment  | Development，当前用户的默认开发部署       |
| Reference    | `dev/integration`                         |
| Region       | US East / North Virginia，`aws-us-east-1` |
| Convex API   | `https://third-cat-939.convex.cloud`      |
| HTTP Actions | `https://third-cat-939.convex.site`       |

[Convex 控制台](https://dashboard.convex.dev/t/celados-llc/wbot-digest/third-cat-939)

2026-09-21 经 Convex management API 回读确认项目、部署及美国区配置；通过已认证的
`convex data` 查询验证数据库可访问，当前没有业务表。HTTP Actions 地址尚未部署业务路由。

## 开发

```sh
# 从 wbot 仓库根目录执行
bun install --frozen-lockfile
bun run digest:dev
```

CLI 已在本地 `integrations/digest/.env.local` 写入此开发部署的选择和端点；该文件被 Git 忽略。
部署选择器为 `celados-llc:wbot-digest:dev/integration`。当前没有生产部署。

新 checkout 可以将本目录的 `.env.example` 复制为 `.env.local`，再使用有权访问此项目的
Convex 账号运行命令。其他团队应替换为自己的独立部署。

根目录的 `digest:dev`、`digest:push` 和 `digest:dashboard` 都在本目录执行 Convex CLI，
确保读取集成自己的配置。依赖使用根目录统一的 `bun.lock`；本目录不维护独立 lockfile。

## 责任边界

日报集成负责调度、读取进度、摘要生成与保存，以及发起发送和跟踪结果。
Switchboard 继续负责消息采集、授权、消息查询及发送执行。集成使用普通 Tenant API Key
调用公开 Platform HTTP 接口，不读取 Switchboard 内部表或调用其内部函数。

目前没有配置 Switchboard 或模型服务凭证，没有启动调度或发送消息。
后续 secrets 通过 workspace 的 `.env.tpl` 与 latch 约定管理。

公开 wbot CLI 支持文本发送和结果查询，MCP 保持只读；日报可通过 CLI 或 Platform HTTP 接口发送。

## 仓库与发布

集成属于 wbot Git 仓库和 Bun workspace，没有嵌套 Git 仓库或独立 workspace registry entry。
`@celados/wbot-digest` 标记为 private；CLI 产物只打包 `packages/wbot` 的明确文件清单，
不包含此集成、Convex 依赖或本地环境配置。目录迁移不改变云端部署和数据。

API Key、实际群聊配置和摘要内容必须留在本地被忽略的文件或独立后端，不能提交到公开仓库。
