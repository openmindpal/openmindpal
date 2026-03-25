# 细分架构设计：BFF/API 与统一请求链路

## 1. 目标与范围

本模块提供平台唯一的读写入口，承载统一的安全链路与契约治理，向 Web/UI、多端入口、AI 编排层与第三方集成暴露稳定 API，并对下游模块做聚合与适配。

覆盖范围：
- 认证上下文建立（Subject + Tenant/Org/Space）
- 输入校验（基于 Schema/Tool 参数 JSON Schema）
- 授权计算触发与决策落审计（资源/行/字段级）
- 幂等、限流、配额、版本与错误规范
- 审计写入的同步边界与失败策略
- 聚合与编排：把 Metadata/Data/AuthZ/Workflow/Tool Runtime 串成稳定链路

## 2. 核心不变式

- 外部入口必须经过 API 层统一请求链路（对外强约束），不允许任何外部旁路访问数据层或数据库
- Worker 属于平台内部执行平面，允许直连数据库执行读写（对内受控放行），但必须遵守护栏与可审计不变式：
  - capability envelope：对工具调用、出站网络与资源限制做强校验
  - 审计强制：关键步骤必须写审计/哈希链，失败策略必须可解释且可追踪
  - 写冲突控制：关键资源写入必须使用写租约或等价机制避免并发写冲突
  - 幂等与可回放：副作用写入必须具备幂等键/去重，并可追溯关联 run/step
  - 权限上下文：执行必须携带并使用可验证的权限上下文与 policy snapshot 引用
- 旁路禁止边界：任何非内部执行平面的进程/脚本不得绕过 API 直连生产数据库
- Subject 与租户上下文只由认证层建立，禁止由调用方自带身份
- 任何成功或失败操作都必须写审计（至少记录拒绝原因/命中规则摘要）
- 扩展只走契约：Schema/Policy/Tool/Workflow，API 层不接受“随意脚本/直连”

## 3. 分层与依赖关系

上游调用方：
- Web/UI（Next.js）
- 多端入口（移动/桌面/IM/Webhook/定时触发器）
- AI Orchestrator（工具调用）

下游依赖：
- AuthN：建立 Subject 与 Tenant/Org/Space 上下文
- Metadata：Schema Registry、Tool/Workflow 元数据
- AuthZ：权限决策与 Policy Snapshot
- Data：通用 CRUD、查询、导入导出、备份恢复
- Workflow/Queue：审批、异步任务、重试与死信
- Audit：追加式审计写入
- Safety/DLP（可选前置/后置）：输入输出内容治理

## 4. 请求链路（契约级）

平台所有读写必须满足同一条安全链路：
1) 鉴权（Authentication）：建立 Subject + Tenant/Space
2) 参数校验（Validation）：基于 Schema/Tool 参数 JSON Schema 校验输入
3) 授权计算（Authorization）：资源/行/字段级决策，产出可解释摘要与 Policy Snapshot
4) 业务执行（Execution）：读做字段裁剪与行约束；写做字段级写入约束与并发控制
5) 审计落库（Audit）：追加式记录，失败策略必须可追踪

说明：上述链路约束适用于所有外部入口请求。Worker 作为内部执行平面不通过 HTTP 链路进入系统，但必须满足第 2 节中定义的护栏与可审计不变式，以实现同等级的可解释与可追溯性。

## 4.1 实现组织（插件化统一链路）

为保证链路可组合、可复用、可测试，API 服务应将统一请求链路实现为一组 Fastify 插件，并在 server 启动时按固定顺序注册。

约束：
- 插件注册顺序语义不可随意调整（会影响鉴权/审计/DLP 的行为）
- `server.ts` 只负责注册插件与路由，不承载大段内联 hook 逻辑

建议插件顺序（概念级）：
- requestContext：traceId/requestId/locale
- authentication：authenticate + ensureSubject + device-agent 认证
- preferences：tenant/space/user locale 偏好装载并解析最终 locale
- idempotencyKey：从 header 注入审计上下文
- audit：审计上下文初始化、错误归因、强制写入与失败策略
- dlp：响应内容治理（deny/redact）并附加安全摘要
- metrics：统一请求指标与授权拒绝计数

## 5. API 契约设计要点

### 5.1 统一资源与动作语义

- Resource：实体/工具/流程/配置等资源类型
- Action：read/create/update/delete/execute/approve/publish/rollback/export/import/backup/restore 等动作

API 层必须能从每个请求确定：
- resourceRef（资源引用：类型 + 标识 + 作用域）
- action（动作）
- subject（主体）
- tenant/space（隔离边界）

### 5.2 Effective Schema 下发

原则：
- 前端只消费 Effective Schema（字段级裁剪后的视图）
- Effective Schema 生成由 Metadata + AuthZ 决定并可缓存

建议接口：
- GET /schemas/:entity/effective?spaceId=...
- 返回：schemaVersion、fieldRulesApplied、projection/index hints（可选）

### 5.3 幂等与重试边界

写操作统一支持 IdempotencyKey：
- 客户端显式提供或由系统生成并回传
- 审批通过后的执行复用同一幂等键
- 队列重试以幂等键为去重依据，避免重复副作用

### 5.4 错误规范与可解释拒绝

要求：
- errorCode 稳定；message 可多语言
- 授权拒绝必须可解释：拒绝原因 + 命中规则摘要
- 工具/连接器错误需分类：可重试/需人工/需审批/需降级

