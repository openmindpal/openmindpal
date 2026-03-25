<div align="center">

**English | [中文](README.md)**

# MindPal 灵智

**Your Intelligent Companion — Everything Can Be Modeled, Authorized, and Executed**

[![License](https://img.shields.io/badge/License-OpenMindPal--1.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)

[Quick Start](#-quick-start) · [Architecture](#-architecture-overview) · [API Docs](#-api-overview) · [Community](#-community--contact)

</div>

---

MindPal is a full-stack AI agent platform built on an **18-layer fine-grained architecture**. It provides unified management of data, knowledge, devices, and robots from macro to micro levels, building a lifelong digital life for individuals and organizations (memory, preferences, health, relationships, assets, tasks), and translating decisions into real-world actions through embodied intelligence — **fully controllable, replayable, and accountable**.

## Table of Contents

- [Key Features](#-key-features)
- [Architecture Overview](#-architecture-overview)
- [Tech Stack](#-tech-stack)
- [Quick Start](#-quick-start)
- [Project Structure](#-project-structure)
- [API Overview](#-api-overview)
- [Security & Governance](#-security--governance)
- [Observability](#-observability)
- [Social Value Vision](#-social-value-vision)
- [Acknowledgments](#-acknowledgments)
- [Community & Contact](#-community--contact)
- [License](#-license)

## ✨ Key Features

| Domain | Capabilities |
|--------|-------------|
| **AI Orchestration** | Controlled tool invocation, automatic planning, multi-step workflows, replay & compensation |
| **Multi-Agent Collaboration** | Role-based communication, permission context, collaboration protocols |
| **Knowledge Engine** | Document ingestion, multi-stage retrieval (keyword + embedding + rerank), evidence chain |
| **Long-Term Memory** | Preference storage, session context, task state persistence |
| **Skill Runtime** | Sandboxed isolation, least privilege, outbound network policies, dependency scanning |
| **Governance Control Plane** | Changesets (draft→submit→approve→release→rollback), canary releases, eval gating |
| **Device / Embodied Intelligence** | Device registration & pairing, remote execution, desktop Agent |
| **Universal Data Plane** | Schema-driven CRUD, import/export, offline sync |
| **Security Hub** | Safety/DLP, RBAC, tamper-proof audit logs, fine-grained permissions |
| **Channel Integration** | Webhook, IMAP, Exchange, SMTP, Mock IM |
| **Pluggable Workbenches** | iframe sandbox + CSP isolation, postMessage capability injection |
| **Backup / Restore** | Space-level backup, one-click restore |

## 🏗 Architecture Overview

The system employs an **18-layer fine-grained architecture** covering full lifecycle governance:

```
┌─────────────────────────────────────────────────────────┐
│                 Interaction Plane (UI)                   │
├─────────────────────────────────────────────────────────┤
│                   BFF / API Gateway                     │
├──────────┬──────────┬──────────┬────────────────────────┤
│ Metadata │   Data   │  AuthN/  │     Audit Domain       │
│  Plane   │  Plane   │  AuthZ   │                        │
├──────────┴──────────┴──────────┴────────────────────────┤
│         Workflow & Automation (Approval/Queue/Idempotent)│
├─────────────────────────────────────────────────────────┤
│       AI Orchestration (Planning Kernel / Exec Kernel)  │
├──────────┬─────────────────────┬────────────────────────┤
│ Knowledge│       Memory        │    Model Gateway       │
├──────────┴─────────────────────┴────────────────────────┤
│                     Security Hub                        │
├─────────────────────────────────────────────────────────┤
│       Skill Runtime (Sandbox/Trust/Outbound/Supply)     │
├──────────┬──────────┬──────────┬────────────────────────┤
│Connectors│ Channels │ Device   │  Multi-Agent Collab    │
│          │          │ Runtime  │                        │
├──────────┴──────────┴──────────┴────────────────────────┤
│      Governance Control Plane (Publish/Canary/Rollback) │
└─────────────────────────────────────────────────────────┘
```

> Detailed architecture documentation is available in the `架构-*.md` files in the repository root.

## 🛠 Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript 5.8 |
| Runtime | Node.js 20+ |
| Backend | Fastify |
| Frontend | Next.js (React) |
| Database | PostgreSQL 16 |
| Cache / Queue | Redis 7 |
| Object Storage | MinIO |
| Package Management | npm workspaces (monorepo) |
| Containerization | Docker Compose |

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (for database and other dependencies)
- npm >= 9

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/openslin.git
cd openslin
```

### 2. Start Infrastructure

```bash
docker compose up -d    # PostgreSQL 16 + Redis 7 + MinIO
```

### 3. Configure Environment Variables

```bash
cp .env.example .env    # Modify as needed
```

### 4. Install Dependencies & Initialize Database

```bash
npm install
npm run db:seed -w @openslin/api    # Migration + seed data + core schema
```

### 5. Start Services

```bash
npm run dev:api       # API Server    → http://localhost:3001
npm run dev:worker    # Worker (async jobs)
npm run dev:web       # Web Frontend  → http://localhost:3000
```

### Default URLs

| Service | URL |
|---------|-----|
| Web Home | http://localhost:3000 |
| Settings | http://localhost:3000/settings |
| UI Config | http://localhost:3000/admin/ui |
| RBAC Admin | http://localhost:3000/admin/rbac |
| API Health | http://localhost:3001/health |

### Admin CLI

Read-only / idempotent operations CLI for troubleshooting and ops:

```bash
npm run dev -w @openslin/admin-cli

# Examples
openslin-admin audit verify --apiBase http://localhost:3001 --token <token> --tenantId tenant_dev
openslin-admin models usage --apiBase http://localhost:3001 --token <token> --range 24h
openslin-admin queue status --apiBase http://localhost:3001 --token <token>
```

## 📁 Project Structure

```
openslin/
├── apps/
│   ├── api/            # Fastify API server
│   ├── web/            # Next.js frontend
│   ├── worker/         # Async job processor
│   ├── device-agent/   # Desktop device Agent (CLI)
│   ├── runner/         # Subscription / long-poll runner
│   └── admin-cli/      # Ops CLI tool
├── packages/
│   └── shared/         # Shared types, utilities, policy engine
├── skills/             # Skill packages
│   ├── echo-skill/
│   ├── math-skill/
│   ├── http-fetch-skill/
│   ├── imap-poll-skill/
│   ├── exchange-poll-skill/
│   ├── slack-send-skill/
│   ├── webhook-send-skill/
│   └── ...             # More built-in skills
├── docker-compose.yml  # Infrastructure orchestration
├── tsconfig.base.json  # TypeScript base config
└── package.json        # Monorepo root config
```

## 📡 API Overview

### Unified Request Pipeline

| Feature | Description |
|---------|------------|
| Auth | `Authorization: Bearer <token>` (supports dev / hmac modes) |
| Tracing | `x-trace-id` (optional), all responses echo `traceId` + `requestId` |
| Idempotency | Write operations use `idempotency-key` |
| i18n | `x-user-locale` / `Accept-Language` |

### Core Module APIs

<details>
<summary><b>Universal CRUD & Data Plane</b></summary>

- `GET/POST /entities/:entity` — Generic entity read/write
- `POST /entities/:entity/query` — Structured query (filters / orderBy / cursor)
- `POST /entities/:entity/export` — Async export
- `POST /entities/:entity/import` — Bulk import (dry_run / commit)
- `GET /artifacts/:artifactId/download` — Artifact download

</details>

<details>
<summary><b>AI Orchestration & Workflow</b></summary>

- `POST /orchestrator/turn` — Orchestrator conversation turn
- `GET /runs` / `GET /runs/:runId` — Workflow run queries
- `POST /runs/:runId/cancel` / `approve` / `reject` — Run control
- `GET /runs/:runId/replay` — Run replay
- `GET /approvals` — Approval list & decisions

</details>

<details>
<summary><b>Tools & Skills</b></summary>

- `POST /tools/:name/publish` — Publish tool / Skill package
- `GET /tools` — Tool catalog
- `POST /tools/:toolRef/execute` — Execute tool
- `GET /tools/runs/:runId` / `GET /tools/steps/:stepId` — Execution tracking

Skill package structure:
```
skills/<skill-name>/
├── manifest.json      # Identity / contract / IO / entry
└── dist/index.js      # Exports execute(req)
```

</details>

<details>
<summary><b>Knowledge Base & RAG</b></summary>

- `POST /knowledge/documents` — Document ingestion
- `POST /knowledge/search` — Multi-stage retrieval (keyword + embedding + rerank)
- `POST /knowledge/evidence/resolve` — Evidence chain reference resolution
- Governance: retrieval logs, job monitoring, quality evaluation

</details>

<details>
<summary><b>Memory</b></summary>

- `POST /memory/entries` — Write (writePolicy=confirmed)
- `POST /memory/search` — Search
- `GET /memory/entries` / `DELETE /memory/entries/:id` — Management
- `PUT /memory/task-states/:runId` — Task state persistence

</details>

<details>
<summary><b>Governance & Changesets</b></summary>

- `POST /governance/changesets` — Create changeset
- Flow: `draft → submit → approve → release → rollback`
- `POST /governance/changesets/:id/release?mode=canary` — Canary release
- `POST /governance/changesets/:id/preflight` — Preflight summary
- Eval gating: `POST /governance/evals/suites/:id/runs`
- Tool enable/disable: `POST /governance/tools/:toolRef/enable|disable`

</details>

<details>
<summary><b>Model Gateway</b></summary>

- `GET /models/catalog` — Model catalog
- `POST /models/bindings` — Model binding
- `POST /models/chat` — Chat invocation

</details>

<details>
<summary><b>Device & Embodied Intelligence</b></summary>

- `POST /devices` — Device registration
- `POST /devices/:deviceId/pairing` — Device pairing
- `POST /device-executions` — Create device execution
- Device agent: `npm run dev -w @openslin/device-agent -- pair|run`

</details>

<details>
<summary><b>Connectors & Channels</b></summary>

- Connectors: IMAP / Exchange / SMTP / Webhook
- `POST /connectors/instances` — Create connector instance
- `POST /channels/webhook/ingress` — Webhook ingress
- Notification templates & Outbox: versioned templates + async delivery + dead letter retry

</details>

<details>
<summary><b>RBAC & Audit</b></summary>

- `POST /rbac/roles` / `POST /rbac/permissions` / `POST /rbac/bindings` — Role & permission management
- `GET /audit?traceId=...` — Audit search
- `GET /audit/verify` — Audit integrity verification
- `POST /spaces/:spaceId/backups` — Space-level backup

</details>

<details>
<summary><b>Multi-Agent & Tasks</b></summary>

- `POST /tasks` — Create task
- `POST /tasks/:taskId/messages` — Inter-agent messages
- `GET /tasks/long-tasks` — Long task center

</details>

<details>
<summary><b>Offline Sync</b></summary>

- `POST /sync/push` — Incremental push
- `POST /sync/pull` — Incremental pull
- Supports opId idempotency, conflict output, replayable summary

</details>

## 🔐 Security & Governance

> ⚠️ The default dev mode in this repository is for local development and testing only. **Do not use it in production.**

### Authentication

| Mode | Config | Description |
|------|--------|-------------|
| dev (default) | `AUTHN_MODE=dev` | token = `subjectId[@spaceId]`, local dev only |
| hmac | `AUTHN_MODE=hmac` | HMAC-SHA256 signed token with expiration |
| Production | Custom | Must use enterprise-grade authentication |

### Safety / DLP

- `DLP_MODE=audit_only|deny` (default: audit_only)
- In deny mode, sensitive information is intercepted and returns `DLP_DENIED`

### Skill Runtime Security

| Config | Description |
|--------|-------------|
| `SKILL_RUNTIME_BACKEND` | `process` / `container` / `auto` |
| `SKILL_TRUST_ENFORCE` | Reject unsigned packages (enabled by default in production) |
| `SKILL_DEP_SCAN_MODE` | `deny` / `audit_only` / `off` |
| `SKILL_RUNTIME_UNSAFE_ALLOW` | Emergency bypass (not recommended) |
| Outbound governance | Host allowlist + path/method-level rules |

### Production Deployment Checklist

- [ ] Configure `API_MASTER_KEY` (never use dev master key)
- [ ] Switch to `AUTHN_MODE=hmac` or stricter authentication
- [ ] Ensure `.env` secrets are not committed to version control
- [ ] Enable DLP deny mode
- [ ] Enable Skill trust policy & dependency scanning
- [ ] Configure outbound network policy allowlist

## 📊 Observability

The system exports Prometheus-compatible metrics:

| Metric | Description |
|--------|-------------|
| `openslin_governance_pipeline_actions_total` | Governance pipeline action count |
| `openslin_governance_gate_failed_total` | Governance gate failure count |
| `openslin_knowledge_search_total` / `_duration_ms` | Knowledge search count & latency |
| `openslin_knowledge_evidence_resolve_total` / `_duration_ms` | Evidence chain resolution count & latency |
| `openslin_sync_push_total` / `_duration_ms` / `_conflicts_total` | Offline sync push stats |
| `openslin_sync_pull_total` / `_duration_ms` / `_ops_returned` | Offline sync pull stats |

## 🌍 Social Value Vision

The MindPal project upholds the philosophy that **technological progress should benefit all of society**:

- **Protect Employment** — Enterprises implementing intelligent automation must maintain existing economic structures. Wages, social benefits, and taxes must continue to be paid even when roles are automated.
- **Reject Destructive Competition** — Enterprises should compete through service quality and user experience, not price wars.
- **No Layoffs** — No enterprise or organization may lay off employees due to technological advancement. This is a fundamental requirement for social stability.
- **Security Talent Demand** — Agent systems require extreme precision in security and permission management. All industries need massive security talent (cybersecurity, data privacy, AI ethics, legal compliance, etc.).
- **Robotics Industry Standards** — Price dumping is strictly prohibited. Large-scale employment should be maintained for economic stability while delivering quality services.

> See [Social Value Governance Mechanism](社会价值治理机制-透明底线与市场自发调节.md) for details.

## 🙏 Acknowledgments

This project's development is made possible by the technical contributions and inspiration from the following companies and organizations:

<table>
<tr>
<td>

**Chinese Tech Companies**
- DeepSeek ⭐
- Alibaba (Qwen)
- Tencent (Hunyuan)
- Huawei (Pangu)
- ByteDance (Doubao) ⭐
- Moonshot AI (Kimi)
- Zhipu AI (ChatGLM)
- MiniMax (ABAB)
- Baidu (ERNIE)
- iFlytek (Spark)
- Baichuan AI
- SenseTime (SenseNova)

</td>
<td>

**International AI Companies**
- OpenAI (GPT)
- Google DeepMind (Gemini)
- xAI (Grok)
- Meta AI (Llama)
- Microsoft (Azure AI)
- Mistral AI

**Communities & Platforms**
- OpenClaw · Copaw
- GitHub · Gitee
- Open source community contributors

</td>
</tr>
</table>

> ⭐ Special thanks to DeepSeek and Doubao for extensive suggestions, and Doubao for naming "MindPal" (灵智).

## 📬 Community & Contact

| Platform | Account |
|----------|---------|
| Douyin (TikTok CN) | 伏城-灵智mindpal |
| Bilibili | 灵智mindpal |
| Xiaohongshu | 灵智mindpal |
| Weibo | 灵智mindpal |
| X   | 灵智mindpal |

## 📄 License

This project is licensed under the [OpenMindPal License 1.0](LICENSE) — an open-source license dedicated to social harmony and balanced development.
