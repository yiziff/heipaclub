import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS } from "../src/data/artists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../src/data/artists.js");
const API = process.env.NETEASE_API_BASE || "https://heipaclub.com/api/netease";

const ALIASES = {
  "J. Cole": ["J Cole"],
  "Jay-Z": ["Jay Z"],
  "A$AP Rocky": ["ASAP Rocky", "A$AP Rocky"],
  "XXXTENTACION": ["XXXTentacion", "XXXTENTACION"],
  "YoungBoy Never Broke Again": ["NBA YoungBoy", "YoungBoy Never Broke Again"],
  "Ty Dolla $ign": ["Ty Dolla $ign", "Ty Dolla Sign"],
  "Dr. Dre": ["Dr. Dre", "Dr Dre"],
  "2Pac": ["2Pac", "Tupac"],
};

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．._\-#,$'’"()]/g, "");
}

function hiRes(url, size = 400) {
  if (!url) return "";
  if (url.includes("param=")) return url;
  return url.includes("?") ? `${url}&param=${size}y${size}` : `${url}?param=${size}y${size}`;
}

function scoreName(query, name) {
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return 0;
  if (q === n) return 120;
  if (n.includes(q) || q.includes(n)) return 90;
  let hit = 0;
  const parts = q.match(/[a-z0-9]+/g) || [];
  for (const p of parts) {
    if (p.length >= 2 && n.includes(p)) hit += 1;
  }
  return hit * 18;
}

async function getJson(pathname) {
  const res = await fetch(`${API}${pathname}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathname}`);
  return res.json();
}

async function searchArtist(keyword, limit = 12) {
  const data = await getJson(`/cloudsearch?keywords=${encodeURIComponent(keyword)}&type=100&limit=${limit}`);
  return data?.result?.artists || [];
}

async function fanCount(id) {
  const data = await getJson(`/artist/follow/count?id=${id}`);
  return Number(data?.data?.fansCnt || 0);
}

async function resolveWestern(artist) {
  const queries = [artist.search || artist.name, ...(ALIASES[artist.name] || [])];
  let best = null;

  for (const q of queries) {
    const results = await searchArtist(q, 12);
    const ranked = results
      .map((r) => ({ ...r, _score: Math.max(...queries.map((x) => scoreName(x, r.name))) }))
      .filter((r) => r._score >= 45)
      .sort((a, b) => b._score - a._score)
      .slice(0, 4);
    for (const r of ranked) {
      const fans = await fanCount(r.id);
      const row = { ...r, fans };
      if (!best) {
        best = row;
      } else if (row._score > best._score || (row._score === best._score && row.fans > best.fans)) {
        best = row;
      }
    }
    if (best && best._score >= 100) break;
  }

  if (!best) return null;

  return {
    ...artist,
    search: artist.search || artist.name,
    blurb: `网易云粉丝 ${Number(best.fans).toLocaleString("zh-CN")} · 热门 Top 50 可办赛。`,
    neteaseArtistId: best.id,
    avatar: hiRes(best.img1v1Url || best.picUrl || artist.avatar || "", 400),
    fans: best.fans,
  };
}

async function main() {
  const list = [...ARTISTS];
  const idxs = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (String(a.city || "").includes("欧美") || String(a.tag || "").includes("欧美")) idxs.push(i);
  }

  console.log(`欧美歌手待同步: ${idxs.length}`);
  for (const i of idxs) {
    const a = list[i];
    process.stdout.write(`同步 ${a.name} ... `);
    try {
      const hit = await resolveWestern(a);
      if (!hit) {
        console.log("MISS");
        continue;
      }
      delete hit.source;
      list[i] = hit;
      console.log(`OK fans=${hit.fans} id=${hit.neteaseArtistId}`);
    } catch (e) {
      console.log(`ERR ${e.message}`);
    }
  }

  const body = `/**
 * Auto-built Chinese rap roster: NetEase fans >= 20000.
 * Regenerate: npm run roster
 * Generated: ${new Date().toISOString()} · ${list.length} artists
 */
export const ARTISTS = ${JSON.stringify(list, null, 2)};

export function getArtist(id) {
  return ARTISTS.find((a) => a.id === id) || null;
}
`;
  fs.writeFileSync(OUT, body, "utf8");
  console.log("已写回", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

