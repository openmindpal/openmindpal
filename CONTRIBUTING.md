# 贡献指南（CONTRIBUTING）

感谢你愿意为 OpenSlin 做贡献。

## 开发环境

- Node.js：建议 20+
- Docker Desktop：用于本地依赖（Postgres/Redis/MinIO）

## 本地启动（开发）

1) 启动依赖

```bash
docker compose up -d
```

2) 准备环境变量

将 `.env.example` 复制为 `.env` 并按需修改（`.env` 不应提交到仓库）。

3) 安装依赖

```bash
npm install
```

4) 初始化数据库（迁移 + 种子数据 + core schema）

```bash
npm run db:seed -w @openslin/api
```

5) 启动 API / Worker / Web

```bash
npm run dev:api
npm run dev:worker
npm run dev:web
```

## 测试

优先保证 API 侧测试通过：

```bash
npm -w apps/api test
```

如需全仓测试：

```bash
npm test
```

## 变更要求（PR）

- 变更说明：说明 Why/What/Impact，并指出是否涉及安全与治理链路
- 兼容性：涉及契约（Schema/Policy/Tool/Workflow/UI 配置）变化时，必须说明兼容策略与回滚路径
- 测试：新增或修改功能应补齐测试或说明验证方式
- 安全：不得提交任何真实密钥、token、私钥文件或生产配置

## 提交信息（建议）

- feat: 新功能
- fix: 修复
- refactor: 重构（不改变外部行为）
- test: 测试
- docs: 文档
- chore: 工程化/杂项
