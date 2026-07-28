import fs from "node:fs";
import { ARTISTS } from "../src/data/artists.js";

const API = process.env.NETEASE_API_BASE || "http://127.0.0.1:3000";
const OUT = new URL("../src/data/artists.js", import.meta.url);

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

async function fetchArtist(id) {
  const detail = await (await fetch(`${API}/artist/detail?id=${id}`)).json();
  const artist = detail?.data?.artist || detail?.artist;
  if (!artist) throw new Error("no artist " + id);
  const fanData = await (await fetch(`${API}/artist/follow/count?id=${id}`)).json();
  const fans = Number(fanData?.data?.fansCnt || 0);
  return {
    id: slugify(artist.name),
    name: artist.name,
    search: artist.name,
    city: "全国",
    tag: guessTag(fans),
    blurb: `网易云粉丝 ${fans.toLocaleString("zh-CN")} · 热门 Top 50 可办赛。`,
    neteaseArtistId: id,
    avatar: hiRes(artist.cover || artist.img1v1Url || artist.picUrl || "", 400),
    fans,
  };
}

const REMOVE = new Set([58301892, 55876899]); // wrong Kafe.Hu / Ranzer
let list = ARTISTS.filter((a) => !REMOVE.has(Number(a.neteaseArtistId)));
console.log("removed", ARTISTS.length - list.length);

const adds = [];
for (const id of [12024274, 12319437]) {
  if (list.some((a) => Number(a.neteaseArtistId) === id)) {
    console.log("already", id);
    continue;
  }
  const row = await fetchArtist(id);
  console.log("+", row.name, row.fans);
  adds.push(row);
}

const used = new Set(list.map((a) => a.id));
for (const a of adds) {
  let id = a.id;
  let n = 2;
  while (used.has(id)) id = `${a.id}-${n++}`;
  used.add(id);
  a.id = id;
}

const merged = [...list, ...adds].sort((a, b) => (b.fans || 0) - (a.fans || 0));
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
console.log("total", merged.length);
