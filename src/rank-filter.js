/**
 * Client-side rank filters: 中文/欧美 via roster, 厂牌聚合 via labels.
 */
import { ARTISTS } from "./data/artists.js";
import { HIPHOP_LABELS, artistsInLabel } from "./data/labels.js";

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．._#()（）[\]【】]/g, "");
}

function isWestArtist(artist) {
  const city = String(artist?.city || "");
  const tag = String(artist?.tag || "");
  return city.includes("欧美") || tag.includes("欧美");
}

/** Build lookup: neteaseArtistId → "cn"|"west", name → "cn"|"west" */
let _maps = null;
function rosterMaps() {
  if (_maps) return _maps;
  const byNeteaseId = new Map();
  const byName = new Map();
  for (const a of ARTISTS) {
    const region = isWestArtist(a) ? "west" : "cn";
    if (a.neteaseArtistId) byNeteaseId.set(String(a.neteaseArtistId), region);
    const keys = [a.name, a.search, a.id].map(norm).filter(Boolean);
    for (const k of keys) {
      if (!byName.has(k)) byName.set(k, region);
    }
  }
  _maps = { byNeteaseId, byName };
  return _maps;
}

export function artistRegionOf({ artistId, name } = {}) {
  const { byNeteaseId, byName } = rosterMaps();
  const id = String(artistId || "").trim();
  if (id && byNeteaseId.has(id)) return byNeteaseId.get(id);
  const n = norm(name);
  if (n && byName.has(n)) return byName.get(n);
  // Unknown roster match → treat as 中文 (default board)
  return "cn";
}

export function filterRankItemsByRegion(items, region, kind) {
  const mode = region === "west" ? "west" : "cn";
  return (items || []).filter((item) => {
    if (kind === "songs") {
      return (
        artistRegionOf({ artistId: item.artistId, name: item.artist }) === mode
      );
    }
    return (
      artistRegionOf({ artistId: item.artistId, name: item.name }) === mode
    );
  });
}

/**
 * Aggregate artist wins into label leaderboard.
 * @param {Array<{artistId,name,avatar,wins}>} artistItems
 */
export function buildLabelRank(artistItems = []) {
  const winsByArtistId = new Map();
  const winsByName = new Map();
  for (const item of artistItems) {
    const w = Number(item.wins || 0);
    if (!w) continue;
    const id = String(item.artistId || "").trim();
    if (id) winsByArtistId.set(id, (winsByArtistId.get(id) || 0) + w);
    const n = norm(item.name);
    if (n) winsByName.set(n, Math.max(winsByName.get(n) || 0, w));
  }

  const rows = HIPHOP_LABELS.map((label) => {
    const members = artistsInLabel(ARTISTS, label.id);
    let wins = 0;
    const seen = new Set();
    for (const m of members) {
      const nid = m.neteaseArtistId ? String(m.neteaseArtistId) : "";
      if (nid && winsByArtistId.has(nid) && !seen.has(`id:${nid}`)) {
        wins += winsByArtistId.get(nid);
        seen.add(`id:${nid}`);
        continue;
      }
      const keys = [m.name, m.search, m.id].map(norm).filter(Boolean);
      for (const k of keys) {
        if (winsByName.has(k) && !seen.has(`n:${k}`)) {
          wins += winsByName.get(k);
          seen.add(`n:${k}`);
          break;
        }
      }
    }
    const top = members
      .slice()
      .sort((a, b) => Number(b.fans || 0) - Number(a.fans || 0))[0];
    return {
      labelId: label.id,
      name: label.name,
      city: label.city || "",
      members: members.length,
      wins,
      avatar: top?.avatar || "",
    };
  })
    .filter((r) => r.wins > 0 || r.members > 0)
    .sort((a, b) => b.wins - a.wins || b.members - a.members);

  return rows;
}

export function filterLabelRank(rows, q = "") {
  const needle = norm(q);
  if (!needle) return rows;
  return rows.filter(
    (r) =>
      norm(r.name).includes(needle) ||
      norm(r.city).includes(needle) ||
      norm(r.labelId).includes(needle)
  );
}

/**
 * Merge label-beef API stats with static HIPHOP_LABELS (city / members / avatar).
 * Labels with no battles still appear as「暂无对战」.
 * @param {Array<{labelId,name,avatar,wins,battles,winRate}>} apiItems
 */
export function mergeLabelBeefRank(apiItems = []) {
  const byId = new Map(
    (apiItems || []).map((r) => [String(r.labelId || "").trim(), r])
  );
  const rows = HIPHOP_LABELS.map((label) => {
    const members = artistsInLabel(ARTISTS, label.id);
    const top = members
      .slice()
      .sort((a, b) => Number(b.fans || 0) - Number(a.fans || 0))[0];
    const stat = byId.get(label.id);
    const wins = Number(stat?.wins || 0);
    const battles = Number(stat?.battles || 0);
    return {
      labelId: label.id,
      name: label.name,
      city: label.city || "",
      members: members.length,
      wins,
      battles,
      winRate: battles > 0 ? wins / battles : 0,
      avatar: stat?.avatar || top?.avatar || "",
    };
  }).sort(
    (a, b) =>
      b.winRate - a.winRate ||
      b.battles - a.battles ||
      b.wins - a.wins ||
      a.name.localeCompare(b.name, "zh")
  );
  return rows;
}
