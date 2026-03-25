# 细分架构设计：审计域（Audit，append-only）

## 1. 目标与范围

审计域负责记录平台内所有读写与执行行为的不可篡改追加式日志，支撑合规、追责、回放与排障。审计记录覆盖成功、拒绝与失败三类结果，任何链路不得跳过审计。

覆盖范围：
- 追加式审计事件存储（append-only，不可更新/删除）
- 输入输出摘要（可脱敏）、策略决策摘要、工具/流程引用
- Run/Step 执行链路串联（可回放、可撤销/补偿的依据）
- 审计导出与保留策略（与治理控制面对齐）

## 2. 核心不变式

- 审计不可跳过：成功/拒绝/失败都必须产生审计事件
- 审计不可篡改：至少做到逻辑域隔离 + append-only
- 审计与执行绑定：必须能定位到 subject、tenant/space、resource/action、toolRef/workflowRef、idempotencyKey 与 traceId

## 3. 审计契约（最小字段）

Audit Contract（最小集合）：
- eventId、timestamp
- subject、tenant/space
- action、resourceRef
- toolRef（可选）、workflowRef（可选）
- policyDecisionSummary（允许/拒绝、命中摘要、拒绝原因）
- inputDigest、outputDigest（可选，按脱敏策略）
- idempotencyKey
- result（success/denied/error）
- traceId、runId、stepId（可选但推荐）

建议扩展字段：
- riskLevel、approvalChainSummary
- errorCategory（可重试/需人工/需审批/需降级）
- latencyMs、retryCount、attempt

## 4. 事件分类与写入时机

建议事件类型（示意）：
- request.received / request.denied / request.succeeded / request.failed
- workflow.created / workflow.approved / workflow.rejected / workflow.completed / workflow.failed
- tool.invoked / tool.succeeded / tool.failed / tool.compensated
- model.invoked / model.succeeded / model.failed / model.degraded
- secret.used / connector.called / egress.denied
- import.requested / import.validated / import.applied / import.failed
- export.requested / export.generated / export.failed / artifact.downloaded
- backup.requested / backup.completed / backup.failed
- restore.requested / restore.validated / restore.applied / restore.failed
- schema.published / policy.updated / pageConfig.published / skill.enabled
- skill.draft_created / skill.draft_updated / skill.user_enabled / skill.user_disabled / skill.user_revoked
- skill.bootstrap_requested / skill.bootstrap_denied

写入时机原则：
- 在请求受理与授权决策后至少写一条事件（包括拒绝）
- 写操作在最终落库（或进入流程）后追加结果事件
- 队列/重试/补偿每次 attempt 都需要事件记录

## 5. 摘要与脱敏策略

原则：
- 审计记录以“可比较、可回放、可治理”为目标，不保存不必要的敏感原文
- inputDigest/outputDigest 默认脱敏，按字段级权限与 Safety/DLP 规则裁剪

建议做法：
- 使用结构化摘要：关键字段哈希/截断、计数、枚举、范围等
- 对外发与连接器调用记录目标域名/用途/结果摘要，不记录凭证原文

## 6. 与幂等、回放与补偿的关系

绑定要点：
- idempotencyKey：把对话/审批/执行/重试串成同一写入意图
- toolRef/workflowRef：版本锁定与依赖摘要，保证回放一致
- policySnapshot：执行时刻权限快照引用，保证可解释与一致性
- runId/stepId：可靠执行与补偿的最小串联单位

回放要求：
- 同一 inputDigest + policySnapshot + toolRef 版本应得到可解释的一致执行轨迹

## 7. 存储与隔离建议

最低要求：
- 审计日志独立逻辑域（避免与业务表共用生命周期策略）
- append-only：数据库层面或应用层面禁止更新/删除路径

可选增强：
- 不可变校验：按时间窗口计算链式摘要（hash chain）用于完整性验证
- 分区与归档：按时间与 tenant 分区，支持 retention 与 legal hold

## 7.1 可靠写入与一致性边界

目标：
- 避免出现“业务已生效但审计缺失”的不可接受状态
- 允许在极少数低风险读链路采用弱一致审计，但必须最终可追溯

建议模式：
- Outbox：在业务事务内写入审计 outbox 记录，提交后异步搬运到审计域
- 幂等落库：审计域以 eventId 作为唯一键，重复写入视为幂等
- 关联一致：每条审计事件必须携带 traceId 与 requestId，并在异步链路中原样透传

一致性分级（建议可配置）：
- 强一致：审计写入失败则请求失败（适用于写请求与高风险读）
- 最终一致：请求可先返回，但必须保证审计最终落库，并能通过 traceId/requestId 定位补偿状态（适用于低风险读）

## 8. 查询与导出（治理控制面对齐）

支持能力：
- 按 tenant/space、subject、resource/action、toolRef、runId、时间范围检索
- 导出对接 SIEM（可选），导出行为本身也进入审计

## 9. 可观测性

- 指标：审计写入失败率、写入延迟、积压、导出频次
- 告警：审计写入失败必须高优先级告警（影响平台不变式）
- 追踪：traceId 与 runId/stepId 帮助定位跨模块链路问题

## 10. 演进路线

- MVP：append-only 审计落库 + 拒绝可解释 + 与幂等键绑定
- V2：Run/Step 全链路审计 + 队列重试/补偿事件完备
- V3：完整性校验、归档/保留策略、SIEM 对接与评测准入联动
