---
type: Behavior Spec
title: Agent 通过 wbot CLI 与 Plugin 只读微信会话
description: 外部 Agent 以同一套只读语义发现会话、读取历史并从显式游标继续读取新增消息。
status: accepted # draft | accepted | superseded
---

# Agent 通过 wbot CLI 与 Plugin 只读微信会话 - BDD 规格

> wbot 是面向 Agent 的外部产品名。CLI 是可长期依赖的一等接口，Codex 与 Claude Code Plugin
> 通过同一个 MCP runtime 提供等价能力。
> 状态：**已确认**

---

## 范围边界

**包含：**

- `wbot` Agent-first CLI 与稳定 JSON 结果
- Codex Plugin 与 Claude Code Plugin
- 列出获授权会话、向过去读取历史、从显式游标读取新增消息
- 会话能力与面向 Tenant 的采集新鲜度
- 一次性本地凭据配置、环境变量覆盖与敏感信息保护
- Caller-owned cursor 与无状态恢复

**不包含：**

- 发送消息、查询发送结果或任何禁用的写工具
- Tenant、Membership、Conversation Grant 或 API Key 的创建与管理
- 浏览器登录、OAuth device flow 或托管 Remote MCP
- Agent memory、自动回复策略、后台调度或 Platform 托管的消费进度
- 内部 Platform、Convex 模块或仓库的品牌迁移

## 功能 1：Agent 发现统一的 wbot 只读工具面

**场景 1.1：所有外部入口使用 wbot 品牌**
Given 外部用户安装面向 Agent 的工具
When 用户或 Agent 查看 package、命令、MCP server 与 Plugin 名称
Then 外部名称统一为 `wbot`
And CLI 命令为 `wbot`
And MCP runtime 通过 `wbot mcp` 启动
And 外部帮助与 schema 不要求用户理解内部 Switchboard 名称

**场景 1.2：CLI schema 只列出三个只读命令**
Given Agent 尚未执行业务请求
When Agent 查看 CLI schema
Then schema 列出会话列表、消息历史和消息更新三个命令
And 每个命令声明结构化输入与结果
And 查看 schema 不要求 API Key

**场景 1.3：MCP 只列出三个等价的只读工具**
Given Codex 或 Claude Code 已启用 wbot Plugin
When MCP client 查询可用工具
Then server 返回 `list_conversations`
And server 返回 `read_message_history`
And server 返回 `read_message_updates`
And 三个工具都声明为只读

**场景 1.4：第一版不向 Agent 暴露写能力**
Given Platform 内部已经具备发送相关能力
When Agent 查看 CLI schema 或 MCP 工具列表
Then Agent 看不到发送消息或查询发送结果的入口
And Agent 看不到 Operator、授权、凭据管理或派生知识写入入口

## 功能 2：用户一次配置凭据后，CLI 与 Plugin 安全复用

**场景 2.1：用户通过隐藏输入保存 API Key**
Given 用户已在网站创建一把 wbot API Key
When 用户在交互式终端运行 `wbot auth set`
Then CLI 以隐藏方式读取 API Key
And 设置了 `XDG_CONFIG_HOME` 时凭据保存在其 `wbot/credentials.json`
And 未设置时凭据保存在当前用户的 `.config/wbot/credentials.json`
And 凭据文件只允许当前用户读写
And CLI 不在成功输出中重复显示完整 API Key

**场景 2.2：API Key 不接受为命令参数**
Given 用户需要配置一把 wbot API Key
When 用户查看认证命令的 schema 或帮助
Then API Key 不作为命令参数出现
And 推荐流程不会把 API Key 写入 shell history

**场景 2.3：非交互调用不会等待隐藏输入**
Given Agent 在没有交互式终端的环境运行认证命令
When Agent 执行 `wbot auth set`
Then 命令立即失败而不是等待输入
And 错误指引自动化调用配置 `WBOT_API_KEY`

**场景 2.4：环境变量覆盖本地凭据**
Given 本地凭据文件已经保存一把 API Key
And 当前进程显式提供另一把 `WBOT_API_KEY`
When Agent 通过 CLI 或 MCP 发起读取
Then 本次调用使用环境变量中的 API Key
And 本地凭据文件保持不变

