/**
 * Rebuild artists.js from roster-cache seed hits only (NO simi expansion).
 * Avoids pop-singer contamination from /simi/artist.
 *
 *   node scripts/rebuild-from-cache.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CACHE_PATH = path.join(ROOT, "src/data/roster-cache.json");
const OUT = path.join(ROOT, "src/data/artists.js");
const MIN_FANS = 20000;

const HARD_DENY = [
  /邓紫棋|G\.E\.M/i,
  /李荣浩/,
  /王嘉尔|Jackson/i,
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
  /五月天|苏打绿|告五人|凤凰传奇|羽泉/i,
  /刀郎|刘德华|张学友|郭富城|黎明|周华健|齐秦/i,
  /BLACKPINK|BTS|TWICE|IVE|NewJeans|AESPA|EXO|NCT/i,
  /Taylor Swift|Ariana|The Weeknd|Eminem|Kanye/i,
  /贝多芬|巴赫|肖邦|李斯特|柴可夫斯基|Galileo/i,
  /Toby Fox|Foxtail|Fox Stevenson|fox capture/i,
  /卫彬月/,
  /李文世/,
  /melo chio/i,
  /余佳运/,
  /暗杠/,
  /^Copy$/i,
  /Sakee云雾/i,
  /^K\.?ila$/i,
  /^Gai$/, // keep GAI周延
  /茶理理/,
  /蔡明希|不才/,
  /丁世光/,
  /薛明媛/,
  /张震岳/,
  /朴宰范/,
  /顽童MJ116/,
  /Yamy郭颖/,
  /MC仁/,
  /^Higher Brothers$/,
  /^活死人$/,
  /郑润泽/,
  /颜人中/,
  /^队长$/,
  /王力宏/,
  /蔡健雅/,
  /沈以诚/,
  /告五人/,
  /^h3R3$/,
  /隔壁老樊|赵雷|李健|老狼|朴树|水木年华|羽泉|凤凰传奇/,
  /单依纯|张远|王靖雯|王赫野|张哲瀚/,
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

function denied(name) {
  return HARD_DENY.some((re) => re.test(String(name || "")));
}

const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
const byId = new Map();

// Prefer seed2 (scored). Ignore legacy seed: junk without name score.
for (const [key, val] of Object.entries(cache)) {
  if (!key.startsWith("seed2:")) continue;
  const hits = Array.isArray(val) ? val : [];
  for (const h of hits) {
    if (!h?.id || !h.name) continue;
    if (denied(h.name)) continue;
    // require decent name match when score exists
    if (typeof h.score === "number" && h.score < 60) continue;
    const fans = Number(h.fans || 0);
    if (fans < MIN_FANS) continue;
    const id = String(h.id);
    const prev = byId.get(id);
    if (!prev || fans > prev.fans) {
      byId.set(id, {
        id: slugify(h.name),
        name: h.name,
        search: h.name,
        city: "全国",
        tag: guessTag(fans),
        blurb: `网易云粉丝 ${fans.toLocaleString("zh-CN")} · 热门 Top 50 可办赛。`,
        neteaseArtistId: h.id,
        avatar: hiRes(h.img1v1Url || h.picUrl || "", 400),
        fans,
      });
    }
  }
}

const MUST = [
  "mac ova seas",
  "MULA SAKEE",
  "Sakee云雾",
  "谟西Mercy",
  "艾志恒Asen",
  "扬布拉德",
  "Vansdaddy",
  "Rapeter",
  "Top Barry",
];

const list = [...byId.values()].sort((a, b) => b.fans - a.fans);
const used = new Set();
for (const a of list) {
  let id = a.id;
  let n = 2;
  while (used.has(id)) id = `${a.id}-${n++}`;
  used.add(id);
  a.id = id;
}

const body = `/**
 * Chinese rap roster: NetEase fans >= ${MIN_FANS}.
 * Built from seed search only (no simi — avoids pop singers).
 * Regenerate: npm run roster   or   node scripts/rebuild-from-cache.mjs
 * Generated: ${new Date().toISOString()} · ${list.length} artists
 */
export const ARTISTS = ${JSON.stringify(list, null, 2)};

export function getArtist(id) {
  return ARTISTS.find((a) => a.id === id) || null;
}
`;

fs.writeFileSync(OUT, body, "utf8");
console.log(`Restored ${list.length} rappers from seed cache`);
for (const n of MUST) {
  const hit = list.find((a) => a.name.toLowerCase().includes(n.toLowerCase()));
  console.log(`  ${n}: ${hit ? `${hit.name} (${hit.fans})` : "MISSING"}`);
}
console.log("Top 15:");
list.slice(0, 15).forEach((a) => console.log(`  ${String(a.fans).padStart(8)}  ${a.name}`));
