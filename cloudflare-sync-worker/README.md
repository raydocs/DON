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
确保已安装 [Node.js](https://nodejs.org) 24 LTS 与 `pnpm`，并且拥有 Cloudflare 账号。Wrangler 4 要求 Node.js 22 或更新版本。

本项目固定使用 Wrangler 4.110.0 与对应的 Workers 类型，保持稳定的 Miniflare 4 工具链，避免安装时自动切换到 Miniflare 5 alpha。Miniflare 的 Undici 7 通过同主版本安全覆盖升级至 7.29.0；没有将 Undici 5 强行替换为不兼容的主版本。升级工具链时应重新检查完整 OSV 扫描与本地运行验证。

### 从 Wrangler 3 迁移

- Wrangler 4 的 R2/KV 对象命令默认操作本地数据。仓库的备份/恢复脚本显式使用 `--remote`，保留远程备份语义；它们会读写真实 R2，不要把它们当成本地测试。
- D1 脚本继续明确区分 `d1:migrate:local` 与 `d1:migrate:remote`。现有 `nodejs_compat` 与 `compatibility_date` 不变；没有启用远程开发绑定。
- 新 esbuild 会将动态通配符导入匹配的文件加入构建。本 Worker 没有此类运行时导入，也不使用已删除的 `publish`、`getBindingsProxy` 或 `node_compat` 接口。
- 无凭据验证可使用 `pnpm exec wrangler deploy --dry-run`；本地 D1/R2 命令必须带 `--local`，并通过 `--persist-to` 指向独立临时目录。`wrangler dev` 默认本地运行。以上检查不替代远程权限、Cloudflare Access 策略或生产数据验证。

完整变更参见 [Wrangler 3 → 4 迁移指南](https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/)。

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

### 4. 设置你的安全同步 Token
```bash
# 设置主访问密钥（此 Token 将填入 DON 桌面客户端）
npx wrangler secret put SYNC_TOKEN
```
*(输入你自定义的强密码，如 `my-super-secret-sync-token-2026`)*

> **安全提醒**：建议同步轮换默认的 `ADMIN_EMAILS`，避免使用仓库内公开默认值：
> ```bash
> npx wrangler secret put ADMIN_EMAILS   # 逗号分隔的管理员邮箱，例如 alice@example.com,bob@example.com
> ```

### 5. （可选）启用 Cloudflare Zero Trust Access 免密管理员登录
若希望通过 Cloudflare Access 实现浏览器免密登录管理控制台，需要：

1. 在 Cloudflare Zero Trust 控制台为该 Worker（尤其是 `/api/admin/*` 路由）创建一个 Application 与访问策略，使所有到达管理 API 的请求都经过 Access 鉴权。
2. 在应用配置中记录 **Team Domain**（形如 `https://<your-team>.cloudflareaccess.com`）与 **Application Audience ID**（一个 UUID）。
3. 通过 secret 配置 JWT 校验所需的环境变量（二者缺一不可，任一为空则 Access 登录路径自动关闭、回退到 `SYNC_TOKEN` / D1 管理员 Token）：
   ```bash
   npx wrangler secret put CF_ACCESS_TEAM_DOMAIN   # 例如 https://myteam.cloudflareaccess.com
   npx wrangler secret put CF_ACCESS_AUD           # Application Audience ID (UUID)
   ```
4. 配置好 `ADMIN_EMAILS`（步骤 4）以指定哪些 Access 邮箱可获准管理员身份。

启用后，Worker 仅信任经过 **签名 + `iss` + `aud` 校验** 的 `Cf-Access-Jwt-Assertion` / `CF_Authorization` JWT；任何客户端自行伪造的 `cf-access-*`、`cf-access-jwt-assertion`（含 `alg: none` 未签名令牌）或 `x-admin-email` 头都不会被授予管理员身份。

### 6. 一键部署到 Cloudflare Workers
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
