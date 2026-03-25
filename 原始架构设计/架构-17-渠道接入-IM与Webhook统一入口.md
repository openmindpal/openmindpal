# 细分架构设计：渠道接入（IM / Webhook / 多端入口）

## 1. 目标与范围

渠道接入层将外部“消息与事件入口”（IM、Webhook、邮件、语音等）统一映射为平台内部请求与触发，保证所有入口都遵守同一平台不变式：鉴权→校验→授权→执行→审计，并支持幂等、回执、撤销与可追溯。

覆盖范围：
- Channel Adapter：对接不同渠道的收发、回调验签、速率限制与协议适配
- Subject 映射：把渠道身份映射到平台 Subject（用户/系统/连接器主体）
- 消息规范化：统一 Message/Event Envelope，承载对话、指令、交互回执与附件
- 触发模型：对话触发、命令触发、事件触发、订阅触发（进入 Workflow/Automation）
- 回执与撤销：消息送达、执行中、完成、失败、需确认/审批等状态回传

不在范围：
- AI 推理与工具编排（由 AI Orchestrator 负责）
- 外部系统连接器与凭证托管（由 Connector/Secrets 负责）

## 2. 核心不变式

- 入口无旁路：任何渠道入口都不得绕过 BFF/API 与审计链路
- 身份不可伪造：渠道回调必须验签，主体映射必须可审计
- 幂等优先：渠道重试与重复投递不可导致重复执行副作用
- 回执可追溯：每次触发都能定位到 requestId/traceId/runId

## 3. 统一 Envelope（概念级）

### 3.1 Ingress Envelope（入站）

- channel：{ type, provider, workspaceId?, botId? }
- event：{ type(message/command/callback/cron/webhook), eventId, timestamp }
- actor：{ channelUserId?, channelChatId?, mappedSubjectId?, scopeHints? }
- payload：
  - message：{ text?, richText?, attachments? }
  - command：{ name, args }
  - callback：{ actionId, value, messageRef }
  - webhook：{ path, method, headersDigest, bodyDigest }
- context：{ tenantId?, spaceId?, locale?, clientId?, deviceId? }
- security：{ signatureVerified, nonce, receivedAt }
- idempotency：{ key, dedupeWindowMs? }
- trace：{ requestId, traceId }

### 3.2 Egress Envelope（出站回执）

- channel：同入站
- to：{ channelChatId, channelUserId? }
- correlation：{ requestId, traceId, runId?, stepId?, jobId? }
- status：received | processing | needs_confirmation | needs_approval | succeeded | failed | canceled
- message：{ text, blocks?, attachments? }
- policyHints：{ riskLevel?, nextActions? }

## 4. Subject 映射与租户/空间归属

映射原则：
- 渠道身份（channelUserId）必须映射到平台 Subject，映射关系可由用户绑定或管理员预配置
- 多租户隔离：同一渠道 workspace 下不同 tenant/space 的映射必须显式配置，不允许隐式跨域
- 系统主体：来自 Webhook/定时器等非用户入口可使用 system subject，但必须绑定最小权限与审计

建议映射对象：
- ChannelAccount：{ provider, workspaceId, channelUserId, subjectId, tenantId, spaceId, status }
- ChannelChatBinding：{ provider, channelChatId, tenantId, spaceId, defaultSubjectId? }

## 5. 幂等与重试策略

入站幂等：
- 优先使用 event.eventId 作为天然幂等键（来自渠道的消息/回调/事件标识）
- 若渠道不提供稳定 eventId，则生成 deterministic key（provider + chatId + messageId + timestamp bucket），并写入 event.eventId

执行幂等：
- 将入站幂等键映射为平台 requestId + idempotencyKey
- 写动作必须使用幂等键贯穿 Tool/Workflow/Job，避免渠道重试造成重复副作用

回执幂等：
- 对同一 correlation（requestId/runId/jobId）重复回执视为幂等更新，不重复产生业务副作用

## 6. 回执、撤销与人机协作

