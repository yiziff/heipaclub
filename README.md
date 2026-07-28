# 黑怕巅峰对决

中文说唱 1v1 淘汰赛：按歌手办赛，用网易云热门 Top 50 选出本命曲。  
灵感来自 [MUSIC CUP](https://musiccup.app/?lang=hans)。

- 对局进度只存在浏览器 `localStorage`（无需注册）
- 夺冠后匿名上报歌曲/歌手 ID，生成全站排行榜
- 播放走自建 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)（经 Worker 反代 `/api/netease`）

## 本地运行

```bash
# 0) 一次性：登录 Cloudflare + 本地 D1 表 + 本地网易云源
npx wrangler login
copy .dev.vars.example .dev.vars
npm run db:init:local

# 1) 网易云 API（另开终端）
cd ../api-enhanced
npm start

# 2) 前端（含 /api/rank + /api/netease 反代）
cd ../heipaclub
npm run dev
```

打开 http://127.0.0.1:5173 · 排行榜 `#/rank`

> 可选：仍可用 `npm run rank:dev`（JSON 文件）+ Vite `proxy`，但默认已走 Worker + 本地 D1。

## 排行榜约定

| 接口 | 说明 |
|------|------|
| `POST /api/rank/win` | 夺冠匿名 +1（同会话同曲只报一次） |
| `GET /api/rank/songs` | 歌曲榜 Top 150 |
| `GET /api/rank/artists` | 歌手榜 |

不收集账号、完整签表、设备号；仅聚合夺冠次数。

## 上线（Cloudflare）

前端、排行榜、网易云反代都在同一个 Worker：`heipaclub`（`cf-api/index.js`）。

### A. 排行榜 D1（一次）

```bash
npx wrangler login
npm run db:create
```

把输出的 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases[0].database_id`，然后：

```bash
npm run db:init
```

### B. 部署 api-enhanced（必须另开 Node 服务）

**不能**跑在 Cloudflare Workers 上。任选其一：

| 方式 | 说明 |
|------|------|
| **VPS / 轻量云 + Docker**（推荐） | `docker run -d -p 3000:3000 --name ncm-api -e CORS_ALLOW_ORIGIN=https://heipaclub.com moefurina/ncm-api:latest` |
| **本仓库 Docker** | `cd ../api-enhanced && docker build -t ncm-api . && docker run -d -p 3000:3000 ncm-api` |
| **Vercel / 腾讯云 SCF** | 见 api-enhanced README（免费层可能不稳） |

得到公网地址，例如 `https://ncm.example.com`（不要带尾斜杠）。

### C. 把网易云源写进 Worker

本地改 `wrangler.jsonc` → `vars.NETEASE_API_ORIGIN`，或：

```bash
npx wrangler secret put NETEASE_API_ORIGIN
# 粘贴: https://ncm.example.com
```

### D. 部署前端 Worker

```bash
npm run deploy
```

Cloudflare 控制台若用 Git 自动部署：

| 项 | 值 |
|----|----|
| Build command | `npm run build`（可留空，若 Deploy 已含 build） |
| Deploy command | `npm run deploy` |
| Output directory | `dist`（Vite 插件会改写为正确产物） |

**注意：** Deploy 必须写成 `npm run deploy`（`build && wrangler deploy`）。

部署后自检：

- `https://heipaclub.com/api/rank/meta` → JSON
- `https://heipaclub.com/api/netease/search?keywords=法老&limit=1` → 网易云结果

### 旧版独立 Rank Worker

`worker/` 目录是早期「单独 Rank Worker」方案，现已合并进根目录 `cf-api/`，一般不用再部署。

## 名单维护

```bash
npm run roster
node scripts/clean-roster.mjs
```