### 5.5 版本与兼容

- API 版本化：对外稳定契约；内部模块可通过适配层演进
- 契约版本对齐：Schema/Tool/Workflow/Policy 变更需进行兼容性检查与回滚预案

#### 5.5.1 引用与版本锁定（避免“漂移”导致不可回放）

- Schema/Tool/Workflow/Policy 的引用必须可解析到确定版本（显式 version 或在治理发布时解析并锁定）
- 工具执行必须携带 toolRef（名称 + 版本 + 依赖摘要），以保证回放与审计可定位
- Policy Snapshot 必须可引用到确定版本的策略与绑定版本（policyVersion/membershipVersion/toolPolicyVersion）

#### 5.5.2 Tool Contract 的扩展命名空间与前向兼容

Tool/Skill 元数据应采用“稳定字段 + 命名空间化扩展”的结构，避免核心字段无序增长导致生态演进变慢。

建议规则：
- 稳定字段严格：name/version/scope/resourceType/action/inputSchema/outputSchema/riskLevel/approvalRequired 等稳定字段语义在同一主版本内不得漂移
- 扩展字段命名空间化：可变部分统一放入 extensions（键为命名空间），例如 org.example.xxx
- 未知扩展可忽略但保留：API 层与编排层对未知 extensions 默认忽略其语义，但在存储与透传中保持原样
- 兼容性可自动检查：对 input/output schema 的变更进行兼容性判定，并与回滚预案绑定

#### 5.5.3 准入门禁（与治理控制面对齐）

为确保平台可以“无限扩展但可上线”，API 层应以治理发布产物为唯一来源，并在运行期强制执行门禁结果。

建议门禁：
- 仅允许 released：仅加载并执行已通过治理发布（released）的 Schema/Policy/Tool/Workflow
- 必须通过检查：兼容性检查、风险检查与回放评测（如适用）未通过则不可启用
- 默认拒绝新能力：新工具/新连接器/新策略默认不可用，需治理启用并可灰度
- 运行期可撤回：治理回滚或禁用后，API 层应在可预期窗口内失效缓存并停止新执行

### 5.6 批量作业与数据产物（导入/导出/备份/恢复）

原则：
- 导入/导出/备份/恢复默认走异步作业（Job/Run），避免阻塞请求链路
- 作业必须可取消、可重试、可审计，并绑定 policySnapshot 与幂等键
- 导出/备份产物（artifact）下载受短期令牌控制，并纳入内容治理与审计

建议接口形态（概念级）：
- POST /jobs/import | /jobs/export | /jobs/backup | /jobs/restore
- GET /jobs/:jobId（状态、进度、错误分类、结果摘要、runId）
- POST /jobs/:jobId/cancel
- GET /artifacts/:artifactId/download（短期令牌、可选一次性、可审计）

作业/执行/产物返回字段（建议最低集合）：
- jobId、jobType、status、progress、createdAt、updatedAt
- runId（如进入工作流执行）
- policySnapshotRef（用于解释一致性）
- idempotencyKey（写意图去重）
- resultSummary（结构化摘要）
- artifactRefs（导出/备份产物引用，零个或多个）

## 6. 审计写入策略（API 层责任）

最低要求：
- 每次请求（成功/拒绝/失败）至少写一条审计事件
- 审计事件包含：subject、tenant/space、resource/action、toolRef（如有）、policyDecisionSummary、input/output digest、traceId、idempotencyKey

失败边界：
- 审计写入失败视为请求失败；或进入可靠队列补偿但必须保证最终落库与可追踪

可靠写入建议（避免“写成功但审计丢失”）：
- 优先采用事务外盒（Outbox）模式：业务写入与审计事件入 outbox 同事务提交，再由异步投递器写入审计域
- 审计域以 eventId 做幂等：重复投递只允许一次落库，其余视为重复并返回已存在
- 对只读请求可允许“审计弱一致”模式（可配置）：请求成功返回不阻塞，但必须保证最终落库并可通过 traceId/requestId 追踪

关联字段约定：
- requestId：单次 API 请求唯一标识（与 traceId 并存，用于业务侧关联）
- traceId：端到端追踪标识（跨模块、跨队列）
- runId/stepId：进入工作流或工具执行时必须回传并贯穿审计事件
- idempotencyKey：写意图去重键（审批通过后的执行必须复用同一键）

## 7. 安全与治理

- 限流：租户级、用户级、工具级（与 Model Gateway 配合）
- 配额：模型成本与工具调用预算归集（用于治理，不依赖计费）
- 内容治理：在请求入口与输出阶段执行 Safety/DLP 策略（提示注入、敏感信息、外发控制）
- 变更治理：Schema/Policy/Tool/Workflow/页面配置发布必须通过治理流程并写审计

## 8. 可观测性

- 指标：QPS、P50/P95 延迟、错误率、授权拒绝率、审计失败率、幂等命中率
- 追踪：traceId 串联 UI/BFF/各模块；支持 Run/Step 级链路
- 日志：仅输出结构化摘要与脱敏信息，避免泄露敏感数据

## 9. 演进路线

- MVP：统一链路 + 通用 CRUD 聚合 + 资源级 RBAC + append-only 审计
- V2：字段/行级授权 + Workflow/队列 + 幂等与可回放执行
- V3：工具生态扩展 + 策略表达增强 + 更强的内容治理与评测准入
