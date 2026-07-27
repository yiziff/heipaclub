# 真说唱巅峰对决

中文说唱 1v1 淘汰赛：按歌手办赛，用网易云热门 Top 50 选出本命曲。  
灵感来自 [MUSIC CUP](https://musiccup.app/?lang=hans)。

- 对局进度只存在浏览器 `localStorage`（无需注册）
- 夺冠后匿名上报歌曲/歌手 ID，生成全站排行榜
- 播放走本机 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)

## 本地运行

开 **3 个终端**：

```bash
# 1) 网易云 API
cd ../api-enhanced
npm start

# 2) 匿名排行榜 API（JSON 文件存储）
cd ../cn-rap-cup
npm run rank:dev

# 3) 前端
npm run dev
```

打开 http://127.0.0.1:5173 · 排行榜 `#/rank`

## 排行榜约定

| 接口 | 说明 |
|------|------|
| `POST /api/rank/win` | 夺冠匿名 +1（同会话同曲只报一次） |
| `GET /api/rank/songs` | 歌曲榜 Top 150 |
| `GET /api/rank/artists` | 歌手榜 |

不收集账号、完整签表、设备号；仅聚合夺冠次数。

## 上线（Cloudflare）

### 前端（Workers + 静态资源）

仓库根目录已有 `wrangler.jsonc`（托管 `dist`，SPA 回退）。

Cloudflare 控制台建议：

| 项 | 值 |
|----|----|
| Build command | `npm run build`（可留空，若 Deploy 已含 build） |
| Deploy command | `npm run deploy` |
| Output directory | `dist` |

**注意：** Deploy 必须写成 `npm run deploy`（内部是 `build && wrangler deploy`）。只写 `npx wrangler deploy` 时，Cloudflare 可能不先 build，还会误进 Vite 自动 setup。

### 其余

1. 排行榜：见 [`worker/`](./worker/)（Worker + D1，与前端 Worker 分开）  
2. 音乐：自建小服务器跑 api-enhanced，反代 `/api/netease`

本地 `data/rank-store.json` 仅开发用；生产用 D1。

## 名单维护

```bash
npm run roster
node scripts/clean-roster.mjs
```
