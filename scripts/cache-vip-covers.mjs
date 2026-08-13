/**
 * Download VIP covers (hot-tops Top24 + label/member avatars) into KV ARTIST_TOP.
 *
 *   npm run cache-covers
 *   NETEASE_API=http://127.0.0.1:3000 npm run cache-covers
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ARTISTS } from "../src/data/artists.js";
import { HIPHOP_LABELS, artistsInLabel, labelLeader } from "../src/data/labels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TOPS_DIR = path.join(ROOT, "src/data/hot-tops");
const hotIndex = JSON.parse(fs.readFileSync(path.join(TOPS_DIR, "index.json"), "utf8"));
const API = process.env.NETEASE_API || "http://127.0.0.1:3000";
const TOP_N = Number(process.env.VIP_COVER_TOP_N || 24);
const DL_CONCURRENCY = Number(process.env.VIP_COVER_CONCURRENCY || 6);
const BULK_SIZE = Number(process.env.VIP_COVER_BULK || 40);
const IMG_KV_TTL_SEC = 60 * 60 * 24 * 30;
const MANIFEST_KEY = "img:manifest:v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function coverKvKey(rawUrl) {
  const u = new URL(String(rawUrl || "").replace(/^http:/i, "https:"));
  const id = `${u.origin}${u.pathname}`;
  return `img:v1:${createHash("sha256").update(id).digest("hex")}`;
}

function canonicalCoverUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim().replace(/^http:/i, "https:"));
    if (!u.hostname) return "";
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

function downloadUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").replace(/^http:/i, "https:"));
    const host = u.hostname.toLowerCase();
    if (host.includes("126.net") || host.includes("music.126")) {
      return `${u.origin}${u.pathname}?param=320y320`;
    }
    if (host.includes("mzstatic.com")) {
      return u.toString().replace(/\/\d+x\d+bb\./, "/320x320bb.");
    }
    return u.toString();
  } catch {
    return "";
  }
}

function addUrl(bag, raw) {
  const canon = canonicalCoverUrl(raw);
  if (!canon) return;
  bag.set(canon, downloadUrl(canon) || downloadUrl(raw));
}

function loadHotPack(fileId) {
  const file = path.join(TOPS_DIR, `${fileId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function fetchTopCovers(neteaseArtistId) {
  const url = new URL(`${API}/artist/top/song`);
  url.searchParams.set("id", String(neteaseArtistId));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`top/song HTTP ${res.status}`);
  const data = await res.json();
  const songs = data?.songs || data?.hotSongs || [];
  return songs
    .map((s) => s?.al?.picUrl || "")
    .filter(Boolean)
    .slice(0, TOP_N);
}

async function collectUrls() {
  const bag = new Map();
  const hotIds = Object.keys(hotIndex?.artists || {});
  let packs = 0;
  let fetched = 0;

  for (const artistId of hotIds) {
    const fileId = hotIndex.artists[artistId];
    const roster = ARTISTS.find((a) => a.id === artistId);
    if (roster?.avatar) addUrl(bag, roster.avatar);
    const pack = loadHotPack(fileId);
    if (pack) {
      packs += 1;
      if (pack.avatar) addUrl(bag, pack.avatar);
      for (const s of (pack.songs || []).slice(0, TOP_N)) {
        addUrl(bag, s.cover || s.coverSm || "");
      }
      continue;
    }
    if (roster?.neteaseArtistId && roster.source !== "itunes") {
      try {
        const covers = await fetchTopCovers(roster.neteaseArtistId);
        fetched += 1;
        for (const c of covers) addUrl(bag, c);
        console.log(`  fetch tops ${roster.name} (${covers.length})`);
      } catch (e) {
        console.warn(`  skip tops ${roster?.name || artistId}: ${e.message || e}`);
      }
      await sleep(80);
    }
  }

  for (const label of HIPHOP_LABELS) {
    const leader = labelLeader(ARTISTS, label.id);
    if (leader?.avatar) addUrl(bag, leader.avatar);
    for (const m of artistsInLabel(ARTISTS, label.id)) {
      if (m?.avatar) addUrl(bag, m.avatar);
    }
  }

  return { bag, packs, fetched, hotIds: hotIds.length };
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
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return out;
}

async function downloadOne(canon, href) {
  try {
    const res = await fetch(href, {
      headers: {
        Referer: "https://music.163.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const ctype = res.headers.get("content-type") || "image/jpeg";
    if (!ctype.startsWith("image/") && ctype !== "application/octet-stream") {
      return { ok: false, error: `not image (${ctype})` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 2_000_000) return { ok: false, error: "bad size" };
    return {
      ok: true,
      key: coverKvKey(canon),
      value: buf.toString("base64"),
      ctype: ctype.startsWith("image/") ? ctype : "image/jpeg",
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function wranglerKvBulkPut(filePath) {
  const args = [
    "wrangler",
    "kv",
    "bulk",
    "put",
    filePath,
    "--binding",
    "ARTIST_TOP",
    "--remote",
    "--preview",
    "false",
  ];
  const r = spawnSync("npx", args, { cwd: ROOT, encoding: "utf8", shell: true });
  if (r.status !== 0) {
    throw new Error(`wrangler kv bulk put failed:\n${r.stdout || ""}\n${r.stderr || ""}`);
  }
  return r.stdout || "";
}

function wranglerKvKeyPut(key, filePath) {
  const args = [
    "wrangler",
    "kv",
    "key",
    "put",
    key,
    "--binding",
    "ARTIST_TOP",
    "--remote",
    "--preview",
    "false",
    "--path",
    filePath,
  ];
  const r = spawnSync("npx", args, { cwd: ROOT, encoding: "utf8", shell: true });
  if (r.status !== 0) {
    throw new Error(`wrangler kv key put failed:\n${r.stdout || ""}\n${r.stderr || ""}`);
  }
  return r.stdout || "";
}

const { bag, packs, fetched, hotIds } = await collectUrls();
const entries = [...bag.entries()];
console.log(
  `VIP covers: ${entries.length} unique URLs (hot artists ${hotIds}, packs ${packs}, live fetch ${fetched})`
);
if (!entries.length) {
  console.error("No cover URLs found. Run `npm run hot-tops` first or start api-enhanced.");
  process.exit(1);
}

const results = await mapPool(entries, DL_CONCURRENCY, async ([canon, href], idx) => {
  const got = await downloadOne(canon, href);
  if (!got.ok) {
    console.warn(`[${idx + 1}/${entries.length}] FAIL ${canon}: ${got.error}`);
    return null;
  }
  if ((idx + 1) % 25 === 0 || idx === 0) {
    console.log(`[${idx + 1}/${entries.length}] downloaded`);
  }
  return { key: got.key, value: got.value, base64: true, expiration_ttl: IMG_KV_TTL_SEC };
});

const payload = results.filter(Boolean);
console.log(`Downloaded ${payload.length} / ${entries.length}, uploading to KV…`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "heipa-covers-"));
try {
  for (let i = 0; i < payload.length; i += BULK_SIZE) {
    const chunk = payload.slice(i, i + BULK_SIZE);
    const file = path.join(tmpDir, `bulk-${i}.json`);
    fs.writeFileSync(file, JSON.stringify(chunk));
    console.log(`  bulk put ${i + 1}–${i + chunk.length}`);
    wranglerKvBulkPut(file);
  }

  const manifest = {
    updatedAt: new Date().toISOString(),
    urls: entries.map(([canon]) => canon),
    cursor: 0,
  };
  const manifestFile = path.join(tmpDir, "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  wranglerKvKeyPut(MANIFEST_KEY, manifestFile);
  console.log(`Manifest ${MANIFEST_KEY}: ${manifest.urls.length} urls`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("Done.");
