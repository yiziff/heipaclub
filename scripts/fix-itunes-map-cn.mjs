/**
 * Rewrite itunes-map trackViewUrl/preview from hk/us → cn via track lookup.
 * Usage: node scripts/fix-itunes-map-cn.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "../src/data/itunes-map");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookupCn(trackId) {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(trackId)}&country=cn`;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(600 + attempt * 400);
    const res = await fetch(url);
    if (res.status === 403 || res.status === 429) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text) {
      await sleep(1500);
      continue;
    }
    const data = JSON.parse(text);
    const t = (data.results || []).find((r) => r.wrapperType === "track" || r.trackId);
    return t || null;
  }
  return null;
}

function needsFix(entry) {
  const url = String(entry?.trackViewUrl || "");
  return /music\.apple\.com\/(hk|us|tw|jp)\//i.test(url) || /\/(hk|us)\//i.test(url);
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "index.json");
let fixed = 0;
let failed = 0;
let skipped = 0;

for (const f of files) {
  const p = path.join(DIR, f);
  const pack = JSON.parse(fs.readFileSync(p, "utf8"));
  let changed = 0;
  for (const [nid, entry] of Object.entries(pack.byNeteaseId || {})) {
    if (!needsFix(entry)) {
      skipped += 1;
      continue;
    }
    const tid = entry.itunesTrackId;
    if (!tid) {
      failed += 1;
      continue;
    }
    try {
      const t = await lookupCn(tid);
      if (!t?.previewUrl) {
        console.warn(`FAIL ${f} ${nid} track=${tid} no cn preview`);
        failed += 1;
        continue;
      }
      entry.previewUrl = t.previewUrl;
      entry.trackViewUrl = t.trackViewUrl || t.collectionViewUrl || entry.trackViewUrl.replace(/\/hk\//, "/cn/").replace(/\/us\//, "/cn/");
      entry.itunesTitle = t.trackName || entry.itunesTitle;
      entry.itunesArtistName = t.artistName || entry.itunesArtistName;
      changed += 1;
      fixed += 1;
      console.log(`OK ${f} ${nid} → ${entry.itunesTitle}`);
    } catch (e) {
      console.warn(`FAIL ${f} ${nid}: ${e.message || e}`);
      failed += 1;
    }
  }
  if (changed) {
    pack.updatedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(pack), "utf8");
  }
}

console.log(`\nDone. fixed=${fixed} failed=${failed} alreadyCnish=${skipped}`);
