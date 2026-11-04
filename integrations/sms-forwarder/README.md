---
type: Reference
title: 手机短信转发
description: Android 15 手机直接将新短信发给 wbot 微信会话或飞书群机器人，无 Mac 常驻或桥接服务。
status: prototype
---

# 手机短信转发

一个独立 Android APK，包含系统收件箱增量读取、本地待发送队列和三个文本发送出口：
wbot 的公开 HTTPS 接口、飞书群机器人、Slack Incoming Webhook。不依赖 SmsForwarder，不改现有微信 Hook，不增加中转服务。

## 使用

手机需 Android 15 或更新版本。选择出口、填写配置、授权短信读取，点击“保存并开启”。
微信需要 API origin、Tenant API Key、目标 conversationId；该会话须有 send grant。
Slack 使用绑定单一频道的 Incoming Webhook，不经过 slack-relay，也不保存 Slack Bot token。
默认公共 origin 为 `https://wbot-api-prod.celados.com`，本次手机明确配置在现有 test 环境。
飞书需要群自定义机器人 Webhook，正文含“短信转发”，可设为机器人关键词；不支持机器人签名。

凭据仅保存在应用私有配置，不写日志、不进入备份或设备迁移。配置修改前先停止；
有待处理短信时禁止更换出口、账号、凭据或目标，避免积压被重定向。

首次成功读取收件箱时建立进度，跳过此前所有短信。停止后再次开启会补发停止期间的新短信。
只读取 SMS 收件箱，不处理 RCS、MMS、应用通知或通话。多段 SMS 以系统短信库合并后的记录为单位。
正文包含来源、时间和内容；成功后删除本地队列正文，保留采集进度。

USB 和 Mac 不参与运行。前台服务每 15 秒补查；0.4.0 起短信广播和短信库 ContentObserver 会请求同一采集器立即检查。
广播只提供唤醒信号，不解析 PDU 或建立第二套采集进度。验证码短信可能不广播，仍由系统收件箱采集。
事件到队列之间保持最多 5 秒的短 CPU 唤醒锁，采集与网络处理期间最多保持 45 秒，完成即释放；
不使用屏幕唤醒或永久 CPU 锁。周期检查会随 CPU 休眠延后，不能承诺固定锁屏/Doze 时延。
应用采用常驻前台服务，退出界面或移走任务不会主动停止，通知栏保留运行状态。
已加入 Android deviceidle 用户白名单，可另外将应用加入三星“从不休眠的应用”。
0.3.0 起，已启用的转发在手机重启后首次解锁、APK 升级后自动恢复。
手动点“停止”后不会自动开启；系统设置中的“强行停止”需重新打开应用才能恢复。
使用凭据保护存储，未实现重启后首次解锁前的运行。积压达到约 1000 条时暂停采集，不推进进度。

## wbot 发送

采集时将随机 requestId 与短信正文持久化，进度与队列在同一 SQLite 事务里提交。
调用 `/platform/v1/messages/send`，固定 requestedBy 为 `device:sms-forwarder`。
网络断开、超时、429 或服务端暂时故障时保留原 ID 和完全相同的请求再试，不创建新发送任务。

取得 outboundSendId 后持久化，之后只调用 `/platform/v1/outbound-sends/get`：

| 平台结果            | 手机行为                                                   |
| ------------------- | ---------------------------------------------------------- |
| queued / processing | 保留记录，继续查询                                         |
| accepted            | 删除本地正文；只表示微信发送路径已接受，不是送达或已读回执 |
| failed              | 留存异常，不自动重新提交                                   |
| indeterminate       | 留存异常，不自动重发                                       |
| 权限失败或协议异常  | 标记 blocked，停止该条自动处理                             |

手机在提交成功但尚未保存结果时退出，恢复后仍使用原 requestId，平台幂等吸收重复请求。
API Key 属于一个 Tenant，幂等也是 Tenant 范围，因此队列未清空时禁止更换凭据。
刷新状态显示待发送及异常数量，首版没有异常查看、清除或手动重试界面。
数据库 v1 → v2 的迁移保留旧记录、状态和进度，并补充 requestId。

