# 安装部署与启动（Docker Desktop）

本文定义本项目推荐的本地启动方式：使用 Docker Desktop + docker compose 先启动通用依赖（数据库/缓存/对象存储），后续应用代码落地后再把 BFF/API、Web/UI、队列 Worker 等服务加入 compose。

## 1. 前置条件

- 安装 Docker Desktop
- 启用 WSL2（Windows 环境推荐）
- 确保本机端口未被占用：5432（Postgres）、6379（Redis）、9000/9001（MinIO）

## 2. 启动依赖服务（推荐）

本仓库提供一份本地依赖的 compose：

- [docker-compose.yml](docker-compose.yml)
- [.env.example](.env.example)

步骤：

1) 复制环境文件

将 `.env.example` 复制为 `.env` 并按需修改

2) 启动

```bash
docker compose up -d
```

3) 验证

- Postgres：localhost:5432
- Redis：localhost:6379
- MinIO Console：http://localhost:9001/

## 3. 应用服务如何接入 compose（目标形态）

当应用代码落地后，建议把以下服务加入 compose（示例，不要求一次到位）：

- web：Next.js UI
- api：BFF/API（统一链路）
- worker：Workflow/Queue 执行器（处理异步 Job/Run/Step）
- optional：model-gateway、knowledge-indexer 等按需拆出

原则：

- 应用服务通过环境变量连接 Postgres/Redis/MinIO
- 生产环境不要沿用本地默认口令；密钥通过 Secrets/Key Contract 托管
- 对外暴露端口尽量只保留 web/api；其余服务仅在内部网络通信

