# Rank Worker (Cloudflare)

匿名排行榜：D1 聚合夺冠次数，无账号。

## 一次性配置

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create cn-rap-cup-rank
```

把输出的 `database_id` 填进 `wrangler.toml`，然后：

```bash
npm run db:init
npm run deploy
```

## 接到域名

任选其一：

- Worker 自定义域 / 路由：`heipaclub.com/api/rank/*`
- 或 Pages 的 Functions/反向代理到本 Worker

前端已请求相对路径 `/api/rank/*`，与本地 Vite 代理一致。

## 本地用 Wrangler（可选）

```bash
npm run db:init:local
npm run dev
```

默认 `http://127.0.0.1:8787`；把根目录 `vite.config.js` 里 rank 代理改到该端口即可。  
日常开发更简单：根目录 `npm run rank:dev`（JSON 文件）。
