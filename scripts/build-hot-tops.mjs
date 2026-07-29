/**
 * Prefetch NetEase top songs for "hot" roster artists into static JSON chunks.
 * Scope: fans >= 500000 + manual extras (vansdaddy / 华云龙 / …).
 *
 * Usage:
 *   NETEASE_API=http://127.0.0.1:3000 node scripts/build-hot-tops.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS } from "../src/data/artists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "src/data/hot-tops");
const API = process.env.NETEASE_API || "http://127.0.0.1:3000";
const LIMIT = Number(process.env.HOT_TOP_LIMIT || 50);
const FAN_MIN = Number(process.env.HOT_FAN_MIN || 500_000);
const CONCURRENCY = Number(process.env.HOT_TOP_CONCURRENCY || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Always bundle these even if fans < FAN_MIN (user picks). */
const EXTRA_IDS = new Set([
  "vansdaddy",
  "华云龙kle",
  "马赫mood",
  "kiv",
  "toyoki",
  "夏之禹",
  "谟西mercy",
  "mula-sakee", // mulaakee
  "瘦子e-so",
]);

function hiRes(url, size = 500) {
  if (!url) return "";
  if (url.includes("param=")) return url;
  return url.includes("?") ? `${url}&param=${size}y${size}` : `${url}?param=${size}y${size}`;
}

function titleDedupeKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\s*[\(（][^）)]*[\)）]\s*/g, " ")
    .replace(/\s*(?:feat\.?|ft\.?|with)\s+.+$/i, "")
    .replace(/\s+/g, "")
    .replace(/[·．._\-#（）()']/g, "")
    .trim();
}

function dedupeByTitleKeepHotter(songs) {
  const seen = new Set();
  const out = [];
  for (const s of songs) {
    const key = titleDedupeKey(s.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function publishYear(ms) {
  const n = Number(ms);
  if (!n || n < 1e11) return "";
  try {
    return String(new Date(n).getFullYear());
  } catch {
    return "";
  }
}

function safeFileId(id) {
  return String(id || "")
    .replace(/[^\w\u4e00-\u9fff.-]+/g, "_")
    .slice(0, 80);
}

async function netease(pathname, query = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.status === 405 || res.status === 429 || res.status === 503) {
      await sleep(700 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${pathname} unavailable`);
}

async function fetchTopSongs(artistId) {
  const data = await netease("/artist/top/song", { id: artistId });
  const songs = data?.songs || data?.hotSongs || [];
  const mapped = songs.map((s) => {
    const pic = s.al?.picUrl || "";
    const publishMs = Number(s.publishTime || s.al?.publishTime || 0) || 0;
    return {
      id: String(s.id),
      neteaseId: String(s.id),
      title: s.name,
      artist: (s.ar || []).map((x) => x.name).join(", "),
      album: s.al?.name || "",
      collection: s.al?.name || "",
      cover: hiRes(pic, 500),
      coverSm: hiRes(pic, 200),
      duration_ms: s.dt ?? null,
      year: publishYear(publishMs),
      publishTime: publishMs || null,
    };
  });
  return dedupeByTitleKeepHotter(mapped).slice(0, LIMIT);
}

function pickArtists() {
  const seen = new Set();
  const list = [];
  for (const a of ARTISTS) {
    if (!a?.neteaseArtistId) continue;
    if (a.source === "itunes") continue;
    const id = String(a.id);
    if (seen.has(id)) continue;
    const fans = Number(a.fans || 0);
    if (fans >= FAN_MIN || EXTRA_IDS.has(id)) {
      seen.add(id);
      list.push(a);
    }
  }
  return list;
}

async function mapPool(items, concurrency, fn) {
  let i = 0;
  const out = new Array(items.length);
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = pickArtists();
console.log(`Building hot-tops for ${targets.length} artists via ${API}`);

const ok = [];
const failed = [];

await mapPool(targets, CONCURRENCY, async (artist, idx) => {
  const fileId = safeFileId(artist.id);
  try {
    const songs = await fetchTopSongs(artist.neteaseArtistId);
    if (!songs.length) throw new Error("empty tops");
    const payload = {
      id: artist.id,
      name: artist.name,
      neteaseArtistId: artist.neteaseArtistId,
      avatar: artist.avatar || "",
      updatedAt: new Date().toISOString(),
      songs,
    };
    fs.writeFileSync(path.join(OUT_DIR, `${fileId}.json`), JSON.stringify(payload), "utf8");
    ok.push({ id: artist.id, fileId, songs: songs.length });
    console.log(`[${idx + 1}/${targets.length}] OK ${artist.name} (${songs.length})`);
  } catch (e) {
    failed.push({ id: artist.id, error: String(e.message || e) });
    console.warn(`[${idx + 1}/${targets.length}] FAIL ${artist.name}: ${e.message || e}`);
  }
  await sleep(120);
});

const index = {
  generatedAt: new Date().toISOString(),
  fanMin: FAN_MIN,
  limit: LIMIT,
  artists: Object.fromEntries(ok.map((x) => [x.id, x.fileId])),
};

fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2), "utf8");

console.log(`\nDone. ok=${ok.length} fail=${failed.length}`);
if (failed.length) {
  console.log(failed.slice(0, 20));
  process.exitCode = 1;
}
