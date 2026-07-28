/**
 * iTunes Search / Lookup — public preview + artwork (MUSIC CUP style).
 * Dev: proxied via Vite /api/itunes → itunes.apple.com
 * Prod: direct https://itunes.apple.com
 */

const ITUNES_BASE = import.meta.env.DEV ? "/api/itunes" : "https://itunes.apple.com";
const COUNTRIES = ["cn", "hk", "us"];

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．._\-#（）()]/g, "");
}

export function itunesArt(url, size = 600) {
  if (!url) return "";
  return String(url).replace(/\d+x\d+bb/, `${size}x${size}bb`);
}

function yearOf(track) {
  const d = track?.releaseDate;
  if (!d) return "";
  return String(d).slice(0, 4);
}

function nameScore(query, artistName) {
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

async function itunesGet(pathname, query = {}, { timeoutMs = 10000 } = {}) {
  const url = new URL(ITUNES_BASE + pathname, window.location.origin);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`iTunes ${pathname} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function pingApi() {
  try {
    const data = await itunesGet("/search", { term: "a", entity: "song", limit: 1, country: "us" }, { timeoutMs: 8000 });
    return Array.isArray(data?.results);
  } catch {
    return false;
  }
}

/**
 * Search music artists. Fast path: cn first, then hk if needed.
 */
export async function searchArtist(keyword, { limit = 8, countries = ["cn", "hk", "us"] } = {}) {
  const want = String(keyword || "").trim();
  if (!want) return [];
  const wantNorm = norm(want);
  const isShortLatin = /^[a-z0-9.$#\-_]{1,5}$/i.test(wantNorm);
  const pooled = new Map();

  for (const country of countries) {
    try {
      const data = await itunesGet("/search", {
        term: want,
        entity: "musicArtist",
        limit,
        country,
      });
      for (const a of data?.results || []) {
        if (!a.artistId || !a.artistName) continue;
        const id = String(a.artistId);
        const score = nameScore(want, a.artistName);
        // Short latin queries like "Lu1" need looser threshold.
        const minScore = isShortLatin ? 10 : 40;
        if (score < minScore) continue;
        const prev = pooled.get(id);
        if (!prev || score > prev.score) {
          pooled.set(id, {
            id: a.artistId,
            name: a.artistName,
            avatar: "",
            score,
            country,
          });
        }
      }
      // Good enough match in this storefront — stop early
      const top = [...pooled.values()].sort((a, b) => b.score - a.score)[0];
      if (top && top.score >= 80) break;
    } catch (_) {}
  }

  return [...pooled.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function lookupSongs(artistId, country, limit = 50) {
  const data = await itunesGet("/lookup", {
    id: artistId,
    entity: "song",
    limit: Math.min(limit, 200),
    country,
  });
  return (data?.results || []).filter((r) => r.wrapperType === "track");
}

async function searchSongsByArtist(artistName, country, limit = 50) {
  const data = await itunesGet("/search", {
    term: artistName,
    entity: "song",
    attribute: "artistTerm",
    limit,
    country,
  });
  return data?.results || [];
}

function mapTrack(t, fallbackArtist = "") {
  const cover = itunesArt(t.artworkUrl100 || t.artworkUrl60 || "", 600);
  const coverSm = itunesArt(t.artworkUrl100 || t.artworkUrl60 || "", 200);
  return {
    id: String(t.trackId),
    itunesTrackId: String(t.trackId),
    itunesArtistId: t.artistId ? String(t.artistId) : "",
    title: t.trackName || "",
    artist: t.artistName || fallbackArtist,
    album: t.collectionName || "",
    collection: t.collectionName || "",
    cover,
    coverSm,
    previewUrl: t.previewUrl || "",
    trackViewUrl: t.trackViewUrl || t.collectionViewUrl || "",
    duration_ms: t.trackTimeMillis ?? null,
    year: yearOf(t),
  };
}

function dedupeTracks(tracks) {
  const byTitle = new Map();
  for (const t of tracks) {
    if (!t?.title) continue;
    const key = norm(t.title);
    const prev = byTitle.get(key);
    if (prev?.previewUrl && !t.previewUrl) continue;
    if (prev && !prev.previewUrl && t.previewUrl) {
      byTitle.set(key, t);
      continue;
    }
    if (!prev) byTitle.set(key, t);
  }
  return [...byTitle.values()];
}

function uniqueQueries(artist) {
  const raw = [artist.search, artist.name].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    const variants = [r, String(r).replace(/[（(].*$/, "").trim()];
    const latin = String(r).match(/[A-Za-z][A-Za-z0-9.$#]{1,}/g) || [];
    // Only keep longer latin tokens (avoid "L" from KEY.L)
    for (const t of latin) if (t.length >= 3) variants.push(t);
    for (const v of variants) {
      const key = norm(v);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
  }
  return out.slice(0, 3);
}

async function songsForCandidate(cand, limit) {
  const countries = [cand.country, ...COUNTRIES.filter((c) => c !== cand.country)].slice(0, 2);
  let bestMapped = [];
  let usedCountry = cand.country;

  for (const country of countries) {
    let tracks = await lookupSongs(cand.id, country, limit);
    tracks = tracks.filter(
      (t) =>
        !t.artistId ||
        String(t.artistId) === String(cand.id) ||
        nameScore(cand.name, t.artistName) >= 60
    );

    if (tracks.length < 10) {
      const extra = await searchSongsByArtist(cand.name, country, limit);
      tracks = [
        ...tracks,
        ...extra.filter(
          (t) =>
            String(t.artistId) === String(cand.id) ||
            nameScore(cand.name, t.artistName) >= 60
        ),
      ];
    }

    const mapped = dedupeTracks(tracks.map((t) => mapTrack(t, cand.name)));
    if (mapped.length > bestMapped.length) {
      bestMapped = mapped;
      usedCountry = country;
    }
    if (mapped.filter((s) => s.previewUrl).length >= 16) break;
  }

  return { songs: bestMapped, country: usedCountry };
}

/**
 * Resolve curated roster artist → iTunes avatar + top tracks with previews.
 */
export async function loadArtistCup(catalogArtist, { limit = 50 } = {}) {
  const queries = uniqueQueries(catalogArtist);
  const pooled = new Map();

  // Search with primary name first (fast), then one alternate if needed
  for (const q of queries) {
    const hits = await searchArtist(q, { limit: 5, countries: ["cn", "hk"] });
    for (const h of hits) {
      const id = String(h.id);
      const prev = pooled.get(id);
      if (!prev || h.score > prev.score) pooled.set(id, h);
    }
    const top = [...pooled.values()].sort((a, b) => b.score - a.score)[0];
    if (top && top.score >= 80) break;
  }

  const candidates = [...pooled.values()].sort((a, b) => b.score - a.score).slice(0, 2);
  if (!candidates.length) {
    throw new Error(`iTunes 找不到歌手：${catalogArtist.name}`);
  }

  let best = null;
  let bestSongs = [];
  let usedCountry = "cn";

  for (const cand of candidates) {
    const { songs, country } = await songsForCandidate(cand, limit);
    const previewCount = songs.filter((s) => s.previewUrl).length;
    const bestPreview = bestSongs.filter((s) => s.previewUrl).length;
    if (!best || previewCount > bestPreview || (previewCount === bestPreview && songs.length > bestSongs.length)) {
      best = cand;
      bestSongs = songs;
      usedCountry = country;
    }
    if (previewCount >= 16) break;
  }

  if (!best || !bestSongs.length) {
    throw new Error(`iTunes 未拉到歌曲：${catalogArtist.name}`);
  }

  const withPreview = bestSongs.filter((s) => s.previewUrl);
  const without = bestSongs.filter((s) => !s.previewUrl);
  const songs = [...withPreview, ...without].slice(0, limit);

  return {
    ...catalogArtist,
    itunesArtistId: best.id,
    itunesArtistName: best.name,
    itunesCountry: usedCountry,
    avatar: catalogArtist.avatar || songs.find((s) => s.cover)?.cover || "",
    songs,
  };
}

/** Strip feat./parens noise before title compare. */
function titleCore(s) {
  return String(s || "")
    .replace(/\s*[\(（][^）)]*[\)）]\s*/g, " ")
    .replace(/\s*(?:feat\.?|ft\.?|with)\s+.+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleScore(want, got) {
  const a = norm(titleCore(want));
  const b = norm(titleCore(got));
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;
  return 0;
}

const playSourceCache = new Map();

/** Common CN roster name → Apple Music / iTunes artist names */
const ITUNES_NAME_HINTS = {
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

function splitArtistCredits(raw) {
  return String(raw || "")
    .split(/[,，、/&]|(?:\s+feat\.?\s+)|(?:\s+ft\.?\s+)|(?:\s+with\s+)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function latinTokens(s) {
  return (String(s || "").match(/[A-Za-z][A-Za-z0-9.$#]{1,}/g) || []).filter((t) => t.length >= 3);
}

function expandArtistAliases(artistName, song, artistAliases = []) {
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
    // also hints keyed by roster name contained in string
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

/**
 * Match a NetEase-picked song to an iTunes track with previewUrl.
 * Conservative thresholds: prefer miss → netease over wrong Apple track.
 */
export async function resolvePlaySource(
  song,
  artistName,
  { countries = ["cn", "hk", "us"], artistAliases = [], bypassCache = false } = {}
) {
  const title = String(song?.title || "").trim();
  const artists = expandArtistAliases(artistName, song, artistAliases);
  if (!title) {
    return { ...song, playSource: "netease", previewUrl: song?.previewUrl || "" };
  }

  const cacheKey = `v2|${norm(artists.slice(0, 6).join(","))}|${norm(titleCore(title))}`;
  if (!bypassCache && playSourceCache.has(cacheKey)) {
    const hit = playSourceCache.get(cacheKey);
    return { ...song, ...hit };
  }

  let best = null;
  let bestScore = 0;

  const searchTerms = [
    ...artists.slice(0, 4).map((a) => [a, titleCore(title)].join(" ").trim()),
    titleCore(title),
  ].filter((t, i, arr) => t && arr.indexOf(t) === i);

  for (const term of searchTerms) {
    for (const country of countries) {
      try {
        const data = await itunesGet("/search", {
          term,
          entity: "song",
          limit: 12,
          country,
        });
        for (const t of data?.results || []) {
          if (!t?.previewUrl || !t.trackName) continue;
          const ts = titleScore(title, t.trackName);
          const as = Math.max(...artists.map((a) => nameScore(a, t.artistName || "")), 0);
          // Title must be strong; artist soft-match OR exact title with any credit overlap
          if (ts < 85) continue;
          if (as < 60 && ts < 100) continue;
          if (as < 40) continue;
          const score = ts * 0.7 + Math.max(as, 40) * 0.3;
          if (score > bestScore) {
            bestScore = score;
            best = t;
          }
        }
        if (best && bestScore >= 95) break;
      } catch {
        /* try next storefront */
      }
    }
    if (best && bestScore >= 95) break;
  }

  let patch;
  if (best) {
    patch = {
      playSource: "itunes",
      previewUrl: best.previewUrl,
      itunesTrackId: String(best.trackId),
      trackViewUrl: best.trackViewUrl || best.collectionViewUrl || "",
    };
  } else {
    patch = {
      playSource: "netease",
      previewUrl: "",
      itunesTrackId: "",
      trackViewUrl: "",
    };
  }
  playSourceCache.set(cacheKey, patch);
  return { ...song, ...patch };
}

/**
 * Enrich a field with playSource. Concurrency capped for iTunes rate.
 */
export async function enrichSongsPlaySource(
  songs,
  artistName,
  { concurrency = 5, artistAliases = [] } = {}
) {
  const list = Array.isArray(songs) ? songs : [];
  if (!list.length) return [];
  const out = list.map((s) => ({ ...s }));
  let cursor = 0;
  const workers = Math.min(Math.max(1, concurrency), list.length);

  async function worker() {
    while (cursor < list.length) {
      const idx = cursor++;
      const resolved = await resolvePlaySource(list[idx], artistName, { artistAliases });
      Object.assign(out[idx], {
        playSource: resolved.playSource,
        previewUrl: resolved.previewUrl || "",
        itunesTrackId: resolved.itunesTrackId || "",
        trackViewUrl: resolved.trackViewUrl || "",
      });
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

/**
 * Enrich first `readyCount` songs (enough to start), return immediately,
 * keep matching the rest in `background` (mutates song objects + onSong).
 */
export async function enrichSongsPlaySourceProgressive(
  songs,
  artistName,
  {
    concurrency = 6,
    artistAliases = [],
    readyCount = 4,
    onSong = null,
  } = {}
) {
  const list = Array.isArray(songs) ? songs : [];
  const out = list.map((s) => ({ ...s, playSource: s.playSource || null }));
  if (!list.length) {
    return { songs: out, background: Promise.resolve(out) };
  }

  async function enrichIndex(idx) {
    const resolved = await resolvePlaySource(list[idx], artistName, { artistAliases });
    Object.assign(out[idx], {
      playSource: resolved.playSource,
      previewUrl: resolved.previewUrl || "",
      itunesTrackId: resolved.itunesTrackId || "",
      trackViewUrl: resolved.trackViewUrl || "",
    });
    onSong?.(out[idx], idx);
    return out[idx];
  }

  async function runRange(start, end) {
    let cursor = start;
    const n = Math.max(0, end - start);
    if (!n) return;
    const workers = Math.min(Math.max(1, concurrency), n);
    async function worker() {
      while (cursor < end) {
        const idx = cursor++;
        await enrichIndex(idx);
      }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  const first = Math.min(Math.max(0, readyCount), list.length);
  await runRange(0, first);

  const background = runRange(first, list.length).then(() => out);
  return { songs: out, background };
}
