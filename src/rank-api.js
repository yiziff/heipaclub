/**
 * Anonymous rank API client (MUSIC CUP style).
 * Dev/prod both use relative /api/rank/* (Vite proxy → local rank server or CF Worker).
 */

const BASE = "/api/rank";

async function getJson(path, query = {}) {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rank ${path} HTTP ${res.status}`);
  return res.json();
}

export async function fetchSongRank({ limit = 150, q = "" } = {}) {
  return getJson("/songs", { limit, q });
}

export async function fetchArtistRank({ limit = 100, q = "" } = {}) {
  return getJson("/artists", { limit, q });
}

export async function fetchRankMeta() {
  try {
    return await getJson("/meta");
  } catch {
    return { updatedAt: null, songCount: 0, artistCount: 0 };
  }
}

/**
 * Report champion once per browser session per song+artist cup.
 */
export async function reportChampionWin({
  song,
  artistId,
  artistName,
  artistAvatar,
} = {}) {
  const songId = String(song?.neteaseId || song?.id || "").trim();
  if (!/^\d+$/.test(songId)) {
    return { ok: false, skipped: true, reason: "no song id" };
  }

  const dedupeKey = `cn-rap-cup:reported-win:${artistId || ""}:${songId}`;
  try {
    if (sessionStorage.getItem(dedupeKey)) {
      return { ok: true, skipped: true, reason: "already reported" };
    }
  } catch (_) {}

  const payload = {
    songId,
    artistId: artistId ? String(artistId) : "",
    title: song.title || "",
    // 用你选择开赛的那位歌手名（如「艾志恒Asen」），不用网易云合作艺人串
    artist: artistName || song.artist || "",
    artistName: artistName || song.artist || "",
    cover: song.cover || song.coverSm || "",
    avatar: artistAvatar || "",
  };

  const res = await fetch(BASE + "/win", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }

  if (data.counted === false) {
    return {
      ok: true,
      skipped: true,
      reason: data.reason || "daily_quota_exceeded",
      dailyLimit: data.dailyLimit ?? 5,
      usedToday: data.usedToday ?? null,
      remainingToday: data.remainingToday ?? 0,
    };
  }

  try {
    sessionStorage.setItem(dedupeKey, "1");
  } catch (_) {}

  return data;
}
