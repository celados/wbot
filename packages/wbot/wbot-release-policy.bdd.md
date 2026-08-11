---
type: Behavior Spec
title: wbot 发布版本与 Platform 兼容契约
description: 发布者以一个可验证版本交付 CLI、MCP 和 Plugins，并在后端演进时保护已安装客户端。
status: accepted # draft | accepted | superseded
---

# wbot 发布版本与 Platform 兼容契约 - BDD 规格

> 发布者可以从一次版本变更判断产物、变更说明和 Platform 是否彼此兼容；Agent 不会因后端静默漂移而读取错误数据。
> 状态：**已确认**

---

## 范围边界

**包含：**

- wbot package、CLI、MCP、Codex Plugin、Claude Plugin、Git tag 与发布产物共享一个版本
- `0.x` 版本的 compatible 与 breaking 分类
- package-owned changelog 和发布阻断条件
- Platform 成功响应的兼容验证与脱敏错误
- 候选客户端对当前 test Platform 的兼容证明
- API major 弃用警告不污染 Agent 协议输出

**不包含：**

- Switchboard 仓库中“当前已发布客户端对候选 backend”的部署 gate
- 自动部署或退役 `/platform/v1`
- npm registry 发布
- 提交、推送、创建 GitHub Release 或写入生产数据

## 功能 1：所有公开入口共享一个发布身份

**场景 1.1：发布者得到一致的版本产物**
Given 发布者准备一个新的 wbot 版本
When 发布者检查 package、CLI、MCP、两个 Plugins、Git tag 与压缩产物
Then 所有入口报告或固定到同一个版本
And 版本化产物名称包含该版本
And latest 安装产物与同一版本的不可变产物具有相同内容

**场景 1.2：任一入口版本漂移时阻止发布**
Given package、CLI、MCP、Plugin、tag 或产物中至少一个版本与其他入口不同
When 发布者执行发布检查
Then 发布被阻止
And 诊断指出发生漂移的入口
And 已有 tag 或产物不会被覆盖

## 功能 2：版本号表达公开契约影响

**场景 2.1：兼容变化使用 patch 版本**
Given 新版本只增加旧 Agent 可以忽略的能力或修复既有行为
When 发布者选择下一个稳定版本
Then 版本只递增 patch
And 不要求新的 Platform API Major

**场景 2.2：破坏性变化使用 minor 版本并先发布 RC**
Given 新版本删除、改名、收紧或改变既有公开行为
When 发布者准备 `0.x` 系列的下一个版本
Then 版本递增 minor
And 首个公开候选版本使用 `-rc.1`
And 稳定版等待 test dogfood 与兼容检查通过

**场景 2.3：公开结果增加必填属性属于破坏性变化**
Given 新版本为公开 TypeScript 结果增加调用方必须提供或处理的属性
When 发布者分类该变化
Then 该变化被分类为 breaking
And 不允许隐藏在 patch 版本中

## 版本分类真值表

| 变化                                      | `0.x` 版本级别 | 需要 RC | 需要新 API Major |
| ----------------------------------------- | -------------- | ------- | ---------------- |
| 内部重构且外部行为不变                    | 不发布或 patch | 否      | 否               |
| 修复既有行为                              | patch          | 否      | 否               |
| 增加旧客户端可忽略的可选响应字段          | patch          | 否      | 否               |
| 增加公开结果的必填 TypeScript 属性        | minor          | 是      | 否               |
| 删除或改变活跃 API Major 的既有 wire 语义 | minor          | 是      | 是               |

## 功能 3：每个发布版本都有可迁移的变更记录

**场景 3.1：版本变化必须存在同名 changelog 章节**
Given package 版本相对上一版本发生变化
When 发布者执行发布检查
Then changelog 存在完全匹配的新版本章节
And 章节说明适用的 Breaking Changes、Added、Changed、Fixed 或 Migration 内容
And GitHub 自动生成的 commit 列表不能代替该章节

**场景 3.2：安装产物携带完整版本历史**
Given 发布者构建安装产物
When 用户检查产物内容
Then 产物包含 changelog
And changelog 包含 `0.1.0`、`0.1.1`、`0.1.2` 与当前版本

## 功能 4：Agent 只接收符合契约的 Platform 结果

**场景 4.1：未知新增字段不会破坏旧客户端**
Given Platform 返回所有已知必填数据
And 响应额外包含旧客户端不认识的字段
When Agent 通过 wbot 读取数据
Then Agent 得到正常的结构化结果
And 未知字段不会被误判为契约错误

**场景 4.2：已知必填数据损坏时明确失败**
Given Platform 返回成功 HTTP 状态
And 响应缺少已知必填数据或包含无效联合类型
When Agent 通过 wbot 读取数据
Then 请求以 `invalid_platform_response` 失败
And 错误与认证、授权、网络或 Platform 业务错误保持可区分

**场景 4.3：契约错误诊断不泄漏敏感内容**
Given Platform 的成功响应不符合当前契约
When wbot 生成失败诊断
Then 诊断可以指出 endpoint 与失败字段路径
And 诊断不包含 API Key、消息内容或完整响应 payload

**场景 4.4：Platform 业务错误保持原有错误语义**
Given Platform 返回稳定的非成功错误 envelope
When Agent 通过 wbot 发起读取
Then Agent 得到对应的 Platform 错误码与可操作消息
And 该错误不会被改写为 `invalid_platform_response`

## 功能 5：API 弃用信息对人和 Agent 都可见

**场景 5.1：弃用警告不污染 CLI JSON**
Given Celados 托管 Platform 已公告当前 API Major 的 sunset
And 响应携带弃用日期、sunset 日期与迁移链接
When Agent 通过 CLI 成功读取数据
Then stdout 仍只包含一个有效 JSON 结果
And stderr 只输出一次包含 sunset 日期与迁移链接的警告

**场景 5.2：MCP 弃用警告不破坏协议**
Given Celados 托管 Platform 已公告当前 API Major 的 sunset
When MCP host 使用 wbot 完成读取
Then MCP structured result 保持不变
And 警告不会写入 MCP stdout 协议帧

**场景 5.3：自托管 origin 不获得 Celados 在线期限承诺**
Given 用户显式选择一个符合当前 API Major 的自托管 origin
When 用户阅读兼容与弃用政策
Then wire contract 与 Celados 托管服务相同
And 部署升级与在线期限由自托管 operator 负责

## 功能 6：稳定发布具有当前后端兼容证据

**场景 6.1：候选客户端通过当前 test Platform 后才能稳定发布**
Given 候选 wbot artifact 已通过离线测试与打包验证
When 发布流程准备把候选版本标记为稳定版
Then 同一不可变 artifact 必须通过当前 test Platform 的公开读取契约
And 缺少凭据、服务不可达或契约不匹配都会阻止稳定发布

**场景 6.2：只完成打包不能证明版本稳定**
Given 候选 artifact 可以安装并输出 CLI schema
And 尚未取得当前 test Platform 的兼容证据
When 发布者检查发布状态
Then 版本仍不能标记为稳定
And 发布状态明确指出缺少的兼容 gate
