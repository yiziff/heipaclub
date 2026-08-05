/**
 * Audit itunes-map: list entries whose stored iTunes track no longer passes
 * the title matcher (wrong song, sequel, instrumental, loose substring).
 * Usage: node scripts/audit-itunes-map.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { titleScore } from "../src/itunes-match.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAP_DIR = path.join(ROOT, "src/data/itunes-map");
const TOPS_DIR = path.join(ROOT, "src/data/hot-tops");

const rows = [];
for (const file of fs.readdirSync(MAP_DIR)) {
  if (!file.endsWith(".json") || file === "index.json") continue;
  const map = JSON.parse(fs.readFileSync(path.join(MAP_DIR, file), "utf8"));
  const topsPath = path.join(TOPS_DIR, file);
  if (!fs.existsSync(topsPath)) continue;
  const tops = JSON.parse(fs.readFileSync(topsPath, "utf8"));
  const songs = Array.isArray(tops) ? tops : tops.songs || tops.list || [];
  const titleById = new Map(songs.map((s) => [String(s.neteaseId || s.id), s.title || ""]));

  for (const [nid, entry] of Object.entries(map.byNeteaseId || {})) {
    const want = titleById.get(String(nid));
    const got = entry?.itunesTitle;
    if (!want || !got) continue;
    if (titleScore(want, got) >= 85) continue;
    rows.push({ file: file.replace(/\.json$/, ""), nid, want, got });
  }
}

rows.sort((x, y) => x.file.localeCompare(y.file));
for (const r of rows) console.log(`${r.file}\t${r.nid}\t${r.want}  ->  ${r.got}`);
console.log(`\nbad=${rows.length}`);
