# 细分架构设计：连接器与密钥托管（Connector / Secrets）

## 1. 目标与范围

本模块负责把外部系统（OAuth2/OIDC、API Key/PAT、Service Account、Webhook）统一抽象为连接器，并提供凭证加密托管、轮换/撤销与可审计使用的能力，确保“接入真实世界但不失控”。

覆盖范围：
- ConnectorType：提供方与能力声明（Google/Microsoft/Slack/GitHub/自定义等）
- AuthMethod：OAuth2 / APIKey / ServiceAccount / Webhook
- Scopes/Resources：最小 scopes 与资源范围表达
- EgressPolicy：允许的域名/路径、是否强制走代理、请求签名策略
- SecretRecord：凭证加密存储、分区密钥、轮换/撤销、使用审计
- Webhook 回调安全：验签与重放防护，回调触发的自动化治理
- 模型提供方凭证：将 LLM/Embedding/Rerank 等模型 API 纳入同一托管与审计

## 2. 核心不变式

- 最小授权：连接器必须声明最小 scopes 与资源范围，默认拒绝，按空间/租户启用
- 安全托管：凭证加密存储，按租户/空间/个人隔离，可轮换可撤销
- 使用可审计：每次读取/刷新/使用凭证都写审计（不记录凭证原文）
- 外发受控：域名白名单/代理、速率限制与配额，避免供应链与数据外泄风险

## 3. 连接器元数据（建议一等资源）

连接器建议纳入 Schema/Policy/Workflow 的治理体系：
- ConnectorType：{ provider, capabilities, defaultRiskLevel, docsRef }
- ConnectorInstance：{ ownerScope, spaceId, connectorTypeRef, status, enabledPolicies }
- Scopes/Resources：{ scopes, resourceConstraints, timeWindow? }
- RiskLevel：决定默认启用策略、是否需要审批、速率与配额
- EgressPolicy：{ allowedDomains, allowedPaths?, proxyRequired?, signingRequired? }

模型提供方（建议作为连接器类型之一）：
- ModelProviderType：{ provider, kind(llm/embedding/rerank), capabilities, defaultRiskLevel }
- ModelProviderInstance：{ ownerScope, spaceId, providerTypeRef, status, enabledModels, enabledPolicies }
- 约束：enabledModels 必须与 Model Gateway 的 model catalog 对齐，避免绕过路由与治理

## 4. 凭证托管（Secrets/Key Contract 落地）

Secrets/Key Contract（最小集合）：
- SecretRecord：{ ownerScope(tenant/space/user), connectorRef, encryptedPayload, keyVersion, status }
- rotation/revoke：轮换与撤销语义，以及每次使用的审计事件字段集合

建议密钥层级：
- 主密钥 -> 租户/空间分区密钥 -> 记录级加密
- 支持轮换、吊销、恢复，并保证吊销后访问失效

模型提供方凭证策略（建议）：
- BYOK：租户/空间可自带模型 API Key，并绑定 provider 与可用模型集合
- 环境隔离：dev/staging/prod 的凭证分离，禁止跨环境复用
- 最小暴露：凭证不可被 Tool/Skill 明文读取；仅允许由 Model Gateway 在受控调用前取用
- 审计：每次模型调用记录 connectorRef/provider/model 与用量摘要，不记录凭证原文

## 5. 外部调用链路（纳入平台不变式）

工具调用外部系统也必须纳入统一治理：
- 调用前：授权计算 + 外发策略校验（域名/路径/方法/数据最小化）
- 调用中：速率限制/配额/熔断，必要时转异步任务
- 调用后：响应脱敏与字段级裁剪，写审计与可回放摘要

审计字段建议：
- connectorRef、targetHost、purpose、resultSummary、latencyMs、errorCategory

## 6. Webhook 与回调安全

要求：
- 回调验签与重放防护（时间窗 + nonce + 签名）
- 回调入站同样走鉴权/授权/审计链路（主体可为连接器主体/系统主体）
- 回调触发的自动化必须带幂等键与租户级限流，避免自动风暴

## 7. 与工作流与审批的联动

高风险场景建议强制审批：
- 导出/分享/批量写入/跨域写入
- 连接器启用、scope 扩大、外发策略放宽
- 凭证轮换、撤销、恢复

审批通过后：
- 复用 policySnapshot 与 idempotencyKey
- 执行与结果全程落审计

用户私有自举 Skill 与连接器的边界（建议）：
- 自举 Skill 不允许创建“共享连接器实例”，只能请求创建 user-scope 的 ConnectorInstance/SecretRecord（并走确认/审批）
- 自举 Skill 不允许读取 SecretRecord 明文；仅能通过受控连接器调用路径使用凭证（连接器在调用前受控取用）
- 外发域名白名单与 scope 扩大视为高风险变更，必须进入审批与审计

## 8. 可观测性

- 指标：连接器调用成功率、错误率、超时率、熔断次数、配额命中率
- 安全：外发拒绝率、scope 变更频率、凭证使用异常告警
- 追踪：traceId 串联到工具与工作流的 runId/stepId

## 9. 演进路线

- MVP：连接器抽象 + SecretRecord 加密存储 + 外发域名白名单 + 使用审计
- V2：轮换/撤销闭环 + 更强的资源范围约束 + Webhook 安全与自动化治理
- V3：分区密钥与可选端到端加密 + 私有 Registry 分发与评测准入联动
