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
export async function searchArtist(keyword, { limit = 8, countries = ["cn", "hk"] } = {}) {
  const want = String(keyword || "").trim();
  if (!want) return [];
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
        if (score < 40) continue;
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
