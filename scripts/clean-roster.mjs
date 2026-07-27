/**
 * Light post-filter: only strip obvious non-rapper false positives.
 * Do NOT deny real rappers like mac ova seas.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTISTS } from "../src/data/artists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../src/data/artists.js");

const DENY_NAME = [
  /邓紫棋|G\.E\.M/i,
  /李荣浩/,
  /王嘉尔/,
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
  // non-rap / false positives (user-flagged)
  /余佳运/,
  /暗杠/,
  /Toby Fox/i,
  /薛明媛/,
  /^Copy$/i,
  /melo chio/i,
  /Sakee云雾/i,
  /Galileo/i,
  /^K\.?ila$/i,
  /^Gai$/, // not GAI周延
  /茶理理/,
  /蔡明希|不才/,
  /卫彬月/,
  /李文世/,
  /Foxtail|Fox Stevenson|fox capture/i,
];

const cleaned = ARTISTS.filter((a) => !DENY_NAME.some((re) => re.test(a.name))).sort(
  (a, b) => (b.fans || 0) - (a.fans || 0)
);

const body = `/**
 * Auto-built Chinese rap roster: NetEase fans >= 20000.
 * Regenerate: npm run roster
 * Generated: ${new Date().toISOString()} · ${cleaned.length} artists
 */
export const ARTISTS = ${JSON.stringify(cleaned, null, 2)};

export function getArtist(id) {
  return ARTISTS.find((a) => a.id === id) || null;
}
`;

fs.writeFileSync(OUT, body, "utf8");
console.log(`Cleaned ${ARTISTS.length} → ${cleaned.length}`);
const must = ["mac ova seas", "SAKEE", "sakee", "MULA"];
for (const n of must) {
  const hit = cleaned.find((a) => a.name.toLowerCase().includes(n.toLowerCase()));
  console.log(`  ${n}: ${hit ? `${hit.name} (${hit.fans})` : "MISSING"}`);
}
