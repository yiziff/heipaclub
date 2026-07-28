/**
 * Add missing rappers from user checklist (deduped against current roster).
 *   node scripts/add-missing-batch.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS } from "../src/data/artists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../src/data/artists.js");
const API = process.env.NETEASE_API_BASE || "http://127.0.0.1:3000";
const MIN_FANS = 0; // user asked to add all missing; still skip empty/wrong hits
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Missing after roster match (Lil Howcy was a false positive on Lil Wayne). */
const WANTED = [
  { label: "AnsrJ", q: ["AnsrJ"] },
  { label: "BustaZun", q: ["BustaZun", "Busta Zun"] },
  { label: "CreamD", q: ["CreamD", "Cream D"] },
  { label: "丁飞", q: ["HipHopMan丁飞", "丁飞HipHopMan", "丁飞"] },
  { label: "G.G张思源", q: ["G.G张思源", "GG张思源", "张思源G.G", "张思源"] },
  { label: "鱼头Killa4Nia", q: ["Killa4Nia", "鱼头Killa4Nia", "鱼头"] },
  { label: "icafe.Hu", q: ["icafe.Hu", "Kafe.Hu", "icafe Hu", "Kafe Hu"] },
  { label: "Jarstick", q: ["Jarstick"] },
  { label: "侃迪kandi", q: ["侃迪kandi", "侃迪", "kandi侃迪"] },
  { label: "Kigga", q: ["Kigga"] },
  { label: "梁维嘉Saber", q: ["梁维嘉Saber", "梁维嘉", "Saber梁维嘉"] },
  { label: "龙崎", q: ["龙崎"] },
  { label: "隆历奇", q: ["隆历奇"] },
  { label: "Mai", q: ["Mai说唱", "说唱Mai"] },
  { label: "MC光光", q: ["MC光光", "光光"] },
  { label: "孟子Mengzi", q: ["孟子Mengzi", "Mengzi", "孟子说唱"] },
  { label: "PG ONE", q: ["PG ONE", "PGONE", "王昊PG ONE"] },
  { label: "Ranzer", q: ["Ranzer"] },
  { label: "Regi", q: ["Regi说唱", "Regi"] },
  { label: "卢慈航", q: ["卢慈航", "深蓝儿童卢慈航"] },
  { label: "辛巴", q: ["辛巴说唱", "说唱辛巴"] },
  { label: "小精灵", q: ["小精灵说唱", "说唱小精灵"] },
  { label: "氧气", q: ["氧气说唱", "深蓝儿童氧气"] },
  { label: "希介", q: ["希介"] },
  { label: "太子Kiv", q: ["太子Kiv", "王翰元", "Kiv王翰元"] },
  { label: "TOYOKI", q: ["TOYOKI", "吴泽均", "Toyoki"] },
  { label: "Turbo", q: ["Turbo说唱", "说唱Turbo"] },
  { label: "泳恩Joannne", q: ["泳恩Joannne", "泳恩", "Joannne"] },
  { label: "威尔Will.T", q: ["威尔Will.T", "Will.T", "威尔"] },
  { label: "牙叔", q: ["牙叔"] },
  { label: "张昊", q: ["张昊说唱", "说唱张昊"] },
  { label: "Lil Howcy", q: ["Lil Howcy", "Howcy"] },
  { label: "BYG", q: ["BYG RICHNOMADIC", "BYG说唱", "Baby Bako"] },
  { label: "ZhaCai", q: ["ZhaCai", "榨菜说唱", "Zha Cai"] },
];

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
  return url.includes("?") ? `${url}&param=${size}y${size}` : `${url}?param=${size}y${size}`;
}

function guessTag(fans) {
  if (fans >= 500000) return "头部";
  if (fans >= 100000) return "高人气";
  if (fans >= 50000) return "新锐热门";
  if (fans >= 20000) return "两万粉+";
  return "补充名单";
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．._\-#（）()]/g, "");
}

function nameScore(query, artistName) {
  const q = norm(query);
  const n = norm(artistName);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.includes(q) || q.includes(n)) return 80;
  let hit = 0;
  for (const t of q.match(/[\u4e00-\u9fff]+|[a-z0-9]+/gi) || []) {
    if (t.length >= 2 && n.includes(t.toLowerCase())) hit += 1;
  }
  return hit * 20;
}

