# DON Cloudflare Serverless Sync Service (Worker + D1 + R2)

针对 **DON / DonutBrowser** 的高可用、零运维、0 出站流量费的 Serverless 云同步与选择性同步（Selective Sync）后端服务。

---

## 🌟 架构亮点

1. **0 流量费（Zero Egress Fees）**：底层数据分块使用 **Cloudflare R2** 对象存储，完全免除 AWS S3 昂贵的出站流量费用。
2. **极速边缘计算**：基于 **Cloudflare Workers** + **Hono** 全球边缘低延迟路由，秒级响应。
3. **选择性同步（Selective Sync）**：通过 **Cloudflare D1**（边缘 SQLite）管理用户权限、设备绑定与 Profile 云端元数据目录，支持多设备按需勾选拉取。
4. **完全兼容 DON 客户端**：无缝对接 DON 桌面端内置的 `SyncClient` 协议，无需重构客户端传输引擎。

---

## 🚀 5 分钟一键部署指南

### 前置准备
确保已安装 [Node.js](https://nodejs.org) 与 `pnpm`，并且拥有 Cloudflare 账号。

### 1. 安装依赖并登录 Cloudflare
```bash
cd cloudflare-sync-worker
pnpm install
npx wrangler login
```

### 2. 创建 Cloudflare R2 存储桶
```bash
npx wrangler r2 bucket create don-sync-bucket
```

### 3. 创建 Cloudflare D1 数据库并初始化表结构
```bash
# 创建 D1 数据库
npx wrangler d1 create don-sync-db
```
*执行后终端会输出 `database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`，请将该 ID 填入 `wrangler.toml` 中的 `database_id` 字段。*

```bash
# 初始化 D1 表结构（远程部署）
npx wrangler d1 execute don-sync-db --remote --file=./schema.sql
```

### 4. 设置你的安全同步 Token 与签名密钥
```bash
# 主访问密钥（此 Token 将填入 DON 桌面客户端，用于 /v1/* 接口鉴权）
npx wrangler secret put SYNC_TOKEN
# HMAC 签名密钥（用于 /raw/get 与 /raw/put 直连 R2 传输 URL 的签名与校验）
# 强烈建议单独设置；若未设置，将回退到 SYNC_TOKEN
npx wrangler secret put SIGNING_SECRET
```
*（输入自定义的强随机值，例如 `openssl rand -hex 32`。切勿使用仓库中曾经出现的公共默认值 `don-signing-secret` / `don-secret-sync-token` / `default-don-signing-secret`，Worker 会在启动后首次签名/校验时直接拒绝此类已知公共占位符。）*

> **⚠️ 安全须知 / 迁移提示**：`wrangler.toml` 的 `[vars]` 不再包含 `SYNC_TOKEN` / `SIGNING_SECRET` 明文默认值（Cloudflare 的 `[vars]` 为明文配置，任何能读取仓库的人都能看到，不能存放敏感信息）。请务必在 `wrangler deploy` **之前**通过上面的 `wrangler secret put` 设置好这两个 secret；否则 Worker 会在首次签名或校验 `/raw/*` 传输 URL 时抛出错误并返回 5xx（拒绝服务），这是 fail-closed 行为，确保不会使用可伪造的公共密钥签发/放行传输 URL。

### 5. 一键部署到 Cloudflare Workers
```bash
npx wrangler deploy
```
部署完成后，终端会输出你的 Worker 服务地址，例如：
`https://don-sync-worker.<your-account>.workers.dev`

---

## 🖥️ 在 DON 桌面端连接使用

1. 打开 **DON.app**。
2. 进入 **Settings（设置）** -> **Sync / Account（同步与账户）**。
3. 在 **Sync Server URL** 中填入：
   ```text
   https://don-sync-worker.<your-account>.workers.dev
   ```
4. 在 **Sync Token** 中填入你刚才设置的 `SYNC_TOKEN`。
5. 点击 **Save & Test Connection（测试连接）**。
6. 测试通过后，你在 DON 中创建的任意 Profile 即可自动或按需与 Cloudflare 云端实现安全加密同步！

---

## 📡 API 路由清单

### 1. 基础探活
* `GET /health`：健康检查
* `GET /readyz`：服务就绪探针

### 2. 对象与 Profile 同步协议（与 DON SyncClient 100% 兼容）
* `POST /v1/objects/stat`：检查对象是否存在与元数据
* `POST /v1/objects/presign-upload` & `presign-upload-batch`：获取分块上传授权
* `POST /v1/objects/presign-download` & `presign-download-batch`：获取分块下载授权
* `POST /v1/objects/list`：前缀列举对象与分块
* `POST /v1/objects/delete` & `delete-prefix`：删除对象与墓碑记录
* `GET /v1/objects/subscribe`：SSE 实时增量更新事件流
* `GET /raw/get/...` & `PUT /raw/put/...`：R2 原生直连分块传输

### 3. 选择性同步扩展接口（D1）
* `GET /v1/selective-sync/profiles`：列出当前用户/设备可同步的云端 Profile
* `POST /v1/selective-sync/profiles/register`：登记/更新 Profile 云端元数据
* `POST /v1/selective-sync/assign`：管理员分配 Profile 权限给指定设备/用户
