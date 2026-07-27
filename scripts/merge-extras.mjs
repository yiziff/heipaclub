import fs from "node:fs";
import { ARTISTS } from "../src/data/artists.js";

function hiRes(url, size = 400) {
  if (!url) return "";
  return url.includes("?")
    ? `${url}&param=${size}y${size}`
    : `${url}?param=${size}y${size}`;
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
function tag(f) {
  if (f >= 500000) return "头部";
  if (f >= 100000) return "高人气";
  if (f >= 50000) return "新锐热门";
  return "两万粉+";
}

const extras = [
  {
    id: 12493781,
    name: "Ghost (王琳凯)",
    fans: 2387783,
    avatar: "https://p3.music.126.net/H7YgpH3Lt4b7IwjTde7dMQ==/109951173027916242.jpg",
  },
  {
    id: 51957057,
    name: "ljz329",
    fans: 1374404,
    avatar: "https://p4.music.126.net/2HWBehaTrcYUZAByJh-mDg==/109951170681263534.jpg",
  },
  {
    id: 12258420,
    name: "AY楊佬叁",
    fans: 767557,
    avatar: "https://p3.music.126.net/Ortt2V2hhAd1_f_1p_8G9w==/109951171962349870.jpg",
  },
  {
    id: 12318046,
    name: "愚月FoolMoon",
    fans: 121622,
    avatar: "https://p4.music.126.net/uA_vgJBUzny__tJrEy9aSw==/109951171903516002.jpg",
  },
  {
    id: 12283512,
    name: "刘悦spam-生番",
    fans: 144613,
    avatar: "https://p3.music.126.net/dDYxkxN9isY8p7kme2kJHw==/109951165928249224.jpg",
  },
  {
    id: 12039173,
    name: "李尔新",
    fans: 165615,
    avatar: "https://p3.music.126.net/ZAsJPxAv4axhbWVkj4UEZA==/109951171722169442.jpg",
  },
  {
    id: 34876884,
    name: "陳嫺靜",
    fans: 267231,
    avatar: "https://p3.music.126.net/ma6prd2ux0SAoR1S9M6x4w==/109951170542429056.jpg",
  },
  {
    id: 12264643,
    name: "泥鳅zinco",
    fans: 267479,
    avatar: "https://p4.music.126.net/Kx-SHHfC3Vpi848zAWm3eg==/109951168691269689.jpg",
  },
  {
    id: 12134076,
    name: "梁淞Tsong",
    fans: 169028,
    avatar: "https://p4.music.126.net/ftGaIJgyBrGMI9G6kZ6uxQ==/109951163335350546.jpg",
  },
];

const used = new Set(ARTISTS.map((a) => a.id));
const byNetease = new Set(ARTISTS.map((a) => String(a.neteaseArtistId)));
const added = [];

for (const e of extras) {
  if (byNetease.has(String(e.id))) {
    console.log("have", e.name);
    continue;
  }
  let id = slugify(e.name);
  let n = 2;
  while (used.has(id)) id = `${slugify(e.name)}-${n++}`;
  used.add(id);
  byNetease.add(String(e.id));
  added.push({
    id,
    name: e.name,
    search: e.name,
    city: "全国",
    tag: tag(e.fans),
    blurb: `网易云粉丝 ${e.fans.toLocaleString("zh-CN")} · 热门 Top 50 可办赛。`,
    neteaseArtistId: e.id,
    avatar: hiRes(e.avatar),
    fans: e.fans,
  });
  console.log("add", e.name, e.fans);
}

const merged = [...ARTISTS, ...added].sort((a, b) => (b.fans || 0) - (a.fans || 0));
const body = `/**
 * Chinese rap roster: NetEase fans >= 20000.
 * Generated: ${new Date().toISOString()} · ${merged.length} artists
 */
export const ARTISTS = ${JSON.stringify(merged, null, 2)};

export function getArtist(id) {
  return ARTISTS.find((a) => a.id === id) || null;
}
`;
fs.writeFileSync(new URL("../src/data/artists.js", import.meta.url), body);
console.log("total", merged.length, "added", added.length);
