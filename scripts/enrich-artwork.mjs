/**
 * Enrich artists/songs with NetEase Cloud Music artwork.
 * Requires NeteaseCloudMusicApi on http://127.0.0.1:3000
 * Usage: npm run enrich
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS } from "../src/data/artists.seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CACHE_PATH = path.join(ROOT, "src/data/artwork-cache.json");
const OUT = path.join(ROOT, "src/data/artists.js");
const API = process.env.NETEASE_API || "http://127.0.0.1:3000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function hiRes(url, size = 400) {
  if (!url) return "";
  // NetEase picUrl often accepts param
  if (url.includes("?")) return `${url}&param=${size}y${size}`;
  return `${url}?param=${size}y${size}`;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．.（）()]/g, "");
}

async function netease(pathname) {
  const url = API + pathname;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.status === 405 || res.status === 429 || res.status === 503) {
      await sleep(600 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`netease ${res.status}`);
    return res.json();
  }
  throw new Error("netease unavailable");
}

function scoreSong(song, wantTitle, aliases) {
  const name = norm(song.name);
  const want = norm(wantTitle);
  let s = 0;
  if (name === want) s += 70;
  else if (name.startsWith(want) || want.startsWith(name)) s += 40;
  else if (name.includes(want) && want.length >= 2) s += 18;
  else return -100;

  // Avoid "烈火" → "烈火战马" style false friends when lengths differ a lot
  if (Math.abs(name.length - want.length) >= 3 && name !== want) s -= 25;
  if (name.length <= 2 && want.length >= 4) s -= 40;

  const artists = (song.ar || []).map((a) => norm(a.name)).join("|");
  if (aliases.some((x) => artists.includes(norm(x)))) s += 35;
  else s -= 15;

  if (/live|现场|伴奏|纯音乐/.test(name) && !/live|现场/.test(want)) s -= 12;
  return s;
}

async function findSong(songTitle, artistQuery, aliases) {
  const q = encodeURIComponent(`${artistQuery} ${songTitle}`);
  let songs = [];
  for (const path of [
    `/cloudsearch?keywords=${q}&type=1&limit=12`,
    `/search?keywords=${q}&type=1&limit=12`,
  ]) {
    try {
      const data = await netease(path);
      songs = data?.result?.songs || [];
      if (songs.length) break;
    } catch (_) {}
    await sleep(200);
  }
  let best = null;
  let bestScore = -Infinity;
  for (const song of songs) {
    const sc = scoreSong(song, songTitle, aliases);
    if (sc > bestScore) {
      bestScore = sc;
      best = song;
    }
  }
  if (!best || bestScore < 50) return null;
  const pic = best.al?.picUrl || "";
  return {
    cover: hiRes(pic, 500),
    coverSm: hiRes(pic, 200),
    neteaseId: best.id,
    neteaseName: best.name,
    collection: best.al?.name || "",
  };
}

async function findArtistAvatar(artistQuery, preferName) {
  const q = encodeURIComponent(artistQuery);
  let artists = [];
  for (const path of [
    `/cloudsearch?keywords=${q}&type=100&limit=8`,
    `/search?keywords=${q}&type=100&limit=8`,
  ]) {
    try {
      const data = await netease(path);
      artists = data?.result?.artists || [];
      if (artists.length) break;
    } catch (_) {}
    await sleep(200);
  }
  const want = norm(preferName || artistQuery);
  const pick =
    artists.find((a) => norm(a.name) === want) ||
    artists.find((a) => norm(a.name).includes(want) || want.includes(norm(a.name))) ||
    artists[0];
  const pic = pick?.img1v1Url || pick?.picUrl || "";
  return {
    avatar: hiRes(pic, 400),
    neteaseArtistId: pick?.id || null,
    neteaseArtistName: pick?.name || "",
  };
}

const SEARCH_META = {
  gai: { query: "GAI周延", aliases: ["GAI", "周延", "GAI周延"] },
  pharaoh: { query: "法老", aliases: ["法老"] },
  masiwei: { query: "马思唯", aliases: ["马思唯", "Masiwei"] },
  keyl: { query: "Key.L刘聪", aliases: ["刘聪", "Key.L", "Key.L刘聪"] },
  vava: { query: "VaVa毛衍七", aliases: ["VAVA", "VaVa", "毛衍七"] },
  air: { query: "艾热AIR", aliases: ["艾热", "AIR"] },
  kungfupen: { query: "功夫胖KungFuPen", aliases: ["功夫胖", "KungFuPen"] },
  tizzy: { query: "Tizzy T", aliases: ["Tizzy T", "Tizzy"] },
};

function writeArtists(enriched) {
  const body = `/**
 * Curated Chinese rap artists + tracks with NetEase artwork.
 * Seed: src/data/artists.seed.js
 * Regenerate: npm run enrich  (needs NetEase API on :3000)
 */
export const ARTISTS = ${JSON.stringify(enriched, null, 2)};

export function getArtist(id) {
  return ARTISTS.find((a) => a.id === id) || null;
}
`;
  fs.writeFileSync(OUT, body, "utf8");
}

async function main() {
  // health check
  try {
    await netease("/search?keywords=a&limit=1");
  } catch (e) {
    console.error("NetEase API not reachable at", API);
    console.error("Start it first, e.g. npx NeteaseCloudMusicApi");
    process.exit(1);
  }

  const cache = loadCache();
  const enriched = [];

  for (const artist of ARTISTS) {
    const meta = SEARCH_META[artist.id] || {
      query: artist.name,
      aliases: [artist.name],
    };
    console.log(`\n== ${artist.name} ==`);

    const avatarKey = `avatar:${artist.id}`;
    if (!cache[avatarKey]?.avatar) {
      try {
        cache[avatarKey] = await findArtistAvatar(meta.query, artist.name);
        saveCache(cache);
      } catch (e) {
        console.log("  avatar ERR", e.message);
        cache[avatarKey] = { avatar: "" };
        saveCache(cache);
      }
      await sleep(120);
    }
    const avatar = cache[avatarKey].avatar || "";
    console.log("  avatar:", avatar ? "ok" : "missing", cache[avatarKey].neteaseArtistName || "");

    const songs = [];
    for (const song of artist.songs) {
      const songKey = `song:${artist.id}:${song.title}`;
      process.stdout.write(`  · ${song.title} ... `);
      if (!cache[songKey]) {
        try {
          const hit = await findSong(song.title, meta.query, meta.aliases);
          cache[songKey] = hit ? { ok: true, ...hit } : { ok: false };
          saveCache(cache);
        } catch (e) {
          console.log("ERR", e.message);
          await sleep(400);
          continue;
        }
        await sleep(100);
      }
      const hit = cache[songKey];
      if (hit?.ok) {
        console.log("ok →", hit.neteaseName);
        songs.push({
          ...song,
          cover: hit.cover,
          coverSm: hit.coverSm,
          collection: hit.collection || song.album || "",
          neteaseId: hit.neteaseId,
        });
      } else {
        console.log("MISS");
        songs.push({
          ...song,
          cover: avatar || "",
          coverSm: avatar || "",
        });
      }
    }

    enriched.push({
      ...artist,
      avatar,
      songs,
    });
    writeArtists(enriched);
  }

  writeArtists(enriched);
  const covered = enriched.reduce(
    (n, a) => n + a.songs.filter((s) => s.cover && s.cover !== a.avatar).length,
    0
  );
  const total = enriched.reduce((n, a) => n + a.songs.length, 0);
  console.log(`\nDone. Covers matched ${covered}/${total}. Wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