**场景 2.5：缺少凭据时在网络请求前失败**
Given 环境变量和本地凭据文件都没有可用 API Key
When Agent 通过 CLI 或 MCP 发起读取
Then 动作在发出网络请求前失败
And 错误指引用户运行 `wbot auth set` 或配置 `WBOT_API_KEY`
And 错误不伪装成空会话列表

**场景 2.6：损坏的凭据文件产生可恢复错误**
Given 本地凭据文件存在但无法解析或缺少有效 API Key
And 当前进程没有提供 `WBOT_API_KEY`
When Agent 通过 CLI 或 MCP 发起读取
Then 动作在发出网络请求前失败
And 错误指引用户重新运行 `wbot auth set`
And 错误不把文件内容输出给 Agent

**场景 2.7：普通用户不需要配置 Platform URL**
Given 用户使用公开发布的 wbot 工具
And 用户没有提供 endpoint 覆盖
When Agent 发起读取
Then 工具连接预设的 wbot 生产服务
And 开发或自托管环境可以用 `WBOT_PLATFORM_URL` 显式覆盖

**场景 2.8：认证失败不会泄漏 API Key**
Given Agent 使用的 API Key 已失效或被吊销
When Platform 拒绝 CLI 或 MCP 请求
Then Agent 得到稳定的认证错误
And stdout、stderr、MCP 文本结果和结构化结果都不包含完整 API Key

## 功能 3：Agent 通过 CLI 获得稳定的机器可读结果

**场景 3.1：成功结果只写入 stdout**
Given CLI 已取得有效配置
When Agent 执行任一只读命令且请求成功
Then stdout 只包含一个可解析的 JSON 结果
And stderr 不混入进度提示或装饰文本
And 进程以成功状态退出

**场景 3.2：失败诊断不污染 stdout**
Given CLI 请求因输入、认证、授权或网络问题失败
When CLI 返回失败
Then stdout 不包含伪造的成功结果
And stderr 包含稳定错误码与可操作消息
And 进程以非零状态退出

**场景 3.3：Agent 分页列出获授权会话**
Given Tenant 拥有多个群聊或 DM 的有效读取授权
When Agent 执行 `wbot conversations list`
Then Agent 得到不超过请求上限的会话
And 每个会话包含稳定标识、类型、可用标题与最近消息摘要
And 每个会话明确返回当前 Tenant 的 read 与可选 send 能力
And 每个会话返回 unknown、current、delayed 或 unavailable 的采集新鲜度
And 结果包含下一游标与是否仍有更多会话

**场景 3.4：Agent 显式带回会话游标读取下一页**
Given Agent 持有上一页会话列表返回的游标
When Agent 在新调用中显式提供该游标
Then Agent 得到游标之后的会话页
And 结果不重复上一页已经返回的会话

## 功能 4：Agent 向过去读取一个会话的历史

**场景 4.1：首次历史读取返回最近的有界上下文**
Given Tenant 拥有目标会话的有效读取授权
When Agent 不带历史游标读取该会话
Then Agent 得到最近的不超过请求上限的消息
And 消息以适合阅读的从旧到新顺序返回
And 结果包含可继续向更早历史翻页的游标

**场景 4.2：历史游标只用于读取更早消息**
Given Agent 持有上一页历史结果返回的游标
When Agent 显式带回该游标继续读取历史
Then Agent 得到上一页之前的更早消息
And 结果继续以从旧到新顺序返回
And 结果明确指出是否还有更早历史

**场景 4.3：历史游标不能用于消息更新**
Given Agent 持有一个历史游标
When Agent 把它用于读取新增消息
Then Platform 返回稳定的无效游标错误
And 不猜测 Agent 想从哪个位置继续

## 功能 5：Agent 从显式位置读取新增消息

**场景 5.1：首次更新读取建立显式继续位置**
Given Tenant 拥有目标会话的有效读取授权
When Agent 不带更新游标读取该会话
Then Agent 得到一个有界的当前消息页
And 结果包含后续读取新增消息所需的更新游标
And 结果即使没有消息也包含采集新鲜度

