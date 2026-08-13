# 上线不到多久就被玩了 5000+ 次：我做了个「说唱巅峰对决」网站，求个 Star ⭐

> 先给结论：如果你喜欢说唱、喜欢「两两对比选本命」，或者想看一个 **Vite + Cloudflare Workers + D1/KV** 的完整小产品案例——欢迎点开玩一把，顺手给仓库点个 Star。

- 线上地址：[https://heipaclub.com](https://heipaclub.com)
- GitHub 仓库：[https://github.com/yiziff/heipaclub](https://github.com/yiziff/heipaclub) ← **求 Star，真的很需要**

---

## 写在前面

做这个项目的初衷很简单：  
**给你的本命 RapStar / Hit Song，办一场真正的说唱巅峰对决。**

灵感来自 MusicCup 一类「音乐淘汰赛」玩法，但我把它做成了更偏「黑怕圈」的完整站点：免登录、能试听、能分享对阵图，还带全站实时排行榜。

上线之后没怎么大规模推，结果已经有 **超过 5000 人** 玩过。  
这说明一件事——大家其实很吃这种「轻量、上头、能截图发朋友圈」的小玩具。

所以今天写这篇，一是给大家介绍一下项目，二是诚恳求个 Star：开源仓库现在还很安静，**如果你觉得好玩或代码有参考价值，麻烦点一下 Star**，对我继续迭代真的很有帮助。

仓库再贴一次：[https://github.com/yiziff/heipaclub](https://github.com/yiziff/heipaclub)

---

## 这是个什么站？

**黑怕巅峰对决 · HeiPaClub**

一句话概括：

> 选歌手 / 选歌 / 选厂牌，一路 1v1 点到冠军；结果可以上榜，对阵图可以导出分享。

特点：

| 体验 | 说明 |
|------|------|
| 零账号 | 赛程存在本机 `localStorage`，刷新不丢 |
| 可试听 | iTunes 预览优先，网易云兜底 |
| 可分享 | Canvas 导出对阵海报，带二维码和 slogan |
| 有排行榜 | 冠军单曲、歌手、厂牌胜率、夯/拉双榜实时聚合 |
| 秒开热门 | 高粉歌手走静态 Top 包，冷门再走 KV / 实时接口 |

直接打开玩：[https://heipaclub.com](https://heipaclub.com)

---

## 现在能玩什么（5 种模式）

### 01 · 单曲 1v1

选中本命歌手，默认热门签表 **32 强单败**，一路点到冠军。  
最经典、也最好上头。

### 02 · 自组 32 强

曲库可扩到 Top 100 / 全部，自己勾正好 32 首再开战。  
适合「我就要把冷门神专塞进签表」的玩家。

### 03 · 厂牌巅峰混战

两大厂牌混抽对决，还有厂牌胜率榜、对阵明细和冠军单曲。  
厂牌粉友好度拉满。

### 04 · 锐评从夯到拉

随机抽 15 人，给你五个档位：

`夯 / 顶级 / 人上人 / npc / 拉完了`

全站同步累计「最夯榜」和「最拉榜」——杀伤力很大，建议慎用（开玩笑）。

### 05 · 排行榜

实时冠军单曲、歌手、厂牌胜率、夯拉双列；中文 / 欧美可切换。  
做了日配额防刷，尽量让榜单更干净一点。

---

## 为什么值得 Star？（给技术同学）

如果只是玩，点开网站就够了。  
如果你也写前端 / 边缘计算，这个仓库可能更有参考价值：

### 技术栈很「边缘原生」

```text
Browser  ──►  Cloudflare Worker · heipaclub
                 ├─ Vite 静态前端
                 ├─ /api/rank/*          D1 排行榜
                 ├─ /api/artist-top      KV 缓存（24h）
                 ├─ /api/netease/*       反代自建网易云 API
                 └─ /api/img             封面 CORS 代理
```

- 前端：Vite + 原生 JS（没有硬上重框架）
- 边缘：Cloudflare Workers（Wrangler）
- 数据：D1（排行）+ KV（歌手 Top 缓存）
- 曲库：自托管 api-enhanced（Workers 上跑不了，所以走反代）

### 工程上我比较在意的点

1. **热门秒开**：静态包 → KV → 实时接口，三层降级  
2. **零账号也能有排行**：只聚合结果次数，不存完整签表  
3. **防刷**：Cookie / IP 日配额 + 前端同会话去重  
4. **分享即海报**：Canvas 导出，适合传播  
5. **完整可部署**：`wrangler.jsonc`、migrations、schema 都在仓库里

对独立开发者来说，这基本是一个「能上线、能传播、有数据闭环」的小产品模板。

源码在这里，欢迎 Star / Fork / Issue：  
**[https://github.com/yiziff/heipaclub](https://github.com/yiziff/heipaclub)**

---

## 本地跑起来（可选）

```bash
# 0 · Cloudflare + 密钥 + 本地 D1
npx wrangler login
cp .dev.vars.example .dev.vars
npm run db:init:local

# 1 · 网易云 API（另开终端）
cd ../api-enhanced && npm start

# 2 · 站点（含 Worker /api）
cd ../heipaclub && npm run dev
```

本机访问：`http://127.0.0.1:5173`

常用命令：

- `npm run dev`：本地开发  
- `npm run deploy`：build + 部署到 Cloudflare  
- `npm run hot-tops`：重打热门静态包  

更完整的说明见仓库 README。

---

## 一些真实感受

1. **玩法比功能列表更重要**  
   大家留下来，不是因为我写了多少 API，而是「两首歌放一起，你只能留一首」这件事本身就有情绪。

2. **分享图是增长引擎**  
   对阵图能导出、能发朋友圈，比「再加一个设置页」有效得多。

3. **开源不等于自动有 Star**  
   项目已经有 5000+ 人次体验，但仓库 Star 还很少——所以才写这篇，**真诚求个 Star**。

如果你正好刷到这里：

1. 先玩 3 分钟：[https://heipaclub.com](https://heipaclub.com)  
2. 觉得还行，就去仓库点 Star：[https://github.com/yiziff/heipaclub](https://github.com/yiziff/heipaclub)  
3. 有 bug / 想加玩法，欢迎提 Issue

---

## 最后再求一次 Star

项目地址（复制即用）：

```text
https://github.com/yiziff/heipaclub
```

线上站点：

```text
https://heipaclub.com
```

**已经有超过 5000 人玩过。**  
如果这篇文章对你有一点点帮助——哪怕只是开心了一下——麻烦给仓库点个 Star ⭐。  
开源项目最缺的往往不是代码，而是第一批愿意举手的人。

感谢每一位试玩、转发、提建议的朋友。  
作者：[yiziff](https://github.com/yiziff)

---

**声明**：本项目仅供学习与交流；曲库、试听与封面版权归原平台 / 权利人所有。玩法灵感致谢 [MusicCup](https://musiccup.app)。

---

### 建议标签（发 CSDN 时可选用）

`开源项目` `Cloudflare Workers` `Vite` `前端` `说唱` `独立开发` `D1` `KV` `小产品`