回执类型：
- 快速回执：received/processing（提升体验）
- 风险回执：needs_confirmation/needs_approval（引导用户确认或审批）
- 结果回执：succeeded/failed（包含可解释摘要与下一步建议）

撤销语义：
- 对支持撤回的渠道，可撤回“回执消息”；对不支持撤回的渠道，发送“已撤销/已终止”状态消息
- 执行撤销只能影响尚未产生不可逆副作用的步骤；不可逆外部副作用必须走补偿流程并写审计

## 7. 与 Workflow/Automation 的对齐

触发规则：
- 高风险写动作默认转为 Workflow：渠道仅展示“待审批/待确认”回执
- 长耗时任务统一进入 Job：渠道回执通过 jobId 追踪进度与最终结果

异步链路要求：
- runId/stepId/jobId 必须在队列与回执链路中透传
- 每次重试 attempt 必须产生审计事件，并能反查到原始渠道 eventId

## 8. 安全与治理

- 回调验签：对 Webhook/IM 回调执行签名校验与重放防护（nonce + time window）
- 入口限流：按 provider/workspace/chat/user 分级限流，避免被刷与雪崩
- 内容治理：入站与出站都走 Safety/DLP（敏感信息、注入、外发控制）
- 权限对齐：渠道入口不改变权限边界，仍以 AuthZ 决策与 Policy Snapshot 为准

## 9. 可观测性与审计

可观测性：
- 指标：入站量、去重命中率、回执延迟、失败率、渠道侧限额命中率
- 追踪：requestId/traceId 串联渠道→API→工作流/队列→工具→外部系统

审计要点：
- 每次入站事件记录 request.received 或 webhook.received，并包含 channel/provider 与 eventId 摘要
- 对需要确认/审批的动作记录 decision 与拒绝/等待原因摘要
- 对回执发送记录 notification.sent/notification.failed（或 channel.message.sent）

## 10. 演进路线

- MVP：Webhook + 1 个 IM 渠道接入、入站验签、身份映射、幂等去重、基础回执
- V2：多渠道统一 Envelope、回执/撤销闭环、Job 进度回传、渠道级限流与告警
- V3：多端一致（离线/同步）、更丰富交互组件、渠道生态 Registry 与治理准入联动

## 11. 飞书（Feishu）接入（MVP 实现）

### 11.1 入站端点

- `POST /channels/feishu/events`
  - 支持 `type=url_verification`：返回 `{ challenge }`
  - 支持 `type=event_callback`：解析文本消息，写入 ingress_events/outbox/audit，并触发 orchestrator turn

入站校验（MVP）：
- 重放防护：读取 `x-lark-request-timestamp` 并在 `toleranceSec` 窗口内放行
- 事件去重：以 `header.event_id` 作为幂等键，重复投递返回之前的 response（若有）
- token 校验：对比请求体中的 `token` 或 `header.token`

### 11.2 配置与映射（治理侧）

配置接口：
- `POST /governance/channels/webhook/configs`
- `GET /governance/channels/webhook/configs?provider=feishu&workspaceId=...`
- `POST /governance/channels/providers/feishu/test`：验证配置完整并尝试获取 tenant_access_token（不返回 token 明文）

映射接口（复用通用映射模型）：
- `POST /governance/channels/chats`：将 `channelChatId(chat_id)` 绑定到 `spaceId`（并可指定 `defaultSubjectId`）
- `POST /governance/channels/accounts`：将 `channelUserId(open_id/user_id)` 绑定到 `subjectId`

Console：
- `/gov/channels`：可配置 Feishu workspace、写入映射、查看 deadletter

### 11.3 凭据来源（envKey 与 secretId）

WebhookConfig 支持两类凭据来源：

- `secretEnvKey`：指向环境变量，环境变量值为 Feishu 的 verify token
- `secretId`：引用 Secrets（推荐），其 payload 支持字段：
  - `verifyToken`：用于入站 token 校验
  - `appId` / `appSecret`：用于服务端消息投递（发送消息 API）

