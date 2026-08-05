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

/** 歌手大比拼专属夺冠榜（与歌曲夺冠所属歌手榜分离） */
export async function fetchArtistPkRank({ limit = 100, q = "" } = {}) {
  return getJson("/artists-pk", { limit, q });
}

export async function fetchLabelBeefRank({ limit = 200, q = "" } = {}) {
  return getJson("/labels", { limit, q });
}

export async function fetchLabelBeefMatchups(labelId) {
  const id = encodeURIComponent(String(labelId || "").trim());
  if (!id) throw new Error("rank /labels matchups: missing id");
  return getJson(`/labels/${id}/matchups`);
}

export async function fetchHangLaRank({ limit = 100 } = {}) {
  return getJson("/hangla", { limit });
}

/**
 * Report one finished「从夯到拉」round (夯 + 拉完了 lists).
 */
export async function reportHangLaRound({ hang = [], lale = [] } = {}) {
  const hangIds = hang.map((a) => String(a.artistId || a.id || "")).filter(Boolean).sort();
  const laleIds = lale.map((a) => String(a.artistId || a.id || "")).filter(Boolean).sort();
  if (!hangIds.length && !laleIds.length) {
    return { ok: false, skipped: true, reason: "empty" };
  }
  const dedupeKey = `cn-rap-cup:reported-hangla:${hangIds.join(",")}|${laleIds.join(",")}`;
  try {
    if (sessionStorage.getItem(dedupeKey)) {
      return { ok: true, skipped: true, reason: "already reported" };
    }
  } catch (_) {}

  const payload = {
    hang: hang.map((a) => ({
      artistId: String(a.artistId || a.id || ""),
      name: a.name || "",
      avatar: a.avatar || "",
    })),
    lale: lale.map((a) => ({
      artistId: String(a.artistId || a.id || ""),
      name: a.name || "",
      avatar: a.avatar || "",
    })),
  };

  const res = await fetch(BASE + "/hangla", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }
  if (data.counted !== false) {
    try {
      sessionStorage.setItem(dedupeKey, "1");
    } catch (_) {}
  }
  return data;
}

export async function fetchRankMeta() {
  try {
    return await getJson("/meta");
  } catch {
    return {
      updatedAt: null,
      songCount: 0,
      artistCount: 0,
      totalWins: 0,
      totalSongWins: 0,
      totalArtistWins: 0,
      participation: { total: 0, songPk: 0, artistPk: 0, label: 0, hangla: 0 },
    };
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
  cupType = "",
  songArtist = "",
  winnerLabelId = "",
  winnerLabelName = "",
  loserLabelId = "",
  loserLabelName = "",
} = {}) {
  const isArtistCup = cupType === "artist-cup";
  const isLabelBeef = cupType === "label-beef";
  const songId = String(song?.neteaseId || song?.id || "").trim();
  const resolvedArtistId = String(
    artistId || (isArtistCup ? songId : "") || ""
  ).trim();

  if (isArtistCup) {
    if (!/^\d+$/.test(resolvedArtistId)) {
      return { ok: false, skipped: true, reason: "no artist id", milestone: false };
    }
  } else if (!/^\d+$/.test(songId)) {
    return { ok: false, skipped: true, reason: "no song id", milestone: false };
  }

  const dedupeKey = isLabelBeef
    ? `cn-rap-cup:reported-win:beef:${winnerLabelId || ""}:${loserLabelId || ""}:${songId}`
    : isArtistCup
      ? `cn-rap-cup:reported-win:artist-cup:${resolvedArtistId}`
      : `cn-rap-cup:reported-win:${artistId || ""}:${songId}`;
  const milestoneKey = `${dedupeKey}:milestone`;
  const milestoneShownKey = `${dedupeKey}:milestone-shown`;
  const winsCacheKey = isArtistCup
    ? `cn-rap-cup:artist-wins:${resolvedArtistId}`
    : `cn-rap-cup:song-wins:${songId}`;
  try {
    if (sessionStorage.getItem(dedupeKey)) {
      const alreadyShown = sessionStorage.getItem(milestoneShownKey);
      const savedNo = Number(sessionStorage.getItem(milestoneKey) || 0);
      const cachedWins = Number(sessionStorage.getItem(winsCacheKey) || 0) || null;
      if (!alreadyShown && savedNo >= 100 && savedNo % 100 === 0) {
        return {
          ok: true,
          skipped: true,
          reason: "already reported",
          participantNo: savedNo,
          songWins: cachedWins,
          artistWins: isArtistCup ? cachedWins : null,
          milestone: true,
        };
      }
      return {
        ok: true,
        skipped: true,
        reason: "already reported",
        songWins: cachedWins,
        artistWins: isArtistCup ? cachedWins : null,
        milestone: false,
      };
    }
  } catch (_) {}

  const displayArtist = isLabelBeef
    ? songArtist || song?.rosterArtistName || song?.artist || ""
    : isArtistCup
      ? artistName || song?.title || song?.rosterArtistName || ""
      : artistName || song?.artist || "";

  const payload = {
    songId: isArtistCup ? resolvedArtistId : songId,
    artistId: resolvedArtistId,
    title: song.title || "",
    artist: displayArtist,
    artistName: isLabelBeef || isArtistCup ? displayArtist : artistName || song?.artist || "",
    songArtist: displayArtist,
    cover: song.cover || song.coverSm || "",
    avatar: artistAvatar || song.cover || "",
    cupType: cupType || "",
    winnerLabelId: winnerLabelId || "",
    winnerLabelName: winnerLabelName || "",
    loserLabelId: loserLabelId || "",
    loserLabelName: loserLabelName || "",
  };

  const res = await fetch(BASE + "/win", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}`, milestone: false };
  }

  if (data.counted === false) {
    return {
      ok: true,
      skipped: true,
      reason: data.reason || "daily_quota_exceeded",
      dailyLimit: data.dailyLimit ?? 5,
      usedToday: data.usedToday ?? null,
      remainingToday: data.remainingToday ?? 0,
      participantNo: null,
      milestone: false,
    };
  }

  try {
    sessionStorage.setItem(dedupeKey, "1");
  } catch (_) {}

  const songWins = Number(data.songWins || data.artistWins || 0) || null;
  if (songWins != null) {
    try {
      sessionStorage.setItem(winsCacheKey, String(songWins));
    } catch (_) {}
  }

  const participantNo = Number(data.participantNo || 0) || null;
  const milestone = Boolean(data.milestone) && participantNo != null;
  if (milestone) {
    try {
      sessionStorage.setItem(milestoneKey, String(participantNo));
    } catch (_) {}
  }

  return {
    ...data,
    songWins,
    participantNo,
    milestone,
  };
}

/** 彩蛋已展示后调用，避免同一次上报反复弹出 */
export function markMilestoneShown({ song, artistId } = {}) {
  const songId = String(song?.neteaseId || song?.id || "").trim();
  if (!songId) return;
  const key = `cn-rap-cup:reported-win:${artistId || ""}:${songId}:milestone-shown`;
  try {
    sessionStorage.setItem(key, "1");
  } catch (_) {}
}
