/**
 * Client for local api-enhanced (same stack as song-vocab-agent).
 * Proxied via Vite: /api/netease → http://127.0.0.1:3000
 */

const API = "/api/netease";

function hiRes(url, size = 500) {
  if (!url) return "";
  if (url.includes("param=")) return url;
  return url.includes("?") ? `${url}&param=${size}y${size}` : `${url}?param=${size}y${size}`;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．.]/g, "");
}

async function getJson(pathname, query = {}) {
  const url = new URL(API + pathname, window.location.origin);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`api-enhanced ${pathname} HTTP ${res.status}`);
  return res.json();
}

export async function pingApi() {
  try {
    const res = await fetch(API + "/search?keywords=a&limit=1");
    return res.ok;
  } catch {
    return false;
  }
}

export async function searchArtist(keyword) {
  const data = await getJson("/cloudsearch", {
    keywords: keyword,
    type: 100,
    limit: 8,
  });
  const artists = data?.result?.artists || [];
  const want = norm(keyword);
  const ranked = [...artists].sort((a, b) => {
    const an = norm(a.name);
    const bn = norm(b.name);
    const as = an === want ? 0 : an.includes(want) || want.includes(an) ? 1 : 2;
    const bs = bn === want ? 0 : bn.includes(want) || want.includes(bn) ? 1 : 2;
    return as - bs;
  });
  return ranked.map((a) => ({
    id: a.id,
    name: a.name,
    avatar: hiRes(a.img1v1Url || a.picUrl || "", 400),
  }));
}

/**
 * Hot top-N songs for an artist (api-enhanced /artist/songs order=hot).
 */
export async function artistTopSongs(artistId, limit = 50) {
  const data = await getJson("/artist/songs", {
    id: artistId,
    order: "hot",
    limit,
    offset: 0,
  });
  const songs = data?.songs || data?.hotSongs || [];
  const mapped = songs.slice(0, limit).map((s) => {
    const pic = s.al?.picUrl || "";
    const publishMs = Number(s.publishTime || s.al?.publishTime || 0) || 0;
    const year = publishYear(publishMs);
    return {
      id: String(s.id),
      neteaseId: String(s.id),
      title: s.name,
      artist: (s.ar || []).map((x) => x.name).join(", "),
      album: s.al?.name || "",
      collection: s.al?.name || "",
      cover: hiRes(pic, 500),
      coverSm: hiRes(pic, 200),
      duration_ms: s.dt ?? null,
      year,
      publishTime: publishMs || null,
    };
  });

  const missing = mapped.filter((s) => !s.year).map((s) => s.id);
  if (missing.length) {
    try {
      const detail = await getJson("/song/detail", { ids: missing.join(",") });
      const byId = new Map((detail?.songs || []).map((s) => [String(s.id), s]));
      for (const song of mapped) {
        if (song.year) continue;
        const raw = byId.get(song.id);
        if (!raw) continue;
        const ms = Number(raw.publishTime || raw.al?.publishTime || 0) || 0;
        const y = publishYear(ms);
        if (y) {
          song.year = y;
          song.publishTime = ms;
        }
        if (!song.album && raw.al?.name) {
          song.album = raw.al.name;
          song.collection = raw.al.name;
        }
      }
    } catch {
      /* keep partial meta */
    }
  }

  return mapped;
}

function publishYear(ms) {
  const n = Number(ms);
  if (!n || n < 1e11) return "";
  try {
    return String(new Date(n).getFullYear());
  } catch {
    return "";
  }
}

export async function songPlayUrl(songId) {
  try {
    const data = await getJson("/song/url/v1", {
      id: songId,
      level: "exhigh",
    });
    return data?.data?.[0]?.url || null;
  } catch {
    return null;
  }
}

export function neteaseSongPage(songId) {
  return `https://music.163.com/#/song?id=${encodeURIComponent(songId)}`;
}

/**
 * Resolve catalog artist → avatar + top50 tracks.
 * Prefer neteaseArtistId when roster was built from fans filter.
 */
export async function loadArtistCup(catalogArtist, { limit = 50 } = {}) {
  let best = null;
  if (catalogArtist.neteaseArtistId) {
    best = {
      id: catalogArtist.neteaseArtistId,
      name: catalogArtist.name,
      avatar: catalogArtist.avatar || "",
    };
  } else {
    const hits = await searchArtist(catalogArtist.search || catalogArtist.name);
    best = hits[0];
  }
  if (!best) {
    throw new Error(`找不到歌手：${catalogArtist.name}`);
  }
  // refresh avatar if missing
  if (!best.avatar) {
    const hits = await searchArtist(catalogArtist.search || catalogArtist.name);
    const matched =
      hits.find((h) => String(h.id) === String(best.id)) || hits[0];
    if (matched?.avatar) best.avatar = matched.avatar;
  }
  const songs = await artistTopSongs(best.id, limit);
  if (!songs.length) {
    throw new Error(`未拉到热门歌曲：${best.name}`);
  }
  return {
    ...catalogArtist,
    neteaseArtistId: best.id,
    neteaseArtistName: best.name,
    avatar: best.avatar || catalogArtist.avatar || "",
    songs,
  };
}
