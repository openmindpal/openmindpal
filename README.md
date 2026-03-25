<div align="center">

**[English](README.en.md) | 中文**

# 灵智 MindPal

**智慧的伙伴 — 万物皆可建模、皆可授权、皆可执行**

[![License](https://img.shields.io/badge/License-OpenMindPal--1.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)

[快速开始](#-快速开始) · [架构概览](#-架构概览) · [API 文档](#-api-概览) · [社区](#-社区与联系方式)

</div>

---

灵智（MindPal）是一个全栈智能体平台，以 **18 层精细化分层架构** 为基座，从宏观到微观统一管理数据、知识、设备与机器人，为个人和组织构建贯穿全生命周期的数字生命（记忆、偏好、健康、关系、资产、任务），并通过具身智能将决策落到现实世界的动作上 —— **全程可控、可回放、可追责**。

> 感谢豆包取名。

## 目录

- [核心特性](#-核心特性)
- [架构概览](#-架构概览)
- [技术栈](#-技术栈)
- [快速开始](#-快速开始)
- [项目结构](#-项目结构)
- [API 概览](#-api-概览)
- [安全与治理](#-安全与治理)
- [可观测性](#-可观测性)
- [社会价值愿景](#-社会价值愿景)
- [特别感谢](#-特别感谢)
- [社区与联系方式](#-社区与联系方式)
- [许可证](#-许可证)

## ✨ 核心特性

| 领域 | 能力 |
|------|------|
| **AI 编排** | 受控工具调用、自动规划、多步工作流、回放与补偿 |
| **多智能体协作** | 角色通信、权限上下文、协作协议 |
| **知识引擎** | 文档摄取、多阶段检索（关键词 + embedding + rerank）、证据链引用 |
| **长期记忆** | 偏好存储、会话上下文、任务状态持久化 |
| **Skill 运行时** | 隔离沙箱、最小权限、出站网络策略、依赖扫描 |
| **治理控制面** | 变更集（draft→submit→approve→release→rollback）、灰度发布、评测准入 |
| **设备/具身智能** | 设备注册配对、远程执行、桌面端 Agent |
| **通用数据平面** | Schema 驱动 CRUD、导入导出、离线同步 |
| **安全中枢** | Safety/DLP、RBAC、审计不可篡改日志、细粒度权限 |
| **渠道接入** | Webhook、IMAP、Exchange、SMTP、Mock IM |
| **可插拔工作台** | iframe sandbox + CSP 隔离、postMessage 能力注入 |
| **备份/恢复** | 空间级备份、一键恢复 |

## 🏗 架构概览

系统采用 **18 层精细化分层架构**，覆盖全生命周期治理：

```
┌─────────────────────────────────────────────────────────┐
│                   交互平面 (UI)                          │
├─────────────────────────────────────────────────────────┤
│                  BFF / API 网关                          │
├──────────┬──────────┬──────────┬────────────────────────┤
│ 元数据平面 │ 数据平面  │  认证授权  │     审计域              │
├──────────┴──────────┴──────────┴────────────────────────┤
│              工作流与自动化（审批/队列/幂等）               │
├─────────────────────────────────────────────────────────┤
│          AI 编排层（规划内核 / 执行内核）                  │
├──────────┬─────────────────────┬────────────────────────┤
│  知识层   │      记忆层         │    模型网关             │
├──────────┴─────────────────────┴────────────────────────┤
│                    安全中枢                              │
├─────────────────────────────────────────────────────────┤
│        Skill 运行时（沙箱/信任/出站/供应链）               │
├──────────┬──────────┬──────────┬────────────────────────┤
│ 连接器管理 │ 渠道接入  │ 设备运行时 │  多智能体协作           │
├──────────┴──────────┴──────────┴────────────────────────┤
│         治理控制面（发布/灰度/回滚/评测/可观测）            │
└─────────────────────────────────────────────────────────┘
```

> 详细架构文档见仓库根目录 `架构-*.md` 系列文件。

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript 5.8 |
| 运行时 | Node.js 20+ |
| 后端框架 | Fastify |
| 前端框架 | Next.js (React) |
| 数据库 | PostgreSQL 16 |
| 缓存/队列 | Redis 7 |
| 对象存储 | MinIO |
| 包管理 | npm workspaces (monorepo) |
| 容器化 | Docker Compose |

## 🚀 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 20
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)（用于数据库等依赖）
- npm >= 9

### 1. 克隆仓库

```bash
git clone https://github.com/your-org/openslin.git
cd openslin
```

### 2. 启动基础设施

```bash
docker compose up -d    # PostgreSQL 16 + Redis 7 + MinIO
```

### 3. 配置环境变量

```bash
cp .env.example .env    # 按需修改
```

### 4. 安装依赖 & 初始化数据库

```bash
npm install
npm run db:seed -w @openslin/api    # 迁移 + 种子数据 + core schema
```

### 5. 启动服务

```bash
npm run dev:api       # API 服务     → http://localhost:3001
npm run dev:worker    # Worker 异步作业
npm run dev:web       # Web 前端     → http://localhost:3000
```

### 默认访问地址

| 服务 | 地址 |
|------|------|
| Web 首页 | http://localhost:3000 |
| 设置页 | http://localhost:3000/settings |
| UI 配置管理 | http://localhost:3000/admin/ui |
| RBAC 管理 | http://localhost:3000/admin/rbac |
| API 健康检查 | http://localhost:3001/health |

### Admin CLI

提供只读/幂等运维 CLI，适合排障与运营查询：

```bash
npm run dev -w @openslin/admin-cli

# 示例
openslin-admin audit verify --apiBase http://localhost:3001 --token <token> --tenantId tenant_dev
openslin-admin models usage --apiBase http://localhost:3001 --token <token> --range 24h
openslin-admin queue status --apiBase http://localhost:3001 --token <token>
```

## 📁 项目结构

```
openslin/
├── apps/
│   ├── api/            # Fastify API 服务
│   ├── web/            # Next.js 前端
│   ├── worker/         # 异步作业处理器
│   ├── device-agent/   # 设备端 Agent (桌面 CLI)
│   ├── runner/         # 订阅/长连接运行器
│   └── admin-cli/      # 运维 CLI 工具
├── packages/
│   └── shared/         # 共享类型、工具函数、策略引擎
├── skills/             # Skill 包目录
│   ├── echo-skill/
│   ├── math-skill/
│   ├── http-fetch-skill/
│   ├── imap-poll-skill/
│   ├── exchange-poll-skill/
│   ├── slack-send-skill/
│   ├── webhook-send-skill/
│   └── ...             # 更多内置技能
├── docker-compose.yml  # 基础设施编排
├── tsconfig.base.json  # TypeScript 基础配置
└── package.json        # Monorepo 根配置
```

## 📡 API 概览

### 统一请求链路

| 特性 | 说明 |
|------|------|
| 认证 | `Authorization: Bearer <token>`（支持 dev / hmac 模式） |
| 追踪 | `x-trace-id`（可选），所有响应回显 `traceId` + `requestId` |
| 幂等 | 写操作使用 `idempotency-key` |
| 多语言 | `x-user-locale` / `Accept-Language` |

### 核心模块 API

<details>
<summary><b>通用 CRUD & 数据平面</b></summary>

- `GET/POST /entities/:entity` — 通用实体读写
- `POST /entities/:entity/query` — 结构化查询（filters / orderBy / cursor）
- `POST /entities/:entity/export` — 异步导出
- `POST /entities/:entity/import` — 批量导入（dry_run / commit）
- `GET /artifacts/:artifactId/download` — 产物下载

</details>

<details>
<summary><b>AI 编排 & 工作流</b></summary>

- `POST /orchestrator/turn` — 编排器对话轮
- `GET /runs` / `GET /runs/:runId` — 工作流运行查询
- `POST /runs/:runId/cancel` / `approve` / `reject` — 运行控制
- `GET /runs/:runId/replay` — 运行回放
- `GET /approvals` — 审批列表与决策

</details>

<details>
<summary><b>工具 & Skill</b></summary>

- `POST /tools/:name/publish` — 发布工具 / Skill 包
- `GET /tools` — 工具目录
- `POST /tools/:toolRef/execute` — 执行工具
- `GET /tools/runs/:runId` / `GET /tools/steps/:stepId` — 执行追踪

Skill 包结构：
```
skills/<skill-name>/
├── manifest.json      # 身份 / 合约 / IO / 入口
└── dist/index.js      # 导出 execute(req)
```

</details>

<details>
<summary><b>知识库 & RAG</b></summary>

- `POST /knowledge/documents` — 文档摄取
- `POST /knowledge/search` — 多阶段检索（关键词 + embedding + rerank）
- `POST /knowledge/evidence/resolve` — 证据链引用解析
- 治理端：检索日志、作业监控、质量评估

</details>

<details>
<summary><b>记忆</b></summary>

- `POST /memory/entries` — 写入（writePolicy=confirmed）
- `POST /memory/search` — 检索
- `GET /memory/entries` / `DELETE /memory/entries/:id` — 管理
- `PUT /memory/task-states/:runId` — 任务状态持久化

</details>

<details>
<summary><b>治理 & 变更集</b></summary>

- `POST /governance/changesets` — 创建变更集
- 流程：`draft → submit → approve → release → rollback`
- `POST /governance/changesets/:id/release?mode=canary` — 灰度发布
- `POST /governance/changesets/:id/preflight` — 预检摘要
- 评测准入：`POST /governance/evals/suites/:id/runs`
- 工具启用/禁用：`POST /governance/tools/:toolRef/enable|disable`

</details>

<details>
<summary><b>模型网关</b></summary>

- `GET /models/catalog` — 模型目录
- `POST /models/bindings` — 模型绑定
- `POST /models/chat` — 对话调用

</details>

<details>
<summary><b>设备 & 具身智能</b></summary>

- `POST /devices` — 设备注册
- `POST /devices/:deviceId/pairing` — 设备配对
- `POST /device-executions` — 创建设备执行
- 设备代理：`npm run dev -w @openslin/device-agent -- pair|run`

</details>

<details>
<summary><b>连接器 & 渠道</b></summary>

- 连接器：IMAP / Exchange / SMTP / Webhook
- `POST /connectors/instances` — 创建连接器实例
- `POST /channels/webhook/ingress` — Webhook 入站
- 通知模板 & Outbox：模板版本化 + 异步投递 + 死信重试

</details>

<details>
<summary><b>RBAC & 审计</b></summary>

- `POST /rbac/roles` / `POST /rbac/permissions` / `POST /rbac/bindings` — 角色权限管理
- `GET /audit?traceId=...` — 审计检索
- `GET /audit/verify` — 审计完整性校验
- `POST /spaces/:spaceId/backups` — 空间级备份

</details>

<details>
<summary><b>多智能体 & 任务</b></summary>

- `POST /tasks` — 创建任务
- `POST /tasks/:taskId/messages` — 智能体间消息
- `GET /tasks/long-tasks` — 长任务中心

</details>

<details>
<summary><b>离线同步</b></summary>

- `POST /sync/push` — 增量推送
- `POST /sync/pull` — 增量拉取
- 支持 opId 幂等、冲突输出、可回放摘要

</details>

## 🔐 安全与治理

> ⚠️ 本仓库默认 dev 模式仅用于本地开发与测试，**不应直接用于生产**。

### 认证

| 模式 | 配置 | 说明 |
|------|------|------|
| dev（默认） | `AUTHN_MODE=dev` | token = `subjectId[@spaceId]`，仅限本地开发 |
| hmac | `AUTHN_MODE=hmac` | HMAC-SHA256 签名 token，含过期时间 |
| 生产 | 自定义 | 必须替换为企业级认证方案 |

### Safety / DLP

- `DLP_MODE=audit_only|deny`（默认 audit_only）
- deny 模式下命中敏感信息直接拦截返回 `DLP_DENIED`

### Skill 运行时安全

| 配置 | 说明 |
|------|------|
| `SKILL_RUNTIME_BACKEND` | `process` / `container` / `auto` |
| `SKILL_TRUST_ENFORCE` | 未签名包拒绝执行（生产默认启用） |
| `SKILL_DEP_SCAN_MODE` | `deny` / `audit_only` / `off` |
| `SKILL_RUNTIME_UNSAFE_ALLOW` | 紧急绕过（不推荐） |
| 出站治理 | host 白名单 + 路径/方法级规则 |

### 生产部署检查清单

- [ ] 配置 `API_MASTER_KEY`（禁止使用 dev master key）
- [ ] 切换 `AUTHN_MODE=hmac` 或更严格认证
- [ ] `.env` 密钥不落库、不提交
- [ ] 启用 DLP deny 模式
- [ ] 启用 Skill 信任策略 & 依赖扫描
- [ ] 配置出站网络策略白名单

## 📊 可观测性

系统导出 Prometheus 兼容指标：

| 指标 | 说明 |
|------|------|
| `openslin_governance_pipeline_actions_total` | 治理流水线操作计数 |
| `openslin_governance_gate_failed_total` | 治理门禁失败计数 |
| `openslin_knowledge_search_total` / `_duration_ms` | 知识检索计数与耗时 |
| `openslin_knowledge_evidence_resolve_total` / `_duration_ms` | 证据链解析计数与耗时 |
| `openslin_sync_push_total` / `_duration_ms` / `_conflicts_total` | 离线同步推送统计 |
| `openslin_sync_pull_total` / `_duration_ms` / `_ops_returned` | 离线同步拉取统计 |

## 🌍 社会价值愿景

灵智项目秉持 **技术进步惠及全社会** 的理念：

- **保障就业结构** — 实现智能化自动化的企业和系统，必须保持现有经济结构不变。即使没有员工实际工作，也要继续支付薪酬、社会福利和税收。
- **拒绝恶性竞争** — 企业应专注于提供优质服务，通过服务质量与用户体验竞争，而非价格战。
- **禁止裁员** — 任何企业或单位不得因技术进步开除员工，这是维持社会稳定的基本要求。
- **安全人才需求** — 智能体系统在安全和权限管理方面达到极度精细化的程度，各行业需要大量安全专业人才（网络安全、数据隐私、AI 伦理、法律合规等）。
- **机器人行业规范** — 严禁降价恶性竞争，应大规模雇佣维持经济结构稳定，同时提供优质服务。

> 详见 [社会价值治理机制](社会价值治理机制-透明底线与市场自发调节.md)

## 🙏 特别感谢

本项目的发展离不开以下公司和组织的技术贡献与启发：

<table>
<tr>
<td>

**中国科技公司**
- DeepSeek 深度求索 ⭐
- 阿里巴巴（通义千问）
- 腾讯（混元）
- 华为（盘古）
- 字节跳动（豆包）⭐
- 月之暗面（Kimi）
- 智谱 AI（ChatGLM）
- MiniMax（ABAB）
- 百度（文心）
- 科大讯飞（星火）
- 百川智能
- 商汤科技（日日新）

</td>
<td>

**国际 AI 公司**
- OpenAI (GPT)
- Google DeepMind (Gemini)
- xAI (Grok)
- Meta AI (Llama)
- Microsoft (Azure AI)
- Mistral AI

**社区与平台**
- OpenClaw · Copaw
- GitHub · Gitee
- 各类开源社区贡献者

</td>
</tr>
</table>

> ⭐ 特别感谢 DeepSeek 和豆包提供大量建议，以及豆包取名「灵智」。

## 📬 社区与联系方式

| 平台 | 账号 |
|------|------|
| 抖音 | 伏城-灵智mindpal |
| B 站 | 灵智mindpal |
| 小红书 | 灵智mindpal |
| 微博 | 灵智mindpal |
| X   | 灵智mindpal |


## 📄 许可证

本项目基于 [OpenMindPal License 1.0](LICENSE) 发布 — 一个致力于社会和谐与均衡发展的开源许可证。