**场景 5.2：带回更新游标后只返回后续入库消息**
Given Agent 持有先前返回的更新游标
And Platform 后来为同一会话入库更多消息
When Agent 显式带回该游标读取更新
Then Agent 只得到游标之后入库的消息
And 结果返回下一次继续使用的更新游标

**场景 5.3：延迟到达的消息不会因发生时间较早而漏读**
Given Agent 持有一个更新游标
And 设备后来上报一条发生时间早于已有消息的消息
When Agent 使用原更新游标继续读取
Then Agent 仍能得到这条延迟到达的消息
And 增量位置由 Platform 入库顺序决定

**场景 5.4：没有带回游标就不会恢复上次进度**
Given Agent 已完成一次更新读取
When 新调用没有提供先前返回的更新游标
Then Agent 得到新的有界当前页
And Platform、CLI 与 MCP 都不恢复或猜测上次位置

**场景 5.5：重复使用旧游标可以安全重读**
Given Agent 持有一个仍有读取授权的旧更新游标
When Agent 再次使用该游标读取更新
Then Agent 可以再次得到该位置之后的消息范围
And Agent 可以按稳定消息标识幂等处理重复项

**场景 5.6：撤销读取授权后旧游标立即失效**
Given Agent 持有目标会话先前返回的历史或更新游标
And Operator 已撤销该 Tenant 对会话的读取授权
When Agent 使用旧游标读取消息
Then Platform 拒绝请求
And 不返回任何消息内容

**场景 5.7：空更新页区分安静会话与采集异常**
Given Agent 使用更新游标读取一个暂时没有新增消息的会话
When Platform 返回空消息页
Then 结果仍包含采集状态和可证明时的最近成功检查时间
And Agent 可以区分 current、delayed、unavailable 与 unknown
And 结果不根据最后消息时间推断采集健康
And 结果不暴露设备、checkpoint、watermark 或 Operator 诊断

## 功能 6：Codex 与 Claude Code Plugin 提供等价能力

**场景 6.1：Codex Plugin 安装后提供 wbot 工具**
Given 用户安装并启用 wbot Codex Plugin
And 本机已有可用凭据
When Codex 开始使用该 Plugin
Then Plugin 启动 wbot MCP runtime
And Agent 可以发现三个只读工具

**场景 6.2：Claude Code Plugin 安装后提供相同工具**
Given 用户从公开 marketplace 安装并启用 wbot Claude Code Plugin
And 本机已有可用凭据
When Claude Code 加载该 Plugin
Then Plugin 启动同一个版本的 wbot MCP runtime
And Agent 发现与 Codex 相同名称和 schema 的三个只读工具

**场景 6.3：Plugin 不携带用户凭据**
Given 用户安装、升级或分享任一 wbot Plugin
When 用户检查 Plugin manifest 与 MCP 配置
Then Plugin 不包含用户 API Key
And Plugin 通过共享凭据解析流程取得本机配置

**场景 6.4：Plugin 指引 Agent 选择正确的读取方式**
Given Agent 需要回顾已有上下文或连续读取新消息
When Agent 使用 wbot Plugin
Then Plugin 指引回顾上下文时使用历史读取
And Plugin 指引连续处理时保存并带回更新游标
And Plugin 不声称自己会在 Platform 保存消费进度

## 功能 7：单一命令与两个 Plugin 共享一个发布契约

**场景 7.1：公共 package 通过单一命令提供 CLI 与 MCP runtime**
Given 外部用户不使用 Codex 或 Claude Code Plugin
When 用户安装公开的 `@celados/wbot` package
Then 用户可以直接调用 `wbot` CLI
And 用户可以通过 `wbot mcp` 启动 MCP
And 安装产物不提供平行的环境或 MCP executable

**场景 7.2：不同入口对同一输入返回等价结果**
Given CLI、Codex Plugin 和 Claude Code Plugin 使用同一 Tenant API Key
And Agent 为三个入口提供相同读取输入
When Agent 分别执行对应能力
Then 三个入口返回语义等价的结构化结果
And 授权、分页、游标和错误语义不因入口不同而改变
