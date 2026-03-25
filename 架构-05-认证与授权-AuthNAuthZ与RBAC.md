# 细分架构设计：认证与授权（AuthN/AuthZ，RBAC 起步）

## 1. 目标与范围

本模块负责建立请求主体（Subject）与租户上下文（Tenant/Org/Space），并对所有资源动作进行授权决策（资源级/行级/字段级），输出可解释的决策摘要与可回放一致性的 Policy Snapshot。

覆盖范围：
- AuthN：身份识别、会话/令牌校验、Subject 建立与租户上下文绑定
- AuthZ：RBAC（Role→Permission）、行级过滤（rowFilters）、字段级规则（read/write allow/deny）
- 决策解释：命中规则摘要与拒绝原因
- Policy Snapshot：执行时刻固化权限快照，用于回放一致性与合规审计
- 缓存与失效：基于上下文哈希的缓存、变更触发失效

## 2. 核心概念

- Subject：请求主体（用户/系统/连接器主体）
- Tenant/Org/Space：租户/组织/空间隔离边界
- Resource/Action：授权计算基本单元
- Permission：{ resourceType, action, constraints? }
- RoleBinding：{ subject, role, scope(tenant/org/space) }
- RowFilters：对记录级的访问约束表达（owner、成员关系、组织层级等）
- FieldRules：字段级读/写 allow/deny（与 Effective Schema 生成对齐）
- Policy Snapshot：某次执行时刻固化的授权快照

## 3. 授权模型（MVP→演进）

### 3.1 MVP：RBAC（资源级）

- Role -> Permission
- Permission 作用于 Resource + Action
- 资源级：是否允许访问某实体/接口/工具/流程
- Action 建议覆盖数据治理动作：import/export/backup/restore，并与风险分级联动审批门槛

### 3.2 V2：行级 + 字段级

- 行级：对记录级访问施加约束（如 spaceId、ownerId、project membership）
- 字段级：
  - 读字段白名单/黑名单
  - 写字段白名单/黑名单
  - 在导出、搜索、AI 工具参数映射中同样生效

### 3.3 V3：ABAC（可选演进）

- 引入上下文属性（时间、环境、风险等级、数据标签）与更强的策略表达
- 仍需输出可解释决策与可复用快照

## 4. 决策输出（契约级）

AuthZ 对每次请求输出：
- decision：allow/deny
- reason：可解释原因（面向审计与排障）
- matchedRules：命中规则摘要（可结构化）
- rowFilters：行级约束表达（供数据面强制执行）
- fieldRules：字段级规则（供 Effective Schema 与数据裁剪）
- snapshotRef：Policy Snapshot 引用或快照内容摘要

### 4.1 Policy Contract 的扩展命名空间与前向兼容

为支撑多行业/多团队差异且避免策略契约无限膨胀，Policy Contract 建议采用“稳定字段 + 命名空间化扩展”的结构。

建议规则：
- 决策输出稳定：decision/reason/matchedRules/rowFilters/fieldRules 的语义在同一主版本内不得漂移
- 扩展字段命名空间化：可变部分统一放入 extensions（键为命名空间），例如 org.example.xxx
- 未知扩展可忽略但保留：解析器对未知 extensions 默认忽略其语义，但在存储、回滚与再发布中保持原样
- 语义版本化：策略行为变化必须通过版本语义表达，并绑定兼容性检查与回归评测
- 扩展可注册：对关键扩展引入扩展注册表与校验器，作为发布准入门槛的一部分

典型可扩展点（建议放入 extensions）：
- ABAC 上下文属性映射（时间窗、环境、风险等级、数据标签）
- 领域特定的行级约束表达（在平台支持的表达式集合内）
- 拒绝原因与命中摘要的结构化字段增强（不改变决策语义）

## 5. Effective Schema 生成对齐

原则：
- 前端只消费 Effective Schema
- Effective Schema 必须来自 Schema Registry + 字段级授权规则

生成方式：
- 输入：schemaRef + subject + scope + fieldRules
- 输出：裁剪后的 schema（字段可见/可写标记、可用动作提示）

## 6. 缓存与失效策略

缓存建议：
- key：tenant/space + subject + roleBindingsHash + policyVersion + schemaVersion
- value：decision + rowFilters + fieldRules + snapshotDigest

必须可失效：
- 角色/权限/策略变更
- 成员关系变更、组织层级变更
- Schema 版本切换（影响字段集合与校验）

失效方式：
- 版本号递增（policyVersion / membershipVersion）
- 主动失效事件（治理变更发布后触发）

建议固化的版本字段（用于可预测失效）：
- policyVersion：授权策略与权限绑定版本（Role/Permission/Policy 变更递增）
- membershipVersion：成员关系与组织层级版本（成员增删、组织结构变更递增）
- schemaVersion：Schema 发布版本（影响字段集合与校验）
- toolPolicyVersion：工具启用/禁用与风险策略版本（工具/连接器治理变更递增）

缓存 key 建议展开（便于排查与回放一致性）：
- { tenantId, spaceId, subjectId, policyVersion, membershipVersion, schemaVersion, toolPolicyVersion, contextHash }

失效触发建议：
- 治理发布事件触发主动失效（按 tenant/space 粒度），并同步递增对应版本号
- 对高风险动作（导出/备份/恢复/权限变更）可选择绕过缓存或强制刷新决策

## 7. 与工具/工作流的集成

- Tool/Skill 执行必须映射到资源与动作，纳入统一 AuthZ
- 高风险写操作与审批：
  - 授权计算必须在执行前完成
  - 审批通过后的执行复用同一 Policy Snapshot 与幂等键
- 回放一致性：回放时用原始 snapshotRef 与 toolRef 版本锁定

## 8. 安全与治理

- 默认拒绝：新资源/新工具默认不可用，需显式授权与灰度启用
- 最小授权：权限按 scope（tenant/org/space）绑定，避免跨域泄露
- 审计不可跳过：拒绝同样写审计（拒绝原因与命中摘要）

## 9. 可观测性

- 指标：授权拒绝率、决策耗时、缓存命中率、策略变更频率
- 追踪：每次决策输出 traceId 与 snapshotDigest，便于复盘

## 10. 演进路线

- MVP：资源级 RBAC + 决策解释 + 审计对齐
- V2：行级/字段级 + Effective Schema 标准化 + 缓存与主动失效
- V3：ABAC/风险分级联动 + 更强的策略表达与回归评测
