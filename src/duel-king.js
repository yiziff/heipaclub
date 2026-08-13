/**
 * 谁是单挑王：两歌手各 16 首 → 32 强。
 * 首轮强制 A vs B；每轮结束后尽量重排下一轮为 A vs B。
 */
import { buildBracket, isRoundComplete } from "./tournament.js";

export const DUEL_SONGS_PER_SIDE = 16;
export const DUEL_FIELD_SIZE = 32;

export function songKey(song) {
  return String(song?.id || song?.neteaseId || song?.title || "");
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function duelSideOf(song) {
  const s = String(song?.duelSide || "").toLowerCase();
  if (s === "a" || s === "b") return s;
  return "";
}

export function tagDuelSong(song, side, artist) {
  const id = String(song?.id || song?.neteaseId || songKey(song));
  return {
    id,
    neteaseId: song?.neteaseId ? String(song.neteaseId) : song?.id ? String(song.id) : null,
    title: song?.title || "",
    artist: song?.artist || artist?.name || "",
    album: song?.album || song?.collection || "",
    collection: song?.collection || song?.album || "",
    year: song?.year || "",
    cover: song?.cover || "",
    coverSm: song?.coverSm || song?.cover || "",
    duration_ms: song?.duration_ms || null,
    publishTime: song?.publishTime || null,
    playSource: song?.playSource || null,
    previewUrl: song?.previewUrl || "",
    itunesTrackId: song?.itunesTrackId || "",
    trackViewUrl: song?.trackViewUrl || "",
    duelSide: side === "b" ? "b" : "a",
    rosterArtistId: String(artist?.id || artist?.neteaseArtistId || ""),
    rosterArtistName: artist?.name || "",
  };
}

/** 两边各 perSide 首，打乱后交错 [A,B,A,B…] → 首轮全是 A vs B。 */
export function buildAbInterleavedField(songsA, songsB, { perSide = DUEL_SONGS_PER_SIDE } = {}) {
  const a = shuffle((songsA || []).slice(0, perSide));
  const b = shuffle((songsB || []).slice(0, perSide));
  const n = Math.min(a.length, b.length, perSide);
  if (n < 2) return [];
  const field = [];
  for (let i = 0; i < n; i++) {
    field.push(a[i], b[i]);
  }
  return field;
}

export function buildDuelBracket(songsA, songsB) {
  const field = buildAbInterleavedField(songsA, songsB);
  if (field.length < 4) return null;
  return buildBracket(field, { mode: "battle", max: DUEL_FIELD_SIZE, field });
}

export function emptyDuelState(artistA, artistB) {
  return {
    cupType: "duel-king",
    phase: "ready",
    duelArtists: [
      {
        id: artistA.id,
        name: artistA.name,
        avatar: artistA.avatar || "",
        neteaseArtistId: artistA.neteaseArtistId || "",
      },
      {
        id: artistB.id,
        name: artistB.name,
        avatar: artistB.avatar || "",
        neteaseArtistId: artistB.neteaseArtistId || "",
      },
    ],
    artistName: `${artistA.name} vs ${artistB.name}`,
    artistAvatar: artistA.avatar || artistB.avatar || "",
    songs: [],
    bracket: null,
    createdAt: new Date().toISOString(),
  };
}

/** 存活曲按 duelSide 计数。 */
export function duelAliveScores(bracket) {
  const alive = songsAliveInBracket(bracket);
  let a = 0;
  let b = 0;
  for (const s of alive) {
    const side = duelSideOf(s);
    if (side === "a") a += 1;
    else if (side === "b") b += 1;
  }
  return { a, b };
}

export function songsAliveInBracket(bracket) {
  if (!bracket?.rounds?.length) return [];
  const alive = new Map();
  for (const round of bracket.rounds) {
    for (const m of round) {
      if (m.winner) {
        alive.set(songKey(m.winner), m.winner);
        continue;
      }
      if (m.a) alive.set(songKey(m.a), m.a);
      if (m.b) alive.set(songKey(m.b), m.b);
    }
  }
  return [...alive.values()];
}

/**
 * 某轮全部结束后，把下一轮对阵尽量重排为 A vs B。
 */
export function rebalanceRoundForAb(bracket, completedRoundIndex) {
  if (!bracket?.rounds?.length) return bracket;
  if (!isRoundComplete(bracket, completedRoundIndex)) return bracket;
  const nextRound = bracket.rounds[completedRoundIndex + 1];
  if (!nextRound?.length) return bracket;

  const winners = (bracket.rounds[completedRoundIndex] || [])
    .map((m) => m.winner)
    .filter(Boolean);
  if (winners.length !== nextRound.length * 2) return bracket;

  const poolA = shuffle(winners.filter((s) => duelSideOf(s) === "a"));
  const poolB = shuffle(winners.filter((s) => duelSideOf(s) === "b"));
  const pairs = [];
  while (poolA.length && poolB.length) {
    pairs.push([poolA.pop(), poolB.pop()]);
  }
  const rest = shuffle([...poolA, ...poolB]);
  while (rest.length >= 2) {
    pairs.push([rest.pop(), rest.pop()]);
  }
  if (pairs.length !== nextRound.length) return bracket;

  const next = structuredClone(bracket);
  const row = next.rounds[completedRoundIndex + 1];
  for (let i = 0; i < row.length; i++) {
    row[i].a = pairs[i][0];
    row[i].b = pairs[i][1];
    row[i].winner = null;
  }
  return next;
}
