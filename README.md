# 黑怕巅峰对决 · HeiPaClub

**正式站已上线： [https://heipaclub.com/](https://heipaclub.com/)**

给你的本命 Rapper / HitSong 办一场真正的说唱巅峰对决。玩法灵感特别鸣谢 [MusicCup.app](https://musiccup.app)。

## 现在能玩什么

| 玩法 | 说明 |
|------|------|
| **单曲 1v1** | 按歌手开赛，默认热门签表 32 强单败淘汰 |
| **自组 32 强** | 可把曲库扩到 Top 100 / 全部歌曲，再自己勾选正好 32 首开赛 |
| **厂牌巅峰混战** | 两大厂牌混抽对决 |
| **锐评从夯到拉** | 挑一批 Rapper 做夯→拉分层锐评 |
| **排行榜** | 中文 / 欧美歌曲榜、歌手榜，以及厂牌累计 |

其他体验：

- **免登录**：赛程存在本机 `localStorage`
- **试听**：优先 iTunes 试听，必要时回退网易云
- **分享图**：终场可生成 / 保存对阵分享图（Canvas）
- **热门秒开**：常用歌手（粉丝 ≥ 50 万等）走打包静态 Top；其余先查 Cloudflare KV（24h），再打实时接口

## 技术栈（线上）

```text
浏览器  →  Cloudflare Worker（heipaclub）
              ├─ 静态前端（Vite Assets）
              ├─ /api/rank/*     → D1（heipaclub-rank）
              ├─ /api/artist-top → KV（ARTIST_TOP，24h）
              ├─ /api/netease/*  → 自建 api-enhanced（NETEASE_API_ORIGIN）
              └─ /api/img        → 封面图代理
```

- 前端：Vite + 原生 JS
- 边缘：[`cf-api/index.js`](cf-api/index.js)（Wrangler）
- 曲库源：自托管 [api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)（**不能**跑在 Workers 上）

## 仓库结构（常用）

```text
heipaclub/
├─ src/                 # 前端：主流程、排行榜、分享图、热门静态包…
├─ src/data/hot-tops/   # 热门歌手 Top 预打包 JSON（`npm run hot-tops`）
├─ cf-api/              # Worker：排行榜 / KV / 网易云反代 / 图片代理
├─ scripts/             # 名单、封面、hot-tops 等维护脚本
├─ schema.sql           # D1 表结构
└─ wrangler.jsonc       # 部署与 D1 / KV 绑定
```

## 本地运行

```bash
# 0) Cloudflare 登录 + 本地密钥 + 本地 D1
npx wrangler login
copy .dev.vars.example .dev.vars   # Windows
# cp .dev.vars.example .dev.vars  # macOS / Linux
npm run db:init:local

# 1) 网易云 API（另开终端）
cd ../api-enhanced
npm start

# 2) 站点（含 Worker /api）
cd ../heipaclub
npm run dev
```

打开 http://127.0.0.1:5173  

- 首页 `#/` · 排行榜 `#/rank` · 厂牌混战 `#/label-beef` · 从夯到拉 `#/hangla`

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 本地开发 |
| `npm run deploy` | `vite build` + 部署到 Cloudflare |
| `npm run hot-tops` | 重新生成热门歌手静态 Top 包（需本机 api-enhanced） |
| `npm run roster` | 重建歌手名单 |
| `npm run db:init` / `db:init:local` | 初始化远程 / 本地 D1 |

## 排行榜与防刷

| 接口 | 说明 |
|------|------|
| `POST /api/rank/win` | 夺冠匿名 +1 |
| `GET /api/rank/songs` | 歌曲榜 |
| `GET /api/rank/artists` | 歌手榜 |
| `GET /api/rank/meta` | 汇总信息 |

约定简要：

- 不收集账号、完整签表；只聚合夺冠次数
- **日配额**：同一浏览器 Cookie 约每天 5 票；同一公网 IP 约每天 15 票（兜底）
- 前端同会话同曲去重；身份以稳定 Cookie 为主（避免手机换 IP 导致限额失效）

## 热门曲库加速

点开歌手时：

1. **静态包**（`src/data/hot-tops/`）→ VIP / 常用歌手秒开  
2. **KV** `GET/PUT /api/artist-top` → 冷门 24h 记忆  
3. **实时** `/api/netease/artist/top/song` → 写入 KV  

开赛页还可「再展开到 Top 100 / 展示全部」→ `/artist/songs?order=hot` 分页补库，再一键开赛或自组 32 强。

## 部署到 Cloudflare（概况）

线上一站式部署：

```bash
npm run deploy
```

首次还需：

1. D1：`npm run db:create` → 填入 `wrangler.jsonc` → `npm run db:init`  
2. KV：`ARTIST_TOP`（已在 `wrangler.jsonc` 绑定）  
3. 自建 api-enhanced 公网地址，写入 Secret：

```bash
npx wrangler secret put NETEASE_API_ORIGIN
# 例：https://ncm.example.com
```

部署后自检：

- https://heipaclub.com/api/rank/meta  
- https://heipaclub.com/api/netease/search?keywords=法老&limit=1  

`worker/` 是早期独立 Rank Worker 目录，现已合并进 `cf-api/`，一般不必再单独部署。

## 关于作者

站点介绍见线上「关于本站」。作者 GitHub：[@yiziff](https://github.com/yiziff)。

## License / 声明

本项目仅供学习与交流；曲库、试听与封面版权归原平台/权利人所有。玩法灵感致谢 [MusicCup](https://musiccup.app)。