function alreadyHave(name) {
  const n = norm(name);
  if (n.length < 2) return false;
  // avoid Lil Howcy matching Lil Wayne
  return ARTISTS.some((a) => {
    const x = norm(a.name);
    const y = norm(a.search);
    if (x === n || y === n) return true;
    if (n.length >= 4 && (x.includes(n) || n.includes(x))) {
      // reject if only short shared latin prefix like "lil"
      if (/^lil/.test(n) && /^lil/.test(x) && n !== x) return false;
      return true;
    }
    return false;
  });
}

async function getJson(p) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(API + p);
    if (res.status === 405 || res.status === 429 || res.status === 503) {
      await sleep(700 * (i + 1));
      continue;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  throw new Error("unavailable");
}

async function resolveOne(queries) {
  let best = null;
  for (const q of queries) {
    const data = await getJson(
      `/cloudsearch?keywords=${encodeURIComponent(q)}&type=100&limit=10`
    );
    const artists = data?.result?.artists || [];
    for (const a of artists) {
      const score = Math.max(...queries.map((qq) => nameScore(qq, a.name)));
      if (score < 50) continue;
      let fans = 0;
      try {
        const fanData = await getJson(`/artist/follow/count?id=${a.id}`);
        fans = Number(fanData?.data?.fansCnt || 0);
      } catch {
        fans = 0;
      }
      await sleep(60);
      const row = { ...a, fans, score };
      if (!best || score > best.score || (score === best.score && fans > best.fans)) {
        best = row;
      }
    }
    await sleep(100);
    if (best && best.score >= 80) break;
  }
  return best;
}

async function main() {
  // wait for API
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(API + "/search?keywords=test&limit=1");
      if (r.ok || r.status === 200) break;
    } catch {
      /* retry */
    }
    if (i === 29) throw new Error("NetEase API not up at " + API);
    await sleep(1000);
  }

  const added = [];
  const skipped = [];
  const failed = [];

  for (const item of WANTED) {
    if (item.q.some((q) => alreadyHave(q)) || alreadyHave(item.label)) {
      skipped.push(item.label + " (already)");
      console.log(`= ${item.label} already`);
      continue;
    }
    process.stdout.write(`+ ${item.label} ... `);
    try {
      const hit = await resolveOne(item.q);
      if (!hit) {
        console.log("MISS");
        failed.push(item.label + " (not found)");
        continue;
      }
      if (alreadyHave(hit.name)) {
        console.log(`${hit.name} already`);
        skipped.push(item.label);
        continue;
      }
      console.log(`${hit.name} (${hit.fans}) score=${hit.score}`);
      added.push({
        id: slugify(hit.name),
        name: hit.name,
        search: hit.name,
        city: "全国",
        tag: guessTag(hit.fans),
        blurb: `网易云粉丝 ${Number(hit.fans || 0).toLocaleString("zh-CN")} · 热门 Top 50 可办赛。`,
        neteaseArtistId: hit.id,
        avatar: hiRes(hit.img1v1Url || hit.picUrl || "", 400),
        fans: hit.fans || 0,
      });
    } catch (e) {
      console.log("ERR", e.message);
      failed.push(item.label + " ERR " + e.message);
      await sleep(400);
    }
  }

  const used = new Set(ARTISTS.map((a) => a.id));
  for (const a of added) {
    let id = a.id;
    let n = 2;
    while (used.has(id)) id = `${a.id}-${n++}`;
    used.add(id);
    a.id = id;
  }

  const merged = [...ARTISTS, ...added].sort((a, b) => (b.fans || 0) - (a.fans || 0));
  const body = `/**
 * Chinese rap roster: NetEase fans >= 20000 (+ manual supplements).
 * Generated: ${new Date().toISOString()} · ${merged.length} artists
 */
export const ARTISTS = ${JSON.stringify(merged, null, 2)};

export function getArtist(id) {
  return ARTISTS.find((a) => a.id === id) || null;
}
`;
  fs.writeFileSync(OUT, body, "utf8");
  console.log(`\nAdded ${added.length}. Total ${merged.length}.`);
  console.log("Skipped:", skipped.length);
  skipped.forEach((f) => console.log(" ", f));
  console.log("Failed:");
  failed.forEach((f) => console.log(" ", f));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
