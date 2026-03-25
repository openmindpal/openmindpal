# 细分架构设计：Skill 运行时（执行沙箱 / Runtime）

## 1. 目标与范围

Skill 运行时负责 Tool/Skill 的执行隔离与最小权限治理，降低供应链风险，并在运行期强制执行超时、并发、资源配额与出站网络控制。运行时不直接暴露业务读写能力，所有数据访问必须通过受控接口并进入审计。

覆盖范围：
- 执行隔离：进程/容器/远程运行时的统一抽象
- 最小权限：数据访问、文件、网络与系统资源的最小授权
- 资源治理：CPU/内存/并发、超时、熔断与背压
- 出站治理：域名白名单/代理、请求签名、速率限制
- 供应链治理：依赖扫描、签名校验、版本锁定（与治理控制面对齐）

## 2. 核心不变式

- Skill 只能通过受控接口访问数据，不允许直连数据库
- 出站网络默认拒绝，仅允许声明并批准的目标
- 所有执行必须可审计：toolRef、输入输出摘要、耗时、错误分类
- 运行时隔离默认开启，任何放宽都需治理流程与审计

## 3. Runtime Contract（概念级）

建议运行时抽象：
- RuntimeType：process / container / remote
- ExecutionRequest：{ toolRef, subject, scope, input, policySnapshot, idempotencyKey, limits }
- ExecutionResult：{ output, outputDigest, status, errorCategory, latencyMs, egressSummary }

limits 建议字段：
- timeoutMs、maxConcurrency、cpuLimit、memoryLimit
- networkPolicy（allowedDomains、proxyRequired、rateLimit）

### 3.1 Capability Envelope（能力包络）

为让 Skill 生态可以规模化而不失控，建议把运行时允许的能力明确固化为 capability envelope，并作为执行前的强制校验项。

建议最小集合：
- dataScope：允许访问的数据域与空间边界（spaceId/资源类型/时间窗）
- secretScope：允许使用的连接器与最小 scopes（仅允许经受控连接器路径使用）
- egressScope：允许的出站目标集合（域名/路径/方法/是否强制代理/速率与配额）
- resourceLimits：CPU/内存/并发/超时上限

任何 envelope 的放宽都必须走治理流程并写审计。

## 4. 执行流程（概要）

1) API/Workflow 提交 ExecutionRequest（含 toolRef、policySnapshot、idempotencyKey）
2) 运行时校验 toolRef 与版本锁定（依赖摘要一致）
3) 注入最小权限上下文（仅允许声明的资源与网络）
4) 执行并采集运行指标（耗时、内存、出站请求摘要）
5) 输出校验 outputSchema（由编排层或运行时协作完成）
6) 返回结果摘要并写审计（由统一链路负责）

### 4.1 回放支持（证据与摘要）

运行时对回放的支持以“可追溯证据与可比摘要”为目标：
- 默认仅保留 outputDigest 与必要的 egressSummary，避免扩大敏感数据暴露面
- 对高风险外发与高影响写入，允许按策略加密保留最小必要证据并配置保留期
- 任何证据保留与读取都必须进入审计，并遵循字段级脱敏与最小化原则

## 5. 出站网络治理

原则：
- 域名白名单：仅允许批准的域名/路径/方法
- 强制代理（可选）：对企业环境统一走代理以便审计与风控
- 速率限制与配额：按租户/工具/连接器维度
- 请求签名：对关键外发调用做签名与重放防护

审计要点：
- 记录目标域名、用途、响应结果摘要与错误分类
- 不记录凭证原文与敏感 payload

## 6. 资源与稳定性治理

- 超时：每个 Step/Tool 必须声明超时，超时终止并进入可恢复状态
- 并发：租户级与工具级并发上限，避免单点慢源拖垮整体
- 熔断：对外部依赖失败率异常时触发熔断与降级（与工作流策略对齐）
- 背压：队列堆积时限流与降级，保护核心链路

## 7. 供应链与安装更新治理（与 Registry 对齐）

要求：
- 来源可信：Skill 来源与发布者可信度校验
- 版本锁定：执行必须定位到确定版本与依赖摘要
- 静态扫描：依赖风险扫描与签名校验
- 灰度发布：按租户/空间/环境灰度启用，支持快速回滚

用户私有自举 Skill 的运行时约束（建议）：
- 默认更严格的 limits：更短超时、更低并发、更小资源配额，避免“自生成能力”放大风险
- 默认更严格的 networkPolicy：出站仅允许显式声明并通过审批的域名集合
- 默认禁止写入高敏资源：除非 tool contract 明确声明、通过确认/审批，并由 AuthZ 决策放行
- 禁止直接读取凭证明文：Skill 不允许读取 SecretRecord 明文，只能通过受控连接器调用路径使用凭证

## 8. 可观测性

- 指标：工具执行成功率、平均耗时、超时率、出站拒绝率、资源使用峰值
- 追踪：runId/stepId 与 traceId 串联到外部调用摘要
- 告警：超时/熔断频繁、出站拒绝异常、资源耗尽风险

## 9. 演进路线

- MVP：进程级隔离 + 超时/并发限制 + 出站域名白名单 + 审计
- V2：容器化隔离 + 资源配额 + 更细粒度网络策略
- V3：远程运行时与多区域隔离 + 供应链闭环与评测准入联动
