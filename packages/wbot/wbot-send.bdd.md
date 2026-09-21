---
type: Behavior Spec
title: CLI 文本发送与结果查询
status: accepted
description: 按用户授权增加 CLI 发送入口，沿用 Platform 幂等与结果语义，MCP 保持只读。
---

# CLI 文本发送与结果查询

范围：`messages.send`、`outbound-sends.get`、schema 发现、输入校验及错误处理。
不增加自动重试、自动生成 requestId、自动轮询、媒体发送或 MCP 写工具。

## 场景 1：发现并发送文本

```gherkin
Given Agent 有目标会话的 send 授权
When Agent 提供非空 conversationId、requestId、text、requestedBy 调用 messages.send
Then CLI 使用既有凭据向 Platform 提交一次请求
And 文本中的换行、引号和 Unicode 原样保留
And stdout 返回 outboundSendId、conversationId 和 queued
And queued 不代表消息已送达
```

## 场景 2：调用方控制幂等

```gherkin
Given 调用方使用同一个 Tenant 和 requestId 重复提交完全相同的发送输入
When Platform 返回相同 outboundSendId
Then CLI 原样返回该标识，不生成新的 requestId
And 同一 requestId 对应不同输入时保留 Platform 的冲突错误
```

幂等由 Platform 实现；CLI 测试验证输入和响应透传，不代替后端幂等验收。

## 场景 3：无效输入不产生请求

```gherkin
Given 发送输入缺少任一必填字段、字段为空或类型错误，或包含未知字段
When Agent 执行 messages.send
Then CLI 在发出请求前失败并以非零状态退出
And stdout 没有成功结果
```

## 场景 4：查询发送结果

```gherkin
Given Agent 保存了发送返回的 outboundSendId
When Agent 执行 outbound-sends.get
Then CLI 只提交一次结果查询
And 原样返回 queued、processing、accepted、failed 或 indeterminate
And 保留 nullable reflectedMessageId 和兼容新增字段
And 不因 failed 或 indeterminate 发起新发送
```

accepted 仅表示发送通道接受调用；reflectedMessageId 表示 Platform 已观察到对应消息，
两者都不代表接收者已读。查询成功时即使业务状态为 failed，CLI 仍成功返回查询 JSON。

## 场景 5：授权、传输与协议失败

```gherkin
Given Platform 拒绝认证、授权或资源访问，或返回发送冲突
When CLI 收到错误
Then stderr 报告错误且进程非零退出，stdout 没有成功结果
And CLI 不自动重试
```

```gherkin
Given 请求发生传输错误或成功响应不符合 Platform 协议
When CLI 处理结果
Then CLI 非零退出且不自动重新发送
And 成功响应格式错误被识别为 Platform Contract Error
And 协议错误不泄漏响应正文或凭据
```

## 场景 6：公开入口边界

```gherkin
Given Agent 没有配置 API Key
When Agent 查看 CLI schema
Then 可以发现发送及结果查询的输入要求
And MCP 仍只提供现有三个只读工具
And 安装产物提供相同 CLI 能力
```
