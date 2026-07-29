/**
 * Shared iTunes title/artist matching helpers (browser + Node build).
 * Keep in sync: scripts/build-itunes-map.mjs imports these for offline indexing.
 */

export function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．._\-#（）()]/g, "");
}

/** Strip feat./parens noise before title compare. */
export function titleCore(s) {
  return String(s || "")
    .replace(/\s*[\(（][^）)]*[\)）]\s*/g, " ")
    .replace(/\s*(?:feat\.?|ft\.?|with)\s+.+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleScore(want, got) {
  const a = norm(titleCore(want));
  const b = norm(titleCore(got));
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;
  return 0;
}

export function nameScore(query, artistName) {
  const q = norm(query);
  const n = norm(artistName);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.includes(q) || q.includes(n)) return 80;
  let hit = 0;
  const parts = q.split(/(?=[a-z\u4e00-\u9fff])/i).filter((t) => t.length >= 2);
  for (const t of parts) if (n.includes(t)) hit += 1;
  return hit * 20;
}

/** Common CN roster name → Apple Music / iTunes artist names */
export const ITUNES_NAME_HINTS = {
  马思唯: ["Masiwei", "Higher Brothers"],
  法老: ["Pharaoh"],
  姜云升: ["Jiang Yunsheng"],
  "GAI周延": ["GAI", "GAI Zhouyan"],
  GAI周延: ["GAI"],
  艾志恒Asen: ["Asen", "艾志恒"],
  艾志恒: ["Asen"],
  罗言: ["罗言"],
  Jony: ["Jony J"],
  "Jony J": ["Jony J"],
  TizzyT: ["Tizzy T"],
  "Tizzy T": ["Tizzy T"],
  Rapeter: ["Rapeter", "Rapeter吴嘉轩"],
  王以太: ["Wang Yitai"],
};

export function splitArtistCredits(raw) {
  return String(raw || "")
    .split(/[,，、/&]|(?:\s+feat\.?\s+)|(?:\s+ft\.?\s+)|(?:\s+with\s+)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function latinTokens(s) {
  return (String(s || "").match(/[A-Za-z][A-Za-z0-9.$#]{1,}/g) || []).filter((t) => t.length >= 3);
}

export function expandArtistAliases(artistName, song, artistAliases = []) {
  const base = [
    artistName,
    song?.artist,
    ...artistAliases,
    ...splitArtistCredits(song?.artist),
    ...splitArtistCredits(artistName),
  ];
  const out = [];
  const seen = new Set();
  for (const raw of base) {
    const s = String(raw || "").trim();
    if (!s) continue;
    const candidates = [s, ...latinTokens(s), ...(ITUNES_NAME_HINTS[s] || [])];
    for (const [cn, en] of Object.entries(ITUNES_NAME_HINTS)) {
      if (s.includes(cn)) candidates.push(...en);
    }
    for (const c of candidates) {
      const key = norm(c);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

export function buildSearchTerms(title, artists, album = "") {
  const core = titleCore(title);
  const primaryArtist = artists[0] || "";
  const albumTrim = String(album || "").trim();
  return [
    primaryArtist ? `${primaryArtist} ${core}`.trim() : "",
    albumTrim && primaryArtist ? [primaryArtist, core].join(" ").trim() : "",
    core,
  ].filter((t, i, arr) => t && arr.indexOf(t) === i);
}

export function createTrackMatchState() {
  return { best: null, bestScore: 0 };
}

/**
 * Conservative thresholds: prefer miss → netease over wrong Apple track.
 * @param {{ best: any, bestScore: number }} state
 * @param {any} t raw iTunes track
 */
export function considerTrack(state, t, title, artists, artistBoost = 0) {
  if (!t?.previewUrl || !t.trackName) return;
  const ts = titleScore(title, t.trackName);
  const as = Math.max(...artists.map((a) => nameScore(a, t.artistName || "")), artistBoost, 0);
  if (ts < 85) return;
  if (as < 60 && ts < 100) return;
  if (as < 40) return;
  const score = ts * 0.7 + Math.max(as, 40) * 0.3;
  if (score > state.bestScore) {
    state.bestScore = score;
    state.best = t;
  }
}

export function playSourcePatchFromTrack(best) {
  if (best) {
    return {
      playSource: "itunes",
      previewUrl: best.previewUrl,
      itunesTrackId: String(best.trackId),
      trackViewUrl: best.trackViewUrl || best.collectionViewUrl || "",
      itunesTitle: best.trackName || "",
      itunesArtistName: best.artistName || "",
    };
  }
  return {
    playSource: "netease",
    previewUrl: "",
    itunesTrackId: "",
    trackViewUrl: "",
    itunesTitle: "",
    itunesArtistName: "",
  };
}

export function playSourceCacheKey(artists, title) {
  return `v4|${norm(artists.slice(0, 6).join(","))}|${norm(titleCore(title))}`;
}
