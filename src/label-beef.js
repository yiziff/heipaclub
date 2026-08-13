/**
 * 厂牌巅峰混战：双厂牌各 24 首 → 12 组×4（2+2）→ 每组晋级 2 → 复活补齐 → 32 强单败。
 * 复活席位默认 8（24+8），若直通因重复曲目/少组不足 24，则按缺口加复活。
 */
import { artistsInLabel, getLabel, HIPHOP_LABELS } from "./data/labels.js";
import { shuffleInPlace } from "./hangla.js";
import { buildBracket } from "./tournament.js";

export { HIPHOP_LABELS, getLabel };

export const BEEF_SONGS_PER_LABEL = 24;
export const BEEF_GROUP_COUNT = 12;
export const BEEF_GROUP_SIZE = 4;
export const BEEF_PICKS_PER_GROUP = 2;
export const BEEF_REVIVAL_COUNT = 8;
export const BEEF_FIELD_SIZE = 32;

export function songKey(song) {
  return String(song?.id || song?.neteaseId || song?.title || "");
}

export function uniqueSongs(songs) {
  const out = [];
  const seen = new Set();
  for (const s of songs || []) {
    const k = songKey(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** 32 强还差几首复活（直通不足时多于 8）。 */
export function beefRevivalTarget(advanced, goal = BEEF_FIELD_SIZE) {
  return Math.max(0, goal - uniqueSongs(advanced).length);
}

export function emptyBeefState(labelA, labelB) {
  return {
    cupType: "label-beef",
    phase: "loading", // loading | groups | revival | bracket | done
    labels: [
      { id: labelA.id, name: labelA.name, city: labelA.city || "" },
      { id: labelB.id, name: labelB.name, city: labelB.city || "" },
    ],
    songs: [],
    groups: [],
    groupIndex: 0,
    advanced: [],
    revivalPool: [],
    revivalPicks: [],
    wipeouts: [],
    bracket: null,
    createdAt: new Date().toISOString(),
  };
}

function tagLabelSong(s, key, label, m) {
  return {
    id: String(s.id || s.neteaseId || key),
    neteaseId: s.neteaseId ? String(s.neteaseId) : s.id ? String(s.id) : null,
    title: s.title,
    artist: s.artist || m.name,
    album: s.album || s.collection || "",
    collection: s.collection || s.album || "",
    year: s.year || "",
    cover: s.cover || "",
    coverSm: s.coverSm || s.cover || "",
    duration_ms: s.duration_ms || null,
    publishTime: s.publishTime || null,
    playSource: s.playSource || null,
    previewUrl: s.previewUrl || "",
    itunesTrackId: s.itunesTrackId || "",
    trackViewUrl: s.trackViewUrl || "",
    labelId: label.id,
    labelName: label.name,
    rosterArtistId: m.id,
    rosterArtistName: m.name,
  };
}

/**
 * Tag + trim hot songs for one label.
 * 先按成员均分取 perArtist 首；厂牌内合作曲去重后若不足 24，再从各成员剩余热门补齐。
 * （旧逻辑只拉 perArtist 首再去重，五人组这类合作多的厂牌会误报「仅 21 首」。）
 */
export async function loadLabelHotSongs(
  label,
  roster,
  { target = BEEF_SONGS_PER_LABEL, perArtist = 5, loadCup, fetchLimit = 50 } = {}
) {
  const members = artistsInLabel(roster, label.id).sort(
    (a, b) => Number(b.fans || 0) - Number(a.fans || 0)
  );
  if (!members.length) {
    throw new Error(`厂牌「${label.name}」名单内暂无成员`);
  }

  const lists = [];
  for (const m of members) {
    try {
      const cup = await loadCup(m, { limit: Math.max(fetchLimit, perArtist) });
      lists.push({ m, songs: cup.songs || [] });
    } catch {
      lists.push({ m, songs: [] });
    }
  }

  const pool = [];
  const seen = new Set();
  const cursors = lists.map(() => 0);
  const taken = lists.map(() => 0);

  const tryTake = (i, maxForMember) => {
    if (pool.length >= target) return false;
    if (taken[i] >= maxForMember) return false;
    const { m, songs } = lists[i];
    while (cursors[i] < songs.length) {
      const s = songs[cursors[i]++];
      const key = songKey(s);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pool.push(tagLabelSong(s, key, label, m));
      taken[i] += 1;
      return true;
    }
    return false;
  };

  // Pass 1：每人最多 perArtist，避免高粉成员独占名额
  let progressed = true;
  while (pool.length < target && progressed) {
    progressed = false;
    for (let i = 0; i < lists.length; i++) {
      if (tryTake(i, perArtist)) progressed = true;
    }
  }

  // Pass 2：合作曲去重导致不足时，从各成员剩余热门继续补
  progressed = true;
  while (pool.length < target && progressed) {
    progressed = false;
    for (let i = 0; i < lists.length; i++) {
      if (tryTake(i, Number.POSITIVE_INFINITY)) progressed = true;
    }
  }

  if (pool.length < target) {
    throw new Error(
      `厂牌「${label.name}」热门曲目不足（需要 ${target} 首，仅 ${pool.length} 首）`
    );
  }
  return pool.slice(0, target);
}

/**
 * Build 12 groups of 4: 2 from A + 2 from B, interleaved.
 */
export function buildBeefGroups(songsA, songsB) {
  const a = shuffleInPlace([...songsA]);
  const b = shuffleInPlace([...songsB]);
  const n = Math.min(
    BEEF_GROUP_COUNT,
    Math.floor(a.length / 2),
    Math.floor(b.length / 2)
  );
  const groups = [];
  for (let i = 0; i < n; i++) {
    const songs = [a[i * 2], b[i * 2], a[i * 2 + 1], b[i * 2 + 1]];
    shuffleInPlace(songs);
    groups.push({
      id: `g${i}`,
      songs,
      picks: [],
      eliminated: [],
      wipeout: null, // labelId if one label took both picks
    });
  }
  return groups;
}

export function toggleGroupPick(group, songId) {
  const song = group.songs.find((s) => songKey(s) === songId);
  if (!song) return { ok: false, group, error: "歌曲不在本组" };
  const picks = [...group.picks];
  const idx = picks.findIndex((s) => songKey(s) === songId);
  if (idx >= 0) {
    picks.splice(idx, 1);
    return { ok: true, group: { ...group, picks }, error: null };
  }
  if (picks.length >= BEEF_PICKS_PER_GROUP) {
    return { ok: false, group, error: `每组最多直通 ${BEEF_PICKS_PER_GROUP} 首` };
  }
  picks.push(song);
  return { ok: true, group: { ...group, picks }, error: null };
}

export function finalizeGroup(group) {
  if (group.picks.length !== BEEF_PICKS_PER_GROUP) {
    return { ok: false, group, error: `请选出 ${BEEF_PICKS_PER_GROUP} 首直通` };
  }
  const pickKeys = new Set(group.picks.map(songKey));
  const eliminated = group.songs.filter((s) => !pickKeys.has(songKey(s)));
  const labelIds = group.picks.map((s) => s.labelId).filter(Boolean);
  const wipeout =
    labelIds.length === 2 && labelIds[0] === labelIds[1] ? labelIds[0] : null;
  return {
    ok: true,
    group: { ...group, eliminated, wipeout },
    error: null,
  };
}

export function collectAfterGroups(groups) {
  const advanced = [];
  const revivalPool = [];
  const wipeouts = [];
  const advKeys = new Set();
  const poolKeys = new Set();
  for (const g of groups) {
    for (const s of g.picks || []) {
      const k = songKey(s);
      if (!k || advKeys.has(k)) continue;
      advKeys.add(k);
      advanced.push(s);
    }
    for (const s of g.eliminated || []) {
      const k = songKey(s);
      if (!k || advKeys.has(k) || poolKeys.has(k)) continue;
      poolKeys.add(k);
      revivalPool.push(s);
    }
    if (g.wipeout) {
      wipeouts.push({
        groupId: g.id,
        labelId: g.wipeout,
        labelName: g.picks[0]?.labelName || g.wipeout,
      });
    }
  }
  return { advanced, revivalPool, wipeouts };
}

export function toggleRevivalPick(picks, pool, songId, max = BEEF_REVIVAL_COUNT) {
  const song = pool.find((s) => songKey(s) === songId);
  if (!song) return { ok: false, picks, error: "不在复活池" };
  const next = [...picks];
  const idx = next.findIndex((s) => songKey(s) === songId);
  if (idx >= 0) {
    next.splice(idx, 1);
    return { ok: true, picks: next, error: null };
  }
  if (next.length >= max) {
    return { ok: false, picks, error: `最多复活 ${max} 首` };
  }
  next.push(song);
  return { ok: true, picks: next, error: null };
}

export function buildBeefBracket(advanced, revivalPicks) {
  const field = uniqueSongs([...(advanced || []), ...(revivalPicks || [])]);
  if (field.length !== BEEF_FIELD_SIZE) {
    const thru = uniqueSongs(advanced).length;
    const need = BEEF_FIELD_SIZE - field.length;
    throw new Error(
      need > 0
        ? `需要 ${BEEF_FIELD_SIZE} 首进淘汰赛，当前 ${field.length}（直通 ${thru}，还差 ${need} 首，请再复活）`
        : `淘汰赛只要 ${BEEF_FIELD_SIZE} 首，当前 ${field.length}`
    );
  }
  const shuffled = shuffleInPlace([...field]);
  return buildBracket(shuffled, { mode: "battle", max: BEEF_FIELD_SIZE, field: shuffled });
}

/** Count songs by label among a list. */
export function labelScoreFromSongs(songs, labels) {
  const counts = {};
  for (const l of labels) counts[l.id] = 0;
  for (const s of songs || []) {
    if (s?.labelId && counts[s.labelId] != null) counts[s.labelId] += 1;
  }
  return counts;
}

/** Songs still alive in bracket (winners + pending slots). */
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

export function beefProgressText(state) {
  if (!state) return "";
  if (state.phase === "groups") {
    return `小组直通 ${state.groupIndex + 1} / ${state.groups.length}`;
  }
  if (state.phase === "revival") {
    const need = beefRevivalTarget(state.advanced);
    return `复活 ${state.revivalPicks.length} / ${need}`;
  }
  if (state.phase === "bracket" && state.bracket) {
    const decided = state.bracket.rounds.flat().filter((m) => m.winner).length;
    const total = state.bracket.rounds.flat().length;
    return `淘汰赛 ${decided} / ${total}`;
  }
  return "";
}
