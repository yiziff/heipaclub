/**
 * 「从夯到拉」— 随机 15 位 Rapper，分档排序。
 * 夯最多 2 人。
 */

export const HANG_LA_COUNT = 15;

/** 抽签粉丝门槛选项 */
export const HANG_LA_FAN_FILTERS = [
  { id: "any", label: "无限制", minFans: 0 },
  { id: "10w", label: "10 万+", minFans: 100_000 },
  { id: "20w", label: "20 万+", minFans: 200_000 },
  { id: "50w", label: "50 万+", minFans: 500_000 },
  { id: "80w", label: "80 万+", minFans: 800_000 },
];

/** 抽签范围选项 */
export const HANG_LA_REGION_FILTERS = [
  { id: "cn", label: "华语" },
  { id: "west", label: "欧美" },
];

export const HANG_LA_TIERS = [
  { id: "hang", label: "夯", max: 2, hint: "最多 2 人" },
  { id: "dingji", label: "顶级", max: Infinity, hint: "" },
  { id: "renshangren", label: "人上人", max: Infinity, hint: "" },
  { id: "npc", label: "npc", max: Infinity, hint: "" },
  { id: "lale", label: "拉完了", max: Infinity, hint: "" },
];

export function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function filterArtistsByMinFans(artists, minFans = 0) {
  const min = Number(minFans) || 0;
  if (min <= 0) return [...artists];
  return artists.filter((a) => Number(a.fans || 0) >= min);
}

export function filterArtistsByRegion(artists, region = "all") {
  const mode = String(region || "cn");
  return artists.filter((a) => {
    const city = String(a.city || "");
    const tag = String(a.tag || "");
    const isWest = city.includes("欧美") || tag.includes("欧美");
    return mode === "west" ? isWest : !isWest;
  });
}

export function fanFilterMeta(id) {
  return HANG_LA_FAN_FILTERS.find((f) => f.id === id) || HANG_LA_FAN_FILTERS[0];
}

export function regionFilterMeta(id) {
  return HANG_LA_REGION_FILTERS.find((f) => f.id === id) || HANG_LA_REGION_FILTERS[0];
}

/** Random sample of n artists (lightweight cards). */
export function drawHangLaField(artists, n = HANG_LA_COUNT, { minFans = 0, region = "all" } = {}) {
  const eligible = filterArtistsByMinFans(filterArtistsByRegion(artists, region), minFans);
  const pool = shuffleInPlace(
    eligible.map((a) => ({
      id: String(a.id),
      name: a.name,
      avatar: a.avatar || "",
      fans: a.fans || 0,
      city: a.city || "",
      tag: a.tag || "",
    }))
  );
  return pool.slice(0, Math.min(n, pool.length));
}

export function emptyHangLaState(field, { mode = "open" } = {}) {
  const tiers = {};
  for (const t of HANG_LA_TIERS) tiers[t.id] = [];
  const ids = field.map((a) => a.id);
  if (mode === "blind") {
    const current = ids[0] || null;
    return {
      field,
      mode: "blind",
      queue: ids.slice(1),
      current,
      pool: current ? [current] : [],
      tiers,
      createdAt: new Date().toISOString(),
    };
  }
  return {
    field,
    mode: "open",
    queue: [],
    current: null,
    pool: ids,
    tiers,
    createdAt: new Date().toISOString(),
  };
}

export function tierMeta(tierId) {
  return HANG_LA_TIERS.find((t) => t.id === tierId) || null;
}

export function findArtist(field, id) {
  return field.find((a) => a.id === id) || null;
}

/** Remove id from pool + all tiers. */
export function detachArtist(state, artistId) {
  const next = structuredClone(state);
  next.pool = next.pool.filter((id) => id !== artistId);
  for (const t of HANG_LA_TIERS) {
    next.tiers[t.id] = (next.tiers[t.id] || []).filter((id) => id !== artistId);
  }
  // Keep blind fields consistent when cloning older states without them
  next.mode = state.mode || "open";
  next.queue = Array.isArray(state.queue) ? [...state.queue] : [];
  next.current = state.current ?? null;
  return next;
}

/**
 * Place artist into tier (or back to pool if tierId is null/"pool").
 * Blind mode: cannot return to pool; after place, reveal next from queue.
 * Returns { ok, state, error }.
 */
export function placeArtist(state, artistId, tierId) {
  if (!state.field.some((a) => a.id === artistId)) {
    return { ok: false, state, error: "不在本场名单里" };
  }

  const isBlind = state.mode === "blind";

  if (!tierId || tierId === "pool") {
    if (isBlind) {
      return { ok: false, state, error: "盲排模式不能移回待分配" };
    }
    const cleared = detachArtist(state, artistId);
    cleared.pool.push(artistId);
    return { ok: true, state: cleared, error: null };
  }

  const meta = tierMeta(tierId);
  if (!meta) return { ok: false, state, error: "未知档位" };

  if (isBlind && state.current && artistId !== state.current) {
    return { ok: false, state, error: "请先给当前这位排档" };
  }

  const next = detachArtist(state, artistId);
  next.mode = state.mode;
  next.queue = [...(state.queue || [])];
  next.current = state.current;

  const list = next.tiers[tierId] || [];
  if (list.length >= meta.max) {
    return {
      ok: false,
      state,
      error: meta.id === "hang" ? "「夯」最多只能放 2 人" : `「${meta.label}」已满`,
    };
  }
  next.tiers[tierId] = [...list, artistId];

  if (isBlind) {
    const upcoming = next.queue;
    next.current = upcoming[0] || null;
    next.queue = upcoming.slice(1);
    next.pool = next.current ? [next.current] : [];
  }

  return { ok: true, state: next, error: null };
}

export function hangLaProgress(state) {
  const placed = HANG_LA_TIERS.reduce((n, t) => n + (state.tiers[t.id]?.length || 0), 0);
  const total = state.field.length;
  const remaining =
    state.mode === "blind"
      ? (state.current ? 1 : 0) + (state.queue?.length || 0)
      : state.pool.length;
  return {
    placed,
    total,
    remaining,
    done: placed === total && remaining === 0,
  };
}

export function hangLaSummaryLines(state) {
  return HANG_LA_TIERS.map((t) => {
    const names = (state.tiers[t.id] || [])
      .map((id) => findArtist(state.field, id)?.name || id)
      .join("、");
    return `${t.label}：${names || "（空）"}`;
  });
}