Feishu 发送消息凭据可二选一：
- `providerConfig.appIdEnvKey/appSecretEnvKey`（从环境变量读取）
- 或 `secretId` 的 payload 中提供 `appId/appSecret`

可选环境变量：
- `FEISHU_BASE_URL`（默认 `https://open.feishu.cn`）

### 11.4 本地模拟（示例）

url_verification：
- `POST /channels/feishu/events`
  - headers：`x-lark-request-timestamp`、`x-lark-request-nonce`
  - body：`{ "type": "url_verification", "tenant_key": "<workspaceId>", "token": "<verifyToken>", "challenge": "c1" }`

event_callback（文本）：
- `POST /channels/feishu/events`
  - body 示例包含：
    - `header.event_id`
    - `event.message.chat_id`
    - `event.message.content`（JSON string，形如 `{"text":"hi"}`）

## 12. 桥接 Provider（QQ/iMessage/Slack/Discord/DingTalk/WeCom）

适用场景：
- 渠道官方入站签名依赖 raw body 或复杂加解密，而平台侧当前采用“稳定 JSON 摘要 + HMAC”的统一验签模式
- 通过桥接服务完成“官方协议 ↔ 平台统一协议”的转换，平台侧仍执行验签/幂等/映射/授权/审计/回执

### 12.1 入站端点

统一入口：
- `POST /channels/bridge/events`（body 内带 `provider`）

便捷别名入口（等价）：
- `POST /channels/qq/bridge/events`（provider=`qq.onebot`）
- `POST /channels/imessage/bridge/events`（provider=`imessage.bridge`）
- `POST /channels/slack/bridge/events`（provider=`slack`）
- `POST /channels/discord/bridge/events`（provider=`discord`）
- `POST /channels/dingtalk/bridge/events`（provider=`dingtalk`）
- `POST /channels/wecom/bridge/events`（provider=`wecom`）

请求头（必需）：
- `x-bridge-timestamp: <unix_ms>`
- `x-bridge-nonce: <string>`
- `x-bridge-signature: <hex>`（HMAC-SHA256）

签名输入：
- `bodyDigest = sha256Hex(stableJson(body))`
- `signingInput = "<timestampMs>.<nonce>.<eventId>.<bodyDigest>"`
- `signature = hex(hmac_sha256(webhookSecret, signingInput))`

请求体（最小字段）：
- `provider/workspaceId/eventId/timestampMs/nonce/type/channelChatId/channelUserId`
- `type`：当前固定为 `message`
- `text` 可为空（例如图片），但 `text` 与 `attachments` 至少其一存在

### 12.2 出站投递模式

平台根据 Secret payload 中的字段选择投递方式：
- Bridge Send（用于 QQ/iMessage）：
  - 必需字段：`bridgeBaseUrl` + `webhookSecret`
  - 平台会调用：`POST {bridgeBaseUrl}/v1/send`（同样使用 `x-bridge-*` 头验签）
- Webhook Send（用于 Discord/DingTalk/WeCom 等）：
  - 必需字段：`webhookUrl` + `webhookSecret`（webhookSecret 用于入站验签；出站通常不需要）
  - 平台会向 `webhookUrl` POST 文本消息（最小 payload：`{ text, content }`）
- Slack API Send（用于 Slack）：
  - 必需字段：`slackBotToken` + `webhookSecret`
  - 平台会调用 `chat.postMessage`（channel 使用 `channelChatId`）

### 12.3 Secret payload 约定

桥接/统一验签通用字段：
- `webhookSecret`：入站验签共享密钥（建议通过 `secretId` 管理）

各 Provider 的最小字段集合：
- `qq.onebot`：`webhookSecret` + `bridgeBaseUrl`
- `imessage.bridge`：`webhookSecret` + `bridgeBaseUrl`
- `slack`：`webhookSecret` + `slackBotToken`
- `discord`：`webhookSecret` + `webhookUrl`
- `dingtalk`：`webhookSecret` + `webhookUrl`
- `wecom`：`webhookSecret` + `webhookUrl`
