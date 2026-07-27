/**
 * Build Chinese rap roster: NetEase fans >= MIN_FANS.
 *
 * 1) Seed name search (prefer name-matching hits)
 * 2) Depth-1/2 /simi/artist expansion from those seeds only
 *    (avoids drifting into pop idols while still finding mac ova seas / sakee peers)
 *
 *   npm run roster
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const API = process.env.NETEASE_API_BASE || "http://127.0.0.1:3000";
const MIN_FANS = Number(process.env.MIN_FANS || 20000);
const CACHE_PATH = path.join(ROOT, "src/data/roster-cache.json");
const OUT = path.join(ROOT, "src/data/artists.js");
const SIMI_DEPTH = Number(process.env.ROSTER_DEPTH || 0); // default 0: seeds only, no pop contamination

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED_QUERIES = [
  // user-called-out + digi / chengdu
  "mac ova seas", "MULA SAKEE", "Sakee云雾", "sakee", "Sakee",
  "谟西Mercy", "艾志恒Asen", "mac digi", "扬布拉德", "马赫mood", "Realzat", "小艾斯",
  "Vansdaddy", "KITO", "李文", "Rapeter", "Top Barry", "Vinz-T",
  "连麻Swimming", "SASIOVERLXRD", "JinJiBeWater_隼", "Lil Em", "Spilly Cave",
  "THOME", "Copy", "BT07",
  // 新说唱
  "SHarK", "邓典果DDG", "翁杰Winjay", "泰格西", "Capper", "万妮达Vinida Weng",
  "AThree", "新秀", "辉子", "阿达娃", "DOMMIU李由音", "UUX", "早安",
  "BrAnTB白景屹", "诺亚Noah", "ICE杨长青", "弹壳Danko", "NXN", "李毅杰PISSY",
  "TangoZ", "黄旭BooM", "派克特", "李佳隆", "那吾克热-NW", "PSY.P", "Melo",
  "Yamy郭颖", "李大奔BENZO",
  // 中坚
  "王以太", "杨和苏KeyNG", "KEY.L刘聪", "法老", "马思唯", "TizzyT",
  "那奇沃夫", "kkluv", "CashTrippy", "斑比Bambii", "沙一汀EL", "王齐铭WatchMe",
  "GALI", "NINEONE#乃万", "艾热 AIR", "雾都L4WUDU", "KnowKnow", "梁笑生AIRBUS130",
  "小青龙", "GAI周延", "功夫胖KUNGFU-PEN", "VaVa", "C-BLOCK", "谢帝", "满舒克",
  "艾福杰尼", "MC HotDog 热狗", "Jony J", "暗杠", "盛宇D-SHINE", "小老虎", "Ty.",
  "黄礼格", "Buzzy", "BLOWFEVER", "F.O.O.L", "Ramengvrl拉面女孩", "Dina Ayada",
  "欧阳靖", "PG ONE", "贝贝", "FOX胡天渝", "胡天渝", "龙井说唱 孙旭", "孙旭",
  "李尔新", "Trouble.U", "HipHopMan", "丁飞", "RICHNOMADIC", "404Rapper",
  "AL黄礼格", "FOOLIE", "付思鉴", "西阁", "薛明媛", "不才", "茶理理", "余佳运",
  "JonyJ", "盛宇", "小老虎说唱", "Ty说唱", "GAI", "法老孙阳", "KEY.L",
  "刘聪", "马思唯Masiwei", "王以太", "Tizzy T", "Capper张砚拙", "万妮达",
  "乃万", "阿达娃", "沙一汀", "王齐铭", "GALI说唱", "艾热", "功夫胖",
  "谢帝", "黄旭", "李佳隆", "那吾克热", "派克特PACT", "PSY.P杨俊逸", "Melo墨龙",
  "BrAnTB", "PISSY", "TangoZ钟祺", "早安", "弹壳", "ICE杨长青", "新秀",
  "辉子", "AThree", "翁杰", "泰格西", "NXN", "诺亚Noah", "DOMMIU",
  "斑比", "CashTrippy", "kkluv", "那奇沃夫", "雾都", "梁笑生", "小青龙",
  "Realzat", "小艾斯", "马赫", "KITO", "李文", "Vansdaddy", "扬布拉德",
  "谟西", "艾志恒", "mac digi", "SASIOVERLXRD", "连麻", "隼", "JinJiBeWater",
  "Rapeter", "Top Barry", "Vinz-T", "SHarK", "邓典果", "MULA SAKEE",
  "mac ova seas", "Sakee云雾", "THOME", "Buzzy", "BLOWFEVER", "F.O.O.L",
  "拉面女孩", "Dina Ayada", "龙井说唱", "李尔新", "RICH NOMADIC",
  "HipHopMan丁飞", "TroubleU", "黄礼格", "C-BLOCK", "艾福杰尼", "满舒克",
  "VaVa毛衍七", "MC HotDog", "热狗", "欧阳靖", "PG-ONE", "贝贝红花会",
  "福克斯", "FOX", "Jony J", "暗杠", "盛宇D-SHINE", "小老虎", "Ty.",
];

/** Non-rap / pop contamination */
const HARD_DENY = [
  /邓紫棋|G\.E\.M/i,
  /李荣浩/,
  /王嘉尔|Jackson Wang/i,
  /严浩翔/,
  /黄子韬/,
  /Mozart|莫扎特/i,
  /金知元/,
  /橋本|桥本由香/,
  /成都集团/,
  /A Few Good Kids/i,
  /INDEcompany/i,
  /最后的厂牌/,
  /重庆制燥/,
  /丹镇北京/,
  /Gosh Music/i,
  /^DDG$/,
  /林俊杰|周杰伦|陈奕迅|薛之谦|毛不易|张杰|华晨宇|蔡徐坤|王俊凯|易烊千玺|TFBOYS|时代少年团/i,
  /邓丽君|王菲|那英|张靓颖|李宇春|周深|许嵩|汪苏泷|张碧晨|袁娅维/i,
  /五月天|苏打绿|告五人|告五人|凤凰传奇|羽泉/i,
  /刀郎|刘德华|张学友|郭富城|黎明|周华健|齐秦/i,
  /BLACKPINK|BTS|TWICE|IVE|NewJeans|AESPA|EXO|NCT/i,
  /Taylor Swift|Ariana|Drake(?!\s)|The Weeknd|Eminem|Kanye/i,
  /贝多芬|巴赫|肖邦|李斯特|柴可夫斯基|Galileo/i,
  /Toby Fox|Foxtail|Fox Stevenson|fox capture/i,
  /余佳运/,
  /暗杠/,
  /薛明媛/,
  /^Copy$/i,
  /melo chio/i,
  /Sakee云雾/i,
  /^K\.?ila$/i,
  /^Gai$/, // keep GAI周延
  /茶理理/,
  /蔡明希|不才/,
  /卫彬月/,
  /李文世/,
];

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "artist"
  );
}