## 飞书发送

离线时保留队列，联网后继续处理。网络请求前持久化 unknown，明确成功才删除；
业务拒绝为 rejected。超时、响应损坏或请求期间进程退出时保留 unknown，不自动重发。
飞书 Webhook 没有幂等键，异常条目需人工核对。

短信库被清空、恢复或 ID 重置不在当前支持范围；不自动重置进度，以免转发历史短信。

## 构建与验证

从 workspace 根目录，使用已有 wrapper、Java 21、Android SDK 37：

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
projects/switchboard/upstream/android-hook/module/gradlew \
  -p projects/wbot/integrations/sms-forwarder \
  :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
```

SpoolCheck 使用独立临时数据库验证事务失败回滚、进度及请求 ID 恢复、未知结果不重试、
升级迁移；WbotCheck 用合成响应验证稳定请求重试、只查询已提交任务、终态及非法响应。
不插入系统短信，不访问真实正文，不发送网络消息。

```sh
adb install -r -g projects/wbot/integrations/sms-forwarder/app/build/outputs/apk/debug/app-debug.apk
adb install -r projects/wbot/integrations/sms-forwarder/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w cc.celados.sms.test/cc.celados.sms.SpoolCheck
```

仅在用户已授权目标后，用 `-e live true` 显式运行 LiveSendCheck，从手机向已配置会话发送
一条注明“短信转发测试”的合成消息。它保留自身独立数据库和请求 ID，重复运行不会新建已提交或已终结的测试任务。
真实 SMS、断网恢复、锁屏、重启仍需另行验收，合成消息不能替代这些证据。

## 历史配置（2026-10-02）

2026-10-02：三星 SM-F7410 / Android 15，wbot test，目标 Deniffer 私聊。
使用独立 Tenant，仅授权该会话 read/send；手机专用密钥通过 latch 保存到 Vaultwarden
celados / Shared 的 `wbot / test / samsung-sms`，不复制其他会话权限。
APK 0.2.0 构建与 lint、真机 SpoolCheck / WbotCheck 通过。后台生命周期增强版本为 0.3.0。

真机 HTTPS 合成消息测试：wbot 返回 accepted，outboundSendId 为
`js79egwwrsvb5t7xp759jctbz98fg095`，reflectedMessageId 暂为 null；这证明发送路径已接受，
不证明微信收件人送达或已读。测试 APK 验证后已卸载。
新短信转发已启用，前台服务运行，应用已加入 Android deviceidle 用户白名单；
首次启动成功建立收件箱进度，待发送队列为空。尚未验收真实新短信、自然锁屏/Doze 与断网恢复。

0.3.0 生命周期验证：构建/lint 与真机队列、协议、升级、启用/停用恢复检查通过。
应用不在前台、ForwardService 已停止时，通过 root 发送系统 BOOT_COMPLETED 测试广播，
服务成功自动拉起为前台服务，未打开应用界面。测试 APK 已卸载。
这是模拟开机广播的后台恢复证据，尚未实际重启整机验证，也不证明自然 Doze 的发送时延。
Android 的开机前台服务例外及限制见
[后台服务启动规则](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)。

0.4.0 息屏增强验证：构建/lint、队列与短信唤醒尊重启用/停止选择的真机检查通过，已安装。
在屏幕保持 Dozing、deviceidle 强制 IDLE 时，通过 root 发送不含短信 PDU 的 SMS_RECEIVED
测试信号，last_scan_ms 前进，读取时距最新扫描约 0.71 秒，屏幕保持关闭。
已恢复强制 idle 设置，测试 APK 已卸载，转发服务继续运行。
此测试仅证明受控休眠下信号能唤醒现有采集器；没有插入系统短信，没有发送合成短信正文。
尚未收到用户提供的“息屏转发测试”真实 SMS，完整息屏 SMS → 微信链路与自然 Deep Doze 待验收。
白名单允许部分 CPU/网络能力，其他休眠限制仍可能适用，见
[Android Doze 文档](https://developer.android.com/training/monitoring-device-state/doze-standby)。

## 0.5.0 分卡路由

在微信出口下可启用按订阅 ID 分流：CMCC → 原私聊；AIR MOBILE → 指定微信群及 Slack 频道。
订阅 ID 来自收件箱 `sub_id`，不是默认短信卡或卡槽编号。换卡、重新安装 eSIM 后须重新核对；
负数、缺失或未配置 ID 的短信以 `held/blocked` 保留，不猜测目标。

SQLite v3 新增 `deliveries`，每条新短信的目标和稳定请求 ID 在采集时固定。
AIR MOBILE 的两个发送任务与 Capture Cursor 在同一个事务里提交。各出口独立处理，
一个出口失败不重复另一个出口。每轮分别处理最多 5 个微信任务、5 个 Slack 任务。
旧 `outbox` 原样保留，仍使用旧出口；不重新分流历史积压，不重置采集进度。
有分卡任务时禁止更改路由/Webhook；任何积压存在时禁止修改原出口及其凭据。

Slack 调用前先提交 `unknown`，只有 HTTP 200 + `ok` 才删除该任务正文。
HTTP 429 持久化频道级 Retry-After 后重试；明确的其他 4xx（不含 408）为 rejected。
断网、超时、响应损坏、408、5xx 或请求期间进程退出都保留 unknown，不自动重发。
这不提供 Slack exactly-once 保证；结果不确定时仍需人工核对。消息采用普通文本并关闭链接展开。

回归验证仍使用 SpoolCheck，包含 RoutingCheck：两卡路由、未知订阅、双任务事务回滚、
重复采集、v2→v3 保留旧状态、重启后出口独立、Webhook URL 校验及 Slack 响应分类。
`routing.bdd.md` 记录行为约定。显式合成链路验收：

```sh
adb shell am instrument -w -e routed_live true cc.celados.sms.test/cc.celados.sms.SpoolCheck
```

该检查使用独立持久化测试数据库，向 CMCC 私聊和 AIR MOBILE 双出口各发合成消息；
重跑沿用已有进度，不创建重复测试。它不插入系统短信，不能替代真实双卡 SMS/自然 Doze 验收。

2026-11-03 配置目标：SM-F7410，CMCC subscription 2 → Deniffer 私聊；
AIR MOBILE subscription 5 → Celados-10wu-mrr 微信群 + Celados 工作区 #sms-us-16232168064。
手机仍用 wbot test，专用 Tenant 只授权这两个微信会话 read/send。
Slack Webhook 存在 Vaultwarden 条目 `slack / celados / sms-us-16232168064 webhook`
（`94ccd3ee-449d-4882-8ca4-9bc963feae39`），不将 URL 写入源码。

0.5.0 本次验证：assembleDebug / assembleDebugAndroidTest / lintDebug 通过；真机 SpoolCheck
（含 RoutingCheck）通过。合成链路测试中 CMCC 私聊、AIR 微信群均 accepted 且随后在历史中观测到，
AIR Slack Webhook 返回确认且频道可见。未声称真实双卡短信或自然 Deep Doze 已验收。
升级前后旧队列的 ID、正文、requestId、outboundId、状态摘要一致：15 failed + 1 indeterminate；
分卡队列为空，前台服务运行，采集时间持续更新。未对旧异常进行自动重试。
APK SHA-256：`9d828852c848d66c8063c83957c337a23fa6cad18ab4f9c1975a9a08dad93187`；
签名证书 SHA-256：`fdc7b2254265ca873a09f2a1625d4d01bdb9e515f75292ba4cf5b3889cec72d5`，
与升级前一致。该 APK 在源码提交前构建；本目录随后随 0.5.0 接入一起提交。APK 身份以以上摘要为准，不能用后续仓库 HEAD 代替。
