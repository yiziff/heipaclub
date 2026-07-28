/**
 * Fix bad matches from add-missing-batch and fill remaining gaps.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS } from "../src/data/artists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../src/data/artists.js");
const API = process.env.NETEASE_API_BASE || "http://127.0.0.1:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REMOVE_NETEASE_IDS = new Set([
  53385341, // PG One N1
  4597, // wrong 孟子
  12780724, // 深蓝儿童 (误当作氧气)
]);

const FORCE_ADD = [
  { id: 31917276, label: "Mengzi" },
  { id: 46549916, label: "Lil-YANG氧气" },
  { id: 12085585, label: "SIMBA辛巴" },
  { id: 57637071, label: "TURBO" },
  { id: 94382457, label: "BabyBAKO" },
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

async function getJson(p) {
  const res = await fetch(API + p);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function fetchArtist(id) {
  const detail = await getJson(`/artist/detail?id=${id}`);
  const artist = detail?.data?.artist || detail?.artist;
  if (!artist) throw new Error("no artist " + id);
  let fans = 0;
  try {
    const fanData = await getJson(`/artist/follow/count?id=${id}`);
    fans = Number(fanData?.data?.fansCnt || 0);
  } catch {
    fans = Number(artist.followCount || 0);
  }
  return {
    neteaseArtistId: id,
    name: artist.name,
    fans,
    avatar: hiRes(artist.cover || artist.img1v1Url || artist.picUrl || "", 400),
  };
}

async function main() {
  let list = ARTISTS.filter((a) => !REMOVE_NETEASE_IDS.has(Number(a.neteaseArtistId)));
  const removed = ARTISTS.length - list.length;
  console.log("Removed", removed);

  const haveIds = new Set(list.map((a) => Number(a.neteaseArtistId)).filter(Boolean));
  const haveNames = new Set(list.map((a) => norm(a.name)));
  const added = [];

  for (const item of FORCE_ADD) {
    if (haveIds.has(item.id)) {
      console.log("=", item.label, "already by id");
      continue;
    }
    const hit = await fetchArtist(item.id);
    if (haveNames.has(norm(hit.name))) {
      console.log("=", hit.name, "already by name");
      continue;
    }
    console.log("+", hit.name, hit.fans);
    added.push({
      id: slugify(hit.name),
      name: hit.name,
      search: hit.name,
      city: "全国",
      tag: guessTag(hit.fans),
      blurb: `网易云粉丝 ${Number(hit.fans || 0).toLocaleString("zh-CN")} · 热门 Top 50 可办赛。`,
      neteaseArtistId: hit.neteaseArtistId,
      avatar: hit.avatar,
      fans: hit.fans || 0,
    });
    haveIds.add(item.id);
    haveNames.add(norm(hit.name));
    await sleep(80);
  }

  const used = new Set(list.map((a) => a.id));
  for (const a of added) {
    let id = a.id;
    let n = 2;
    while (used.has(id)) id = `${a.id}-${n++}`;
    used.add(id);
    a.id = id;
  }

  const merged = [...list, ...added].sort((a, b) => (b.fans || 0) - (a.fans || 0));
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
  console.log(`Done. Added ${added.length}. Total ${merged.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