function hiRes(url, size = 400) {
  if (!url) return "";
  if (url.includes("param=")) return url;
  return url.includes("?")
    ? `${url}&param=${size}y${size}`
    : `${url}?param=${size}y${size}`;
}

function guessTag(fans) {
  if (fans >= 500000) return "头部";
  if (fans >= 100000) return "高人气";
  if (fans >= 50000) return "新锐热门";
  return "两万粉+";
}

function hardDenied(name) {
  return HARD_DENY.some((re) => re.test(String(name || "")));
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．._\-#]/g, "");
}

function nameScore(query, artistName) {
  const q = norm(query);
  const n = norm(artistName);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.includes(q) || q.includes(n)) return 80;
  // token overlap
  const qt = q.split(/(?=[a-z])|(?<=[a-z])(?=[\u4e00-\u9fff])/i).filter(Boolean);
  let hit = 0;
  for (const t of qt) if (t.length >= 2 && n.includes(t)) hit += 1;
  return hit * 15;
}

async function getJson(pathname) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(API + pathname);
    if (res.status === 405 || res.status === 429 || res.status === 503) {
      await sleep(500 * (i + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error("unavailable");
}

async function searchArtists(keyword, limit = 8) {
  const data = await getJson(
    `/cloudsearch?keywords=${encodeURIComponent(keyword)}&type=100&limit=${limit}`
  );
  return data?.result?.artists || [];
}

async function fanCount(id, cache) {
  const key = `fans:${id}`;
  if (cache[key]?.fans != null) return cache[key].fans;
  const data = await getJson(`/artist/follow/count?id=${id}`);
  const fans = Number(data?.data?.fansCnt || 0);
  cache[key] = { fans, name: cache[key]?.name };
  return fans;
}

async function simiArtists(id) {
  try {
    const data = await getJson(`/simi/artist?id=${id}`);
    return data?.artists || [];
  } catch {
    return [];
  }
}

function upsert(map, artist, fans) {
  if (!artist?.id || hardDenied(artist.name) || fans < MIN_FANS) return false;
  const id = String(artist.id);
  const prev = map.get(id);
  const row = {
    id: prev?.id || slugify(artist.name),
    name: artist.name,
    search: artist.name,
    city: prev?.city || "全国",
    tag: guessTag(fans),
    blurb: `网易云粉丝 ${Number(fans).toLocaleString("zh-CN")} · 热门 Top 50 可办赛。`,
    neteaseArtistId: artist.id,
    avatar: hiRes(artist.img1v1Url || artist.picUrl || artist.avatar || "", 400),
    fans,
  };
  if (!prev || fans > (prev.fans || 0)) {
    map.set(id, row);
    return !prev;
  }
  return false;
}

async function main() {
  try {
    await getJson("/search?keywords=a&limit=1");
  } catch {
    console.error("api-enhanced not reachable at", API);
    process.exit(1);
  }

  const cache = loadCache();
  const roster = new Map();
  /** @type {Map<string, number>} id -> depth */
  const depthOf = new Map();

  const uniqueSeeds = [...new Set(SEED_QUERIES)];
  console.log(`Seeds: ${uniqueSeeds.length} · min fans ${MIN_FANS} · simi depth ${SIMI_DEPTH}`);

  let i = 0;
  for (const q of uniqueSeeds) {
    i += 1;
    const ck = `seed2:${q}`;
    process.stdout.write(`[seed ${i}/${uniqueSeeds.length}] ${q} ... `);
    let picked = cache[ck];
    if (!picked) {
      try {
        const artists = await searchArtists(q, 8);
        const ranked = [];
        for (const a of artists) {
          if (hardDenied(a.name)) continue;
          const score = nameScore(q, a.name);
          const fans = await fanCount(a.id, cache);
          ranked.push({ ...a, fans, score });
          await sleep(40);
        }
        ranked.sort((a, b) => b.score - a.score || b.fans - a.fans);
        // keep strong name matches, or top fan hit if score decent
        picked = ranked.filter((a) => a.score >= 60 || (a.score >= 30 && a.fans >= MIN_FANS));
        if (!picked.length && ranked[0]?.fans >= MIN_FANS && ranked[0].score >= 20) {
          picked = [ranked[0]];
        }
        // always keep explicit high-score
        picked = picked.filter((a) => a.fans >= MIN_FANS);
        cache[ck] = picked.map((a) => ({
          id: a.id,
          name: a.name,
          img1v1Url: a.img1v1Url,
          picUrl: a.picUrl,
          fans: a.fans,
          score: a.score,
        }));
        saveCache(cache);
      } catch (e) {
        console.log("ERR", e.message);
        await sleep(250);
        continue;
      }
    }

    if (!picked.length) {
      console.log("none");
      continue;
    }
    console.log(picked.map((p) => `${p.name}(${p.fans})`).join(", "));
    for (const p of picked) {
      upsert(roster, p, p.fans);
      depthOf.set(String(p.id), 0);
    }
    await sleep(30);
  }

  console.log(`\nSeed roster: ${roster.size}. Expanding simi depth≤${SIMI_DEPTH}...\n`);

  for (let depth = 0; depth < SIMI_DEPTH; depth++) {
    const frontier = [...roster.values()].filter(
      (a) => (depthOf.get(String(a.neteaseArtistId)) ?? 99) === depth
    );
    console.log(`Depth ${depth} → ${depth + 1}: frontier ${frontier.length}`);
    let fi = 0;
    for (const node of frontier) {
      fi += 1;
      const id = node.neteaseArtistId;
      const ck = `simi2:${id}`;
      process.stdout.write(`  [${fi}/${frontier.length}] ${node.name} ... `);
      let sims = cache[ck];
      if (!sims) {
        try {
          const raw = await simiArtists(id);
          sims = [];
          for (const a of raw) {
            if (hardDenied(a.name)) continue;
            const fans = await fanCount(a.id, cache);
            sims.push({
              id: a.id,
              name: a.name,
              img1v1Url: a.img1v1Url,
              picUrl: a.picUrl,
              fans,
            });
            await sleep(35);
          }
          cache[ck] = sims;
          saveCache(cache);
          await sleep(60);
        } catch (e) {
          console.log("ERR", e.message);
          await sleep(250);
          continue;
        }
      }
      let added = 0;
      for (const s of sims) {
        if (s.fans < MIN_FANS) continue;
        const isNew = upsert(roster, s, s.fans);
        const sid = String(s.id);
        if (!depthOf.has(sid)) depthOf.set(sid, depth + 1);
        if (isNew) added += 1;
      }
      console.log(`+${added} · total ${roster.size}`);
    }
  }

  const list = [...roster.values()].sort((a, b) => (b.fans || 0) - (a.fans || 0));
  const used = new Set();
  for (const a of list) {
    let id = a.id;
    let n = 2;
    while (used.has(id)) id = `${a.id}-${n++}`;
    used.add(id);
    a.id = id;
  }

  const body = `/**
 * Auto-built Chinese rap roster: NetEase fans >= ${MIN_FANS}.
 * Discovery: seed search + simi/artist depth ${SIMI_DEPTH}.
 * Regenerate: npm run roster
 * Generated: ${new Date().toISOString()} · ${list.length} artists
 */
export const ARTISTS = ${JSON.stringify(
    list.map(
      ({ id, name, search, city, tag, blurb, neteaseArtistId, avatar, fans }) => ({
        id,
        name,
        search,
        city,
        tag,
        blurb,
        neteaseArtistId,
        avatar,
        fans,
      })
    ),
    null,
    2
  )};

export function getArtist(id) {
  return ARTISTS.find((a) => a.id === id) || null;
}
`;
  fs.writeFileSync(OUT, body, "utf8");

  console.log(`\nKept ${list.length} artists with fans >= ${MIN_FANS}`);
  for (const needle of ["mac ova seas", "MULA SAKEE", "Sakee", "扬布拉德", "Asen"]) {
    const hit = list.find((a) => a.name.toLowerCase().includes(needle.toLowerCase()));
    console.log(`  ${needle}: ${hit ? `${hit.name} (${hit.fans})` : "MISSING"}`);
  }
  console.log("Top 20:");
  list.slice(0, 20).forEach((a) => console.log(`  ${String(a.fans).padStart(8)}  ${a.name}`));
  console.log("Wrote", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
