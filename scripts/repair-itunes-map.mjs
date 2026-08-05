/**
 * Re-resolve itunes-map entries whose matched track is a different song
 * (Pt.2 sequels, medleys, instrumental/伴奏 versions).
 *
 * Usage:
 *   node scripts/repair-itunes-map.mjs            # 全量修复
 *   node scripts/repair-itunes-map.mjs --dry      # 只看会改什么
 *   node scripts/repair-itunes-map.mjs 艾志恒asen # 只修某个分片
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  titleScore,
  expandArtistAliases,
  buildSearchTerms,
  createTrackMatchState,
  considerTrack,
  playSourcePatchFromTrack,
} from "../src/itunes-match.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAP_DIR = path.join(ROOT, "src/data/itunes-map");
const TOPS_DIR = path.join(ROOT, "src/data/hot-tops");
const ITUNES = "https://itunes.apple.com";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const ONLY = new Set(args.filter((a) => !a.startsWith("--")));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let backoffMs = 700;

async function itunesGet(pathname, query) {
  const url = new URL(ITUNES + pathname);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(backoffMs);
    const res = await fetch(url).catch(() => null);
    if (!res) continue;
    if (res.status === 403 || res.status === 429) {
      backoffMs = Math.min(20000, backoffMs * 2);
      continue;
    }
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

async function artistCatalog(itunesArtistId) {
  if (!itunesArtistId) return [];
  const data = await itunesGet("/lookup", {
    id: itunesArtistId,
    entity: "song",
    limit: 200,
    country: "cn",
  });
  return (data?.results || []).filter((r) => r.wrapperType === "track" && r.previewUrl);
}

async function reresolve(song, artistName, catalog) {
  const artists = expandArtistAliases(artistName, song, [artistName]);
  const state = createTrackMatchState();
  for (const t of catalog) considerTrack(state, t, song.title, artists, 70);
  if (state.best && state.bestScore >= 95) return playSourcePatchFromTrack(state.best);

  for (const term of buildSearchTerms(song.title, artists, song.album || "").slice(0, 2)) {
    const data = await itunesGet("/search", {
      term,
      entity: "song",
      limit: 12,
      country: "cn",
    });
    for (const t of data?.results || []) considerTrack(state, t, song.title, artists);
    if (state.best && state.bestScore >= 95) break;
  }
  return playSourcePatchFromTrack(state.best);
}

const files = fs
  .readdirSync(MAP_DIR)
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .filter((f) => !ONLY.size || ONLY.has(f.replace(/\.json$/, "")));

let fixed = 0;
let dropped = 0;

for (const file of files) {
  const mapPath = path.join(MAP_DIR, file);
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const topsPath = path.join(TOPS_DIR, file);
  if (!fs.existsSync(topsPath)) continue;
  const tops = JSON.parse(fs.readFileSync(topsPath, "utf8"));
  const songs = Array.isArray(tops) ? tops : tops.songs || tops.list || [];
  const byId = new Map(songs.map((s) => [String(s.neteaseId || s.id), s]));

  const bad = [];
  for (const [nid, entry] of Object.entries(map.byNeteaseId || {})) {
    const song = byId.get(String(nid));
    if (!song || !entry?.itunesTitle) continue;
    if (titleScore(song.title, entry.itunesTitle) < 85) bad.push({ nid, song, entry });
  }
  if (!bad.length) continue;

  console.log(`\n## ${map.name || file} (${bad.length})`);
  const catalog = DRY ? [] : await artistCatalog(map.itunesArtistId);
  let touched = false;

  for (const { nid, song, entry } of bad) {
    if (DRY) {
      console.log(`  ? ${song.title}  <-  ${entry.itunesTitle}`);
      continue;
    }
    const patch = await reresolve(song, map.name || "", catalog);
    if (patch.playSource === "itunes" && patch.previewUrl) {
      map.byNeteaseId[nid] = {
        playSource: "itunes",
        itunesTrackId: patch.itunesTrackId,
        previewUrl: patch.previewUrl,
        trackViewUrl: patch.trackViewUrl,
        itunesTitle: patch.itunesTitle,
        itunesArtistName: patch.itunesArtistName,
      };
      fixed += 1;
      console.log(`  ✓ ${song.title}: ${entry.itunesTitle} → ${patch.itunesTitle}`);
    } else {
      delete map.byNeteaseId[nid];
      map.missNeteaseIds = [...new Set([...(map.missNeteaseIds || []), String(nid)])];
      dropped += 1;
      console.log(`  → ${song.title}: 移除错误音源（回落网易云）`);
    }
    touched = true;
  }

  if (touched) {
    map.updatedAt = new Date().toISOString();
    fs.writeFileSync(mapPath, JSON.stringify(map), "utf8");
  }
}

console.log(`\nfixed=${fixed} dropped=${dropped}${DRY ? " (dry run)" : ""}`);
