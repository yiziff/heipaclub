import "./style.css";
import {
  ARTISTS,
  getArtist,
} from "./data/artists.js";
import { HIPHOP_LABELS, artistsInLabel, getLabel } from "./data/labels.js";
import {
  BEEF_GROUP_COUNT,
  BEEF_PICKS_PER_GROUP,
  BEEF_REVIVAL_COUNT,
  BEEF_SONGS_PER_LABEL,
  beefProgressText,
  buildBeefBracket,
  buildBeefGroups,
  collectAfterGroups,
  emptyBeefState,
  finalizeGroup,
  labelScoreFromSongs,
  loadLabelHotSongs,
  songKey as beefSongKey,
  songsAliveInBracket,
  toggleGroupPick,
  toggleRevivalPick,
} from "./label-beef.js";
import { coverUrl, imgTag } from "./artwork.js";
import {
  drawHangLaField,
  emptyHangLaState,
  fanFilterMeta,
  filterArtistsByMinFans,
  filterArtistsByRegion,
  findArtist,
  hangLaProgress,
  HANG_LA_REGION_FILTERS,
  hangLaSummaryLines,
  HANG_LA_COUNT,
  HANG_LA_FAN_FILTERS,
  HANG_LA_TIERS,
  placeArtist,
  regionFilterMeta,
} from "./hangla.js";
import { loadArtistCup, pingApi, searchArtist as searchNeteaseArtist } from "./netease.js";
import {
  enrichSongsPlaySourceProgressive,
  loadArtistCup as loadItunesArtistCup,
  pingApi as pingItunesApi,
  resolvePlaySource,
  searchArtist as searchItunesArtist,
} from "./itunes.js";
import { createPlayer, stopAllPageAudio } from "./player.js";
import QRCode from "qrcode";
import {
  fetchArtistRank,
  fetchSongRank,
  reportChampionWin,
} from "./rank-api.js";
import {
  buildLabelRank,
  filterLabelRank,
  filterRankItemsByRegion,
} from "./rank-filter.js";
import {
  buildBracket,
  buildField,
  chooseWinner,
  currentMatch,
  findRoundIndex,
  isRoundComplete,
  nearestFieldSize,
  podiumFromBracket,
  progressText,
  roundLabel,
  splashForBracket,
} from "./tournament.js";

const STORAGE_KEY = "cn-rap-cup:v5";
const TOP_N = 50;
const FIELD_MAX = 32;
const SITE_URL = "https://heipaclub.com";
const app = document.getElementById("app");
const artistCache = new Map();
const runtimeArtistCatalog = new Map();
const avatarFillInFlight = new Set();

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearState() {
  localStorage.removeItem(STORAGE_KEY);
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  return { parts, hash };
}

function navigate(path) {
  location.hash = path;
}

window.addEventListener("hashchange", render);
bootstrap();

async function bootstrap() {
  // Soft-fill home avatars in background after first paint
  render();
  softFillAvatars();
}

function render() {
  stopAllPageAudio();
  const { parts } = route();
  const saved = loadState();

  if (parts[0] === "rank") {
    const tab =
      parts[1] === "artists" ? "artists" : parts[1] === "labels" ? "labels" : "songs";
    renderRank(tab);
    return;
  }
  if (parts[0] === "bracket" && saved?.bracket && !saved.bracket.champion) {
    renderBracketPreview(saved);
    return;
  }
  if (parts[0] === "play" && saved?.bracket && !saved.bracket.champion) {
    renderMatch(saved);
    return;
  }
  if (parts[0] === "champ" && saved?.bracket?.champion) {
    renderChamp(saved);
    return;
  }
  if (parts[0] === "artist" && parts[1]) {
    renderSetup(parts[1]);
    return;
  }
  if (parts[0] === "hangla") {
    renderHangLa();
    return;
  }
  if (parts[0] === "label-beef") {
    renderLabelBeef();
    return;
  }
  renderHome();
}

function shell(inner, { back, actions = "", wide = false, underBrand = "" } = {}) {
  return `
    <div class="shell ${wide ? "shell-wide" : ""}">
      <header class="topbar">
        <div class="topbar-brand-col">
          <a class="brand" href="#/" aria-label="黑怕巅峰对决首页">
            <div class="brand-mark"><span class="bm-a">黑怕</span><span class="bm-b">巅峰对决</span></div>
          </a>
          ${underBrand}
        </div>
        <div class="topbar-actions">
          ${actions}
          ${
            back
              ? `<button type="button" class="ghost-btn" data-back="${back}">${back === "/" ? "回首页" : "返回"}</button>`
              : `<a class="ghost-btn" href="#/rank">排行榜</a>`
          }
        </div>
      </header>
      ${inner}
    </div>
  `;
}

function bindBack() {
  app.querySelectorAll("[data-back]").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.back));
  });
}

async function softFillAvatars() {
  const noAvatar = ARTISTS.filter((a) => !a.avatar);
  if (!noAvatar.length) return;
  let cursor = 0;
  const workers = Math.min(6, noAvatar.length);
  async function worker() {
    while (cursor < noAvatar.length) {
      const idx = cursor++;
      await fillAvatarForArtist(noAvatar[idx]);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

function patchAvatarDom(artist) {
  const node = app.querySelector(`[data-artist="${artist.id}"] .artist-avatar, [data-artist="${artist.id}"] .img-fallback`);
  if (!node || !artist.avatar || location.hash.replace(/^#/, "") !== "/") return;
  const img = document.createElement("img");
  img.className = "artist-avatar";
  img.src = artist.avatar;
  img.alt = artist.name;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  node.replaceWith(img);
}

async function fillAvatarForArtist(artist) {
  if (!artist || artist.avatar) return;
  if (avatarFillInFlight.has(artist.id)) return;
  avatarFillInFlight.add(artist.id);
  try {
    if (artist.source === "itunes") {
      // iTunes artist search lacks avatar; fetch one top song to get artwork quickly.
      const loaded = await loadItunesArtistCup(artist, { limit: 1 });
      if (loaded?.avatar) {
        artist.avatar = loaded.avatar;
        patchAvatarDom(artist);
        return;
      }
    }
    const hits = await searchNeteaseArtist(artist.search || artist.name);
    if (hits[0]?.avatar) {
      artist.avatar = hits[0].avatar;
      patchAvatarDom(artist);
    }
  } catch (_) {
    // best-effort avatar hydration
  } finally {
    avatarFillInFlight.delete(artist.id);
  }
}

async function hydrateArtist(id) {
  if (artistCache.has(id)) return artistCache.get(id);
  const base = getArtist(id) || runtimeArtistCatalog.get(id);
  if (!base) return null;
  const live =
    base.source === "itunes"
      ? await loadItunesArtistCup(base, { limit: TOP_N })
      : await loadArtistCup(base, { limit: TOP_N });
  artistCache.set(id, live);
  // also stash avatar on catalog for home
  base.avatar = live.avatar;
  return live;
}

function renderHome() {
  /** @type {"fans" | "alpha" | "rank"} */
  let sortMode = "fans";
  /** @type {"cn" | "west" | "label"} */
  let regionMode = "cn";
  /** @type {string | null} */
  let labelId = null;
  let labelPanelOpen = false;
  /** Homepage list size (cn/west, no search). */
  let homeLimit = 50;
  let homeShowAll = false;
  /** neteaseArtistId or name → wins */
  const rankWins = new Map();

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[·．._\-#（）()]/g, "");

  const artistRegion = (artist) => {
    const city = String(artist?.city || "");
    const tag = String(artist?.tag || "");
    if (city.includes("欧美") || tag.includes("欧美")) return "west";
    return "cn";
  };

  const topByFans = (list, n = Infinity) => {
    const sorted = [...list].sort((a, b) => Number(b.fans || 0) - Number(a.fans || 0));
    if (!Number.isFinite(n) || n >= sorted.length) return sorted;
    return sorted.slice(0, n);
  };

  const basePool = () => {
    if (regionMode === "label" && labelId) {
      return artistsInLabel(ARTISTS, labelId);
    }
    return ARTISTS.filter((a) => artistRegion(a) === regionMode);
  };

  const filteredLocalList = (q = "") => {
    const query = q.trim().toLowerCase();
    const regioned = basePool();
    if (query || regionMode === "label") {
      if (!query) return [...regioned];
      return regioned.filter((a) =>
        [a.name, a.search, a.city, a.tag, a.blurb]
          .join(" ")
          .toLowerCase()
          .includes(query)
      );
    }
    const limit = homeShowAll ? Infinity : homeLimit;
    return topByFans(regioned, limit);
  };

  const resetHomePaging = () => {
    homeLimit = 50;
    homeShowAll = false;
  };

  const artistRankKey = (a) => String(a.neteaseArtistId || a.id || a.name || "");

  const sortList = (list) => {
    const arr = [...list];
    if (sortMode === "alpha") {
      arr.sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), "zh-CN", {
          sensitivity: "base",
          numeric: true,
        })
      );
      return arr;
    }
    if (sortMode === "rank") {
      arr.sort((a, b) => {
        const wa = rankWins.get(artistRankKey(a)) || rankWins.get(a.name) || 0;
        const wb = rankWins.get(artistRankKey(b)) || rankWins.get(b.name) || 0;
        if (wb !== wa) return wb - wa;
        return Number(b.fans || 0) - Number(a.fans || 0);
      });
      return arr;
    }
    // default: fans desc
    arr.sort((a, b) => Number(b.fans || 0) - Number(a.fans || 0));
    return arr;
  };

  const toRuntimeArtist = (hit) => {
    const id = `itunes:${hit.id}`;
    const existing = runtimeArtistCatalog.get(id);
    if (existing) {
      if (!existing.avatar && hit.avatar) existing.avatar = hit.avatar;
      return existing;
    }
    const created = {
      id,
      name: hit.name,
      search: hit.name,
      city: "iTunes",
      tag: "iTunes 搜索",
      blurb: "来自 iTunes 官方搜索 · 热门 Top 50 可办赛。",
      avatar: hit.avatar || "",
      fans: 0,
      source: "itunes",
      itunesArtistId: hit.id,
    };
    runtimeArtistCatalog.set(id, created);
    return created;
  };

  const mergeWithItunes = async (query, localList) => {
    const q = String(query || "").trim();
    if (!q) return localList;
    try {
      const hits = await searchItunesArtist(q, { limit: 8 });
      if (!hits.length) return localList;
      const seen = new Set(localList.map((a) => norm(a.name || a.search)));
      const extra = [];
      for (const hit of hits) {
        const key = norm(hit.name);
        if (seen.has(key)) continue;
        seen.add(key);
        extra.push(toRuntimeArtist(hit));
      }
      return [...localList, ...extra];
    } catch {
      return localList;
    }
  };

  const paintLabelPanel = () => {
    const panel = document.getElementById("label-panel");
    if (!panel) return;
    if (!labelPanelOpen) {
      panel.hidden = true;
      panel.innerHTML = "";
      return;
    }
    panel.hidden = false;
    panel.innerHTML = `
      <div class="label-panel-head">选择厂牌</div>
      <div class="label-chip-row">
        ${HIPHOP_LABELS.map((l) => {
          const n = artistsInLabel(ARTISTS, l.id).length;
          const city = l.city ? ` · ${esc(l.city)}` : "";
          return `
            <button type="button" class="label-chip${labelId === l.id ? " active" : ""}" data-label="${esc(l.id)}">
              <strong>${esc(l.name)}</strong>
              <span>${n} 人${city}</span>
            </button>`;
        }).join("")}
      </div>
    `;
    panel.querySelectorAll("[data-label]").forEach((btn) => {
      btn.addEventListener("click", () => {
        labelId = btn.dataset.label || null;
        regionMode = "label";
        labelPanelOpen = true;
        syncRegionChips();
        paintLabelPanel();
        apply();
      });
    });
  };

  const syncRegionChips = () => {
    document.querySelectorAll("#region-row [data-region]").forEach((c) => {
      const r = c.dataset.region;
      const on =
        r === "label" ? regionMode === "label" : regionMode === r && regionMode !== "label";
      c.classList.toggle("active", on);
    });
  };

  let searchToken = 0;
  const paintMoreBar = (shown, poolTotal, query) => {
    const bar = document.getElementById("home-more");
    if (!bar) return;
    const paging =
      !query && regionMode !== "label" && !homeShowAll && shown < poolTotal;
    if (!paging) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    const remain = poolTotal - shown;
    bar.innerHTML = `
      <button type="button" class="ghost-btn home-more-btn" id="home-more-btn">
        显示更多（再 ${Math.min(50, remain)} 位）
      </button>
      ${
        homeLimit > 50
          ? `<button type="button" class="primary-btn home-all-btn" id="home-all-btn">显示全部（${poolTotal}）</button>`
          : ""
      }
    `;
    document.getElementById("home-more-btn")?.addEventListener("click", () => {
      homeLimit += 50;
      paintGrid(input?.value || "");
    });
    document.getElementById("home-all-btn")?.addEventListener("click", () => {
      homeShowAll = true;
      paintGrid(input?.value || "");
    });
  };

  const paintGrid = async (q = "") => {
    const token = ++searchToken;
    const query = String(q || "").trim();
    const poolTotal =
      regionMode === "label" || query ? 0 : basePool().length;
    const localList = sortList(filteredLocalList(q));
    let list = localList;
    const grid = document.getElementById("artist-grid");
    const count = document.getElementById("artist-count");
    if (!grid) return;
    if (query && regionMode !== "label") {
      grid.innerHTML = `<p class="loading-line">正在搜索 iTunes 歌手…</p>`;
      list = sortList(await mergeWithItunes(query, localList));
      list = list.filter((a) => artistRegion(a) === regionMode);
      if (token !== searchToken) return;
    }
    const labelMeta = regionMode === "label" && labelId ? getLabel(labelId) : null;
    if (count) {
      if (query && regionMode !== "label") {
        count.textContent = `${list.length} 位匹配（本地 + iTunes）`;
      } else if (labelMeta) {
        count.textContent = `${labelMeta.name}${labelMeta.city ? ` · ${labelMeta.city}` : ""} · ${list.length} 位成员（名单内）`;
      } else {
        count.textContent = `${list.length} / ${poolTotal || ARTISTS.length} 位 Rapper（首页展示）`;
      }
    }
    grid.innerHTML = list.length
      ? list
          .map((a) => {
            const wins = rankWins.get(artistRankKey(a)) || rankWins.get(a.name) || 0;
            const winMeta =
              sortMode === "rank" && wins
                ? ` · 单曲夺冠 ${Number(wins).toLocaleString("zh-CN")} 次`
                : "";
            return `
        <button type="button" class="artist-card" data-artist="${a.id}">
          ${imgTag(a.avatar, { alt: a.name, className: "artist-avatar" })}
          <div class="artist-card-body">
            <div class="name">${esc(a.name)}</div>
            <p class="meta">${
              a.fans
                ? `${Number(a.fans).toLocaleString("zh-CN")} 粉`
                : a.source === "itunes"
                  ? "iTunes"
                  : `热门 ${TOP_N}`
            }${winMeta}</p>
          </div>
        </button>`;
          })
          .join("")
      : `<p class="loading-line">${
          regionMode === "label"
            ? "该厂牌成员暂未匹配到名单，或尚未收录。"
            : "没有匹配的 Rapper，换个关键词试试。"
        }</p>`;

    grid.querySelectorAll("[data-artist]").forEach((btn) => {
      btn.addEventListener("click", () => navigate(`/artist/${btn.dataset.artist}`));
    });

    list.slice(0, 24).forEach((a) => {
      if (!a.avatar) fillAvatarForArtist(a);
    });

    paintMoreBar(list.length, poolTotal, query);
  };

  app.innerHTML = shell(
    `
    <section class="hero">
      <div class="hero-title-glow">
        <span class="hero-glow-ring" aria-hidden="true"></span>
        <span class="hero-glow-ring hero-glow-ring-2" aria-hidden="true"></span>
        <h1>黑怕<br /><em>巅峰对决</em></h1>
      </div>
      <p class="hero-tagline">
        给你的本命 Rapper 办一场真正的说唱巅峰对决<br />
        <span>单曲对决 · 厂牌对抗 · 从夯到拉 · 选出你心中的 Rap Star</span>
      </p>
    </section>
    <div class="section-title">选择歌手 <span id="artist-count">50 / ${ARTISTS.length} 位 Rapper（首页展示）</span></div>
    <div class="search-row">
      <input id="artist-search" type="search" placeholder="搜：歌手名（本地 + iTunes）…" autocomplete="off" />
    </div>
    <div class="filter-row sort-row" id="region-row" role="group" aria-label="地区筛选">
      <span class="sort-label">范围</span>
      <button type="button" class="mode-chip active" data-region="cn">中文</button>
      <button type="button" class="mode-chip" data-region="west">欧美</button>
      <button type="button" class="mode-chip" data-region="label" id="label-entry">HipHop厂牌</button>
    </div>
    <div class="label-panel" id="label-panel" hidden></div>
    <div class="filter-row sort-row" id="sort-row" role="group" aria-label="排序方式">
      <span class="sort-label">排序</span>
      <button type="button" class="mode-chip active" data-sort="fans">粉丝量</button>
      <button type="button" class="mode-chip" data-sort="alpha">首字母</button>
      <button type="button" class="mode-chip" data-sort="rank">本站夺冠次数</button>
    </div>
    <div class="artist-grid" id="artist-grid"></div>
    <div class="home-more" id="home-more" hidden></div>
  `,
    {
      actions: `
        <button type="button" class="ghost-btn beef-top-btn" id="beef-entry">厂牌巅峰混战</button>
        <button type="button" class="ghost-btn hangla-top-btn" id="hangla-entry">锐评从夯到拉</button>
      `,
    }
  );

  const input = document.getElementById("artist-search");
  paintGrid("");

  document.getElementById("hangla-entry")?.addEventListener("click", () => navigate("/hangla"));
  document.getElementById("beef-entry")?.addEventListener("click", () => navigate("/label-beef"));

  let timer = null;
  const apply = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      paintGrid(input?.value || "");
    }, 180);
  };
  input?.addEventListener("input", () => {
    // searching: no need to reset paging permanently; empty search keeps limit
    apply();
  });

  document.querySelectorAll("#sort-row [data-sort]").forEach((chip) => {
    chip.addEventListener("click", () => {
      sortMode = chip.dataset.sort || "fans";
      document
        .querySelectorAll("#sort-row .mode-chip")
        .forEach((c) => c.classList.toggle("active", c === chip));
      apply();
    });
  });

  document.querySelectorAll("#region-row [data-region]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const r = chip.dataset.region;
      if (r === "label") {
        labelPanelOpen = !labelPanelOpen || regionMode !== "label";
        if (regionMode !== "label") {
          regionMode = "label";
          if (!labelId) labelId = HIPHOP_LABELS[0]?.id || null;
        }
        syncRegionChips();
        paintLabelPanel();
        if (labelId) apply();
        return;
      }
      regionMode = r === "west" ? "west" : "cn";
      labelId = null;
      labelPanelOpen = false;
      resetHomePaging();
      syncRegionChips();
      paintLabelPanel();
      apply();
    });
  });

  // load site artist wins for rank sort (best-effort)
  fetchArtistRank({ limit: 200 })
    .then((data) => {
      for (const item of data.items || []) {
        const wins = Number(item.wins || 0) || 0;
        if (item.artistId) rankWins.set(String(item.artistId), wins);
        if (item.name) rankWins.set(String(item.name), wins);
      }
      if (sortMode === "rank") apply();
    })
    .catch(() => {});

  const saved = loadState();
  if (saved?.cupType === "label-beef" && saved.phase && saved.phase !== "done" && !saved.bracket?.champion) {
    const resume = document.createElement("p");
    resume.style.marginTop = "1.5rem";
    const dest =
      saved.phase === "bracket" || saved.bracket
        ? "/play"
        : "/label-beef";
    resume.innerHTML = `<button type="button" class="primary-btn" id="resume-btn">继续厂牌混战 · ${esc(
      saved.artistName || "进行中"
    )}</button>`;
    app.querySelector(".shell")?.appendChild(resume);
    document.getElementById("resume-btn")?.addEventListener("click", () => navigate(dest));
  } else if (saved?.bracket && !saved.bracket.champion && saved.cupType !== "label-beef") {
    const resume = document.createElement("p");
    resume.style.marginTop = "1.5rem";
    resume.innerHTML = `<button type="button" class="primary-btn" id="resume-btn">继续未完赛的 ${esc(saved.artistName)}</button>`;
    app.querySelector(".shell")?.appendChild(resume);
    document.getElementById("resume-btn").addEventListener("click", () => navigate("/play"));
  }
}

function renderLabelBeef() {
  const saved = loadState();
  // 中途刷新会留下 phase=loading 且无 groups，按钮会永远停在「正在抽取」
  let state =
    saved?.cupType === "label-beef" &&
    saved.phase &&
    saved.phase !== "done" &&
    saved.phase !== "loading"
      ? saved
      : null;

  let pickA = state?.labels?.[0]?.id || saved?.labels?.[0]?.id || null;
  let pickB = state?.labels?.[1]?.id || saved?.labels?.[1]?.id || null;
  let toastTimer = null;
  let toastMsg = "";
  let loading = false;

  const showToast = (msg) => {
    toastMsg = msg || "";
    const el = document.getElementById("beef-toast");
    if (!el) return;
    el.hidden = !toastMsg;
    el.textContent = toastMsg;
    el.classList.toggle("is-on", Boolean(toastMsg));
    if (toastTimer) clearTimeout(toastTimer);
    if (toastMsg) {
      toastTimer = setTimeout(() => {
        toastMsg = "";
        el.classList.remove("is-on");
      }, 3200);
    }
  };

  const scoreBarHtml = (songs) => {
    if (!state?.labels?.length) return "";
    const scores = labelScoreFromSongs(songs, state.labels);
    const la = state.labels[0];
    const lb = state.labels[1];
    const a = scores[la.id] || 0;
    const b = scores[lb.id] || 0;
    const t = Math.max(1, a + b);
    return `
      <div class="beef-scorebar">
        <div class="beef-scorebar-names">
          <span>${esc(la.name)} ${a}</span>
          <span>${b} ${esc(lb.name)}</span>
        </div>
        <div class="beef-scorebar-track">
          <i style="width:${(a / t) * 100}%"></i>
          <b style="width:${(b / t) * 100}%"></b>
        </div>
      </div>`;
  };

  const songCard = (song, { selected = false, dim = false } = {}) => `
    <button type="button" class="beef-song-card${selected ? " is-selected" : ""}${
      dim ? " is-dim" : ""
    }" data-song="${esc(beefSongKey(song))}">
      ${imgTag(song.cover || song.coverSm, { alt: song.title, className: "beef-song-cover" })}
      <div class="beef-song-meta">
        <strong>${esc(song.title)}</strong>
        <span>${esc(song.rosterArtistName || song.artist || "")}</span>
        <em class="beef-song-label">${esc(song.labelName || "")}</em>
      </div>
    </button>`;

  const startLoading = async () => {
    const la = getLabel(pickA);
    const lb = getLabel(pickB);
    if (!la || !lb || la.id === lb.id) {
      showToast("请选择两个不同厂牌");
      return;
    }
    if (loading) return;
    loading = true;
    state = emptyBeefState(la, lb);
    state.phase = "loading";
    state.artistName = `${la.name} vs ${lb.name}`;
    saveState(state);
    paint();

    try {
      const loadCup = async (m, opts) => loadArtistCup(m, opts);
      const [songsA, songsB] = await Promise.all([
        loadLabelHotSongs(la, ARTISTS, {
          target: BEEF_SONGS_PER_LABEL,
          perArtist: 8,
          loadCup,
        }),
        loadLabelHotSongs(lb, ARTISTS, {
          target: BEEF_SONGS_PER_LABEL,
          perArtist: 8,
          loadCup,
        }),
      ]);
      const groups = buildBeefGroups(songsA, songsB);
      if (groups.length < BEEF_GROUP_COUNT) {
        throw new Error(
          `无法组成 ${BEEF_GROUP_COUNT} 组混战（A ${songsA.length} / B ${songsB.length} 首）`
        );
      }
      state = {
        ...state,
        phase: "groups",
        songs: [...songsA, ...songsB],
        groups,
        groupIndex: 0,
        advanced: [],
        revivalPool: [],
        revivalPicks: [],
        wipeouts: [],
      };
      saveState(state);
      // progressive enrich first batch
      enrichSongsPlaySourceProgressive(state.songs.slice(0, 8), la.name, {
        readyCount: 4,
        concurrency: 2,
      }).catch(() => {});
      loading = false;
      paint();
    } catch (e) {
      loading = false;
      state = null;
      clearState();
      paint();
      showToast(e.message || "拉歌失败，请确认本地 api-enhanced 已启动");
    }
  };

  const paint = () => {
    // Setup picker
    if (!state || (state.phase === "loading" && !state.groups?.length)) {
      app.innerHTML = shell(
        `
        <section class="beef-screen">
          <header class="beef-head">
            <h1>厂牌巅峰混战</h1>
            <p>两大厂牌各出 24 首热门 → 12 组混战直通 → 复活 8 首 → 32 强单败决出曲库之王</p>
          </header>
          <div class="beef-pick-grid" role="group" aria-label="选择厂牌 A">
            <div class="beef-section-label">厂牌 A</div>
            <div class="label-chip-row">
              ${HIPHOP_LABELS.map((l) => {
                const n = artistsInLabel(ARTISTS, l.id).length;
                return `<button type="button" class="label-chip${
                  pickA === l.id ? " active" : ""
                }" data-pick="a" data-label="${esc(l.id)}" ${loading ? "disabled" : ""}>
                  <strong>${esc(l.name)}</strong>
                  <span>${n} 人${l.city ? ` · ${esc(l.city)}` : ""}</span>
                </button>`;
              }).join("")}
            </div>
          </div>
          <div class="beef-vs-mark">VS</div>
          <div class="beef-pick-grid" role="group" aria-label="选择厂牌 B">
            <div class="beef-section-label">厂牌 B</div>
            <div class="label-chip-row">
              ${HIPHOP_LABELS.map((l) => {
                const n = artistsInLabel(ARTISTS, l.id).length;
                return `<button type="button" class="label-chip${
                  pickB === l.id ? " active" : ""
                }" data-pick="b" data-label="${esc(l.id)}" ${loading ? "disabled" : ""}>
                  <strong>${esc(l.name)}</strong>
                  <span>${n} 人${l.city ? ` · ${esc(l.city)}` : ""}</span>
                </button>`;
              }).join("")}
            </div>
          </div>
          <div class="beef-actions">
            <button type="button" class="primary-btn" id="beef-start" ${
              loading || !pickA || !pickB || pickA === pickB ? "disabled" : ""
            }>${loading ? "正在抽取曲库…" : "开始混战（48 首）"}</button>
          </div>
          <p class="hangla-toast beef-toast${toastMsg ? " is-on" : ""}" id="beef-toast" role="status">${esc(
            toastMsg
          )}</p>
        </section>
      `,
        { back: "/" }
      );
      bindBack();
      app.querySelectorAll("[data-pick]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (loading) return;
          const side = btn.dataset.pick;
          const id = btn.dataset.label;
          if (side === "a") pickA = id;
          else pickB = id;
          paint();
        });
      });
      document.getElementById("beef-start")?.addEventListener("click", () => startLoading());
      return;
    }

    // Group stage
    if (state.phase === "groups") {
      const g = state.groups[state.groupIndex];
      const priorPicks = state.groups
        .slice(0, state.groupIndex)
        .flatMap((x) => x.picks || []);
      const alive = [...priorPicks, ...(g?.picks || [])];
      app.innerHTML = shell(
        `
        <section class="beef-screen">
          <header class="beef-head">
            <h1>小组直通 · ${state.groupIndex + 1}/${state.groups.length}</h1>
            <p>已按热度选出前 ${state.songs.length} 首 · 每组选 ${BEEF_PICKS_PER_GROUP} 首直通</p>
          </header>
          ${scoreBarHtml(alive)}
          <div class="beef-group-grid">
            ${g.songs.map((s) => songCard(s, { selected: g.picks.some((p) => beefSongKey(p) === beefSongKey(s)) })).join("")}
          </div>
          <div class="beef-actions">
            <button type="button" class="primary-btn" id="beef-group-next" ${
              g.picks.length === BEEF_PICKS_PER_GROUP ? "" : "disabled"
            }>确认直通（${g.picks.length}/${BEEF_PICKS_PER_GROUP}）</button>
          </div>
          <p class="hangla-toast beef-toast" id="beef-toast" role="status"></p>
        </section>
      `,
        { back: "/" }
      );
      bindBack();
      app.querySelectorAll("[data-song]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const res = toggleGroupPick(g, btn.dataset.song);
          if (!res.ok) {
            showToast(res.error);
            return;
          }
          state.groups[state.groupIndex] = res.group;
          saveState(state);
          paint();
        });
      });
      document.getElementById("beef-group-next")?.addEventListener("click", () => {
        const fin = finalizeGroup(state.groups[state.groupIndex]);
        if (!fin.ok) {
          showToast(fin.error);
          return;
        }
        state.groups[state.groupIndex] = fin.group;
        if (fin.group.wipeout) {
          const name = fin.group.picks[0]?.labelName || "一方";
          showRoundSplash(
            { title: "团灭！", sub: `${name} 包揽本组直通 · 屠杀警告` },
            () => afterGroupConfirm()
          );
          return;
        }
        afterGroupConfirm();
      });
      return;
    }

    // Revival
    if (state.phase === "revival") {
      app.innerHTML = shell(
        `
        <section class="beef-screen">
          <header class="beef-head">
            <h1>败者复活</h1>
            <p>落选 ${state.revivalPool.length} 首再复活 ${BEEF_REVIVAL_COUNT} 首 → 凑齐 32 强</p>
          </header>
          ${scoreBarHtml([...state.advanced, ...state.revivalPicks])}
          <div class="beef-group-grid beef-revival-grid">
            ${state.revivalPool
              .map((s) =>
                songCard(s, {
                  selected: state.revivalPicks.some((p) => beefSongKey(p) === beefSongKey(s)),
                })
              )
              .join("")}
          </div>
          <div class="beef-actions">
            <button type="button" class="primary-btn" id="beef-revival-go" ${
              state.revivalPicks.length === BEEF_REVIVAL_COUNT ? "" : "disabled"
            }>进入 32 强（已选 ${state.revivalPicks.length}/${BEEF_REVIVAL_COUNT}）</button>
          </div>
          <p class="hangla-toast beef-toast" id="beef-toast" role="status"></p>
        </section>
      `,
        { back: "/" }
      );
      bindBack();
      app.querySelectorAll("[data-song]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const res = toggleRevivalPick(state.revivalPicks, state.revivalPool, btn.dataset.song);
          if (!res.ok) {
            showToast(res.error);
            return;
          }
          state.revivalPicks = res.picks;
          saveState(state);
          paint();
        });
      });
      document.getElementById("beef-revival-go")?.addEventListener("click", () => {
        try {
          const bracket = buildBeefBracket(state.advanced, state.revivalPicks);
          state = {
            ...state,
            phase: "bracket",
            bracket,
            artistName: `${state.labels[0].name} vs ${state.labels[1].name}`,
            artistAvatar: "",
          };
          saveState(state);
          navigate("/bracket");
        } catch (e) {
          showToast(e.message || "组签失败");
        }
      });
      return;
    }

    // If bracket phase but user landed on /label-beef
    if (state.phase === "bracket" && state.bracket && !state.bracket.champion) {
      navigate("/play");
      return;
    }
    if (state.bracket?.champion) {
      navigate("/champ");
      return;
    }

    // fallback reset
    state = null;
    paint();
  };

  const afterGroupConfirm = () => {
    if (state.groupIndex < state.groups.length - 1) {
      state.groupIndex += 1;
      saveState(state);
      paint();
      return;
    }
    const { advanced, revivalPool, wipeouts } = collectAfterGroups(state.groups);
    state = {
      ...state,
      phase: "revival",
      advanced,
      revivalPool,
      revivalPicks: [],
      wipeouts,
    };
    saveState(state);
    showRoundSplash(
      {
        title: "进入复活赛",
        sub: `直通 ${advanced.length} 首 · 落选 ${revivalPool.length} 首再复活 ${BEEF_REVIVAL_COUNT} 首`,
      },
      () => paint()
    );
  };

  paint();
}

function hangLaChip(artist, { selected = false, inTier = false } = {}) {
  if (!artist) return "";
  return `
    <button
      type="button"
      class="hangla-chip${selected ? " is-selected" : ""}${inTier ? " in-tier" : ""}"
      data-hangla-id="${esc(artist.id)}"
    >
      ${imgTag(artist.avatar, { alt: artist.name, className: "hangla-chip-avatar" })}
      <span class="hangla-chip-name">${esc(artist.name)}</span>
    </button>
  `;
}

function hangLaBlindCard(artist) {
  if (!artist) return `<p class="hangla-empty">全部排完了</p>`;
  return `
    <div class="hangla-blind-card" data-hangla-id="${esc(artist.id)}">
      ${imgTag(artist.avatar, { alt: artist.name, className: "hangla-blind-avatar" })}
      <div class="hangla-blind-meta">
        <strong>${esc(artist.name)}</strong>
        <span>${esc(artist.city || artist.tag || "Rapper")}${artist.fans ? ` · ${Number(artist.fans).toLocaleString("zh-CN")} 粉` : ""}</span>
      </div>
    </div>
  `;
}

function renderHangLa() {
  let fanFilterId = "any";
  let regionFilterId = "cn";
  let playMode = "open"; // open | blind
  let state = null;
  let selectedId = null;
  let toastTimer = null;

  const minFansOf = () => fanFilterMeta(fanFilterId).minFans;
  const regionOf = () => regionFilterMeta(regionFilterId).id;
  const eligibleCount = () =>
    filterArtistsByMinFans(filterArtistsByRegion(ARTISTS, regionOf()), minFansOf()).length;
  const modeLabel = () => (playMode === "blind" || state?.mode === "blind" ? "盲排" : "明牌");

  const showToast = (msg) => {
    const el = document.getElementById("hangla-toast");
    if (!el) return;
    el.hidden = false;
    el.textContent = msg;
    el.classList.add("is-on");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-on"), 1800);
  };

  const startRound = () => {
    const field = drawHangLaField(ARTISTS, HANG_LA_COUNT, {
      minFans: minFansOf(),
      region: regionOf(),
    });
    if (field.length < 3) {
      showToast("符合条件的 Rapper 太少，请降低粉丝门槛");
      return false;
    }
    state = emptyHangLaState(field, { mode: playMode });
    selectedId = state.mode === "blind" ? state.current : null;
    return true;
  };

  const fanLabel = () => fanFilterMeta(fanFilterId).label;
  const regionLabel = () => regionFilterMeta(regionFilterId).label;

  const paint = (mode = "setup") => {
    if (mode === "setup") {
      const count = eligibleCount();
      app.innerHTML = shell(
        `
        <section class="hangla-screen">
          <header class="hangla-head">
            <h1>从夯到拉</h1>
            <p>随机抽 ${HANG_LA_COUNT} 位 · 「夯」最多 2 人 · 选模式与粉丝门槛再开抽</p>
          </header>

          <div class="hangla-setup">
            <div class="hangla-section-label">玩法模式</div>
            <div class="filter-row sort-row" id="hangla-mode-row" role="group" aria-label="玩法模式">
              <button type="button" class="mode-chip${playMode === "open" ? " active" : ""}" data-play-mode="open">明牌</button>
              <button type="button" class="mode-chip${playMode === "blind" ? " active" : ""}" data-play-mode="blind">盲排</button>
            </div>
            <p class="hangla-setup-hint">${
              playMode === "blind"
                ? "盲排：不会一次性亮出 15 人，排完一位再翻下一位。"
                : "明牌：先看到全部 15 人，再自由分档。"
            }</p>

            <div class="hangla-section-label">抽签范围</div>
            <div class="filter-row sort-row" id="hangla-region-row" role="group" aria-label="抽签范围">
              ${HANG_LA_REGION_FILTERS.map(
                (f) => `
                <button type="button" class="mode-chip hangla-region-chip${f.id === regionFilterId ? " active" : ""}" data-region-filter="${f.id}">
                  ${esc(f.label)}
                </button>`
              ).join("")}
            </div>

            <div class="hangla-section-label">网易云粉丝最低要求</div>
            <div class="filter-row sort-row" id="hangla-fan-row" role="group" aria-label="粉丝门槛">
              ${HANG_LA_FAN_FILTERS.map(
                (f) => `
                <button type="button" class="mode-chip${f.id === fanFilterId ? " active" : ""}" data-fan-filter="${f.id}">
                  ${esc(f.label)}
                </button>`
              ).join("")}
            </div>
            <p class="hangla-setup-meta">当前池子（${esc(regionLabel())}）约 <strong>${count}</strong> 位 · 将随机抽取 ${Math.min(
              HANG_LA_COUNT,
              count
            )} 人</p>
            <div class="hangla-actions">
              <button type="button" class="primary-btn" id="hangla-start" ${count < 3 ? "disabled" : ""}>开始抽签</button>
            </div>
          </div>
          <p class="hangla-toast" id="hangla-toast" role="status"></p>
        </section>
      `,
        { back: "/" }
      );
      bindBack();

      document.querySelectorAll("#hangla-mode-row [data-play-mode]").forEach((chip) => {
        chip.addEventListener("click", () => {
          playMode = chip.dataset.playMode === "blind" ? "blind" : "open";
          paint("setup");
        });
      });
      document.querySelectorAll("#hangla-region-row [data-region-filter]").forEach((chip) => {
        chip.addEventListener("click", () => {
          regionFilterId = chip.dataset.regionFilter || "all";
          paint("setup");
        });
      });
      document.querySelectorAll("#hangla-fan-row [data-fan-filter]").forEach((chip) => {
        chip.addEventListener("click", () => {
          fanFilterId = chip.dataset.fanFilter || "any";
          paint("setup");
        });
      });
      document.getElementById("hangla-start")?.addEventListener("click", () => {
        if (!startRound()) {
          paint("setup");
          showToast("符合条件的 Rapper 太少，请降低粉丝门槛");
          return;
        }
        paint("play");
      });
      return;
    }

    if (!state) {
      paint("setup");
      return;
    }

    const progress = hangLaProgress(state);
    const blind = state.mode === "blind";

    if (mode === "done") {
      const lines = hangLaSummaryLines(state);
      app.innerHTML = shell(
        `
        <section class="hangla-screen">
          <header class="hangla-head">
            <h1>从夯到拉 · 结果</h1>
            <p>${esc(modeLabel())} · ${esc(regionLabel())} · 粉丝门槛 ${esc(fanLabel())} · 随机 ${state.field.length} 位 · 夯最多 2 人</p>
          </header>
          <div class="hangla-result">
            ${HANG_LA_TIERS.map((t) => {
              const ids = state.tiers[t.id] || [];
              return `
                <div class="hangla-result-row tier-${t.id}">
                  <div class="hangla-tier-label">${esc(t.label)}</div>
                  <div class="hangla-result-names">
                    ${
                      ids.length
                        ? ids
                            .map((id) => {
                              const a = findArtist(state.field, id);
                              return `<span class="hangla-result-pill">${imgTag(a?.avatar, {
                                alt: a?.name || "",
                                className: "hangla-chip-avatar",
                              })}${esc(a?.name || id)}</span>`;
                            })
                            .join("")
                        : `<span class="hangla-empty">（空）</span>`
                    }
                  </div>
                </div>`;
            }).join("")}
          </div>
          <div class="hangla-actions">
            <button type="button" class="primary-btn" id="hangla-copy">复制结果</button>
            <button type="button" class="ghost-btn" id="hangla-again">同一设置再抽</button>
            <button type="button" class="ghost-btn" id="hangla-reset">改设置</button>
          </div>
          <p class="hangla-toast" id="hangla-toast" role="status"></p>
        </section>
      `,
        { back: "/" }
      );
      bindBack();
      document.getElementById("hangla-copy")?.addEventListener("click", async () => {
        const text = [`黑怕 · 从夯到拉 · ${modeLabel()}（${regionLabel()} / ${fanLabel()}）`, ...lines].join("\n");
        try {
          await navigator.clipboard.writeText(text);
          showToast("已复制到剪贴板");
        } catch {
          showToast("复制失败，请手动截图");
        }
      });
      document.getElementById("hangla-again")?.addEventListener("click", () => {
        if (!startRound()) return;
        paint("play");
      });
      document.getElementById("hangla-reset")?.addEventListener("click", () => {
        state = null;
        paint("setup");
      });
      return;
    }

    const current = blind ? findArtist(state.field, state.current) : null;
    if (blind && state.current) selectedId = state.current;

    const poolBlock = blind
      ? `
        <div class="hangla-pool-wrap hangla-blind-wrap">
          <div class="hangla-section-label">
            当前翻牌 ${progress.placed + (state.current ? 1 : 0)} / ${progress.total}
            ${state.queue?.length ? ` · 后面还藏着 ${state.queue.length} 位` : ""}
          </div>
          <div class="hangla-blind-stage" id="hangla-pool">
            ${
              state.current
                ? hangLaBlindCard(current)
                : `<p class="hangla-empty">15 位都排完了，可以出结果</p>`
            }
            ${
              state.queue?.length
                ? `<div class="hangla-blind-stack" aria-hidden="true">${Array.from(
                    { length: Math.min(5, state.queue.length) },
                    () => `<span class="hangla-blind-back">?</span>`
                  ).join("")}</div>`
                : ""
            }
          </div>
          <p class="hangla-setup-hint">直接点下方档位放入当前这位 · 下一位才会揭晓</p>
        </div>`
      : `
        <div class="hangla-pool-wrap">
          <div class="hangla-section-label">待分配 ${state.pool.length}</div>
          <div class="hangla-pool" id="hangla-pool">
            ${
              state.pool.length
                ? state.pool
                    .map((id) => hangLaChip(findArtist(state.field, id), { selected: id === selectedId }))
                    .join("")
                : `<p class="hangla-empty">全部就位，可以出结果了</p>`
            }
          </div>
        </div>`;

    app.innerHTML = shell(
      `
      <section class="hangla-screen${blind ? " is-blind" : ""}">
        <header class="hangla-head">
          <h1>从夯到拉${blind ? " · 盲排" : ""}</h1>
          <p>${
            blind
              ? `${esc(regionLabel())} · 粉丝门槛 ${esc(fanLabel())} · 一次只亮一位 · 「夯」最多 2 人 · 进度 ${progress.placed} / ${progress.total}`
              : `${esc(regionLabel())} · 粉丝门槛 ${esc(fanLabel())} · 先点人再点档位 · 「夯」最多 2 人 · 进度 ${progress.placed} / ${progress.total}`
          }</p>
        </header>

        ${poolBlock}

        <div class="hangla-tiers" id="hangla-tiers">
          ${HANG_LA_TIERS.map((t) => {
            const ids = state.tiers[t.id] || [];
            const dropHint = blind
              ? state.current
                ? "点这里放入当前这位"
                : "已排完"
              : selectedId
                ? "点这里放入"
                : "先选待分配的人";
            return `
              <button type="button" class="hangla-tier tier-${t.id}" data-tier="${t.id}">
                <div class="hangla-tier-head">
                  <strong>${esc(t.label)}</strong>
                  <span>${ids.length}${t.max < Infinity ? ` / ${t.max}` : ""}${t.hint ? ` · ${esc(t.hint)}` : ""}</span>
                </div>
                <div class="hangla-tier-body">
                  ${
                    ids.length
                      ? ids
                          .map((id) =>
                            hangLaChip(findArtist(state.field, id), {
                              selected: !blind && id === selectedId,
                              inTier: true,
                            })
                          )
                          .join("")
                      : `<span class="hangla-drop-hint">${dropHint}</span>`
                  }
                </div>
              </button>`;
          }).join("")}
        </div>

        <div class="hangla-actions">
          <button type="button" class="primary-btn" id="hangla-finish" ${progress.done ? "" : "disabled"}>完成排行</button>
          <button type="button" class="ghost-btn" id="hangla-redraw">同一设置再抽</button>
          <button type="button" class="ghost-btn" id="hangla-reset">改设置</button>
          ${
            blind
              ? ""
              : `<button type="button" class="ghost-btn" id="hangla-clear" ${selectedId ? "" : "hidden"}>取消选中</button>`
          }
        </div>
        <p class="hangla-toast" id="hangla-toast" role="status"></p>
      </section>
    `,
      { back: "/" }
    );
    bindBack();

    const placeSelected = (tierId, rowEl) => {
      const id = blind ? state.current : selectedId;
      if (!id) {
        showToast(blind ? "已经排完了" : "先点一位 Rapper");
        return;
      }
      const res = placeArtist(state, id, tierId);
      if (!res.ok) {
        showToast(res.error || "放不下");
        rowEl?.classList.add("is-shake");
        setTimeout(() => rowEl?.classList.remove("is-shake"), 420);
        return;
      }
      state = res.state;
      selectedId = blind ? state.current : null;
      paint("play");
    };

    if (!blind) {
      const pick = (id) => {
        selectedId = selectedId === id ? null : id;
        paint("play");
      };
      app.querySelectorAll("[data-hangla-id]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          pick(btn.dataset.hanglaId);
        });
      });
      document.getElementById("hangla-pool")?.addEventListener("click", (e) => {
        if (e.target.closest("[data-hangla-id]")) return;
        if (!selectedId) return;
        const res = placeArtist(state, selectedId, "pool");
        if (res.ok) {
          state = res.state;
          selectedId = null;
          paint("play");
        }
      });
      document.getElementById("hangla-clear")?.addEventListener("click", () => {
        selectedId = null;
        paint("play");
      });
    } else {
      // Blind: chips in tiers are display-only
      app.querySelectorAll(".hangla-tier .hangla-chip").forEach((btn) => {
        btn.addEventListener("click", (e) => e.stopPropagation());
      });
    }

    app.querySelectorAll("[data-tier]").forEach((row) => {
      row.addEventListener("click", () => placeSelected(row.dataset.tier, row));
    });

    document.getElementById("hangla-redraw")?.addEventListener("click", () => {
      if (!startRound()) return;
      paint("play");
    });

    document.getElementById("hangla-reset")?.addEventListener("click", () => {
      state = null;
      selectedId = null;
      paint("setup");
    });

    document.getElementById("hangla-finish")?.addEventListener("click", () => {
      if (!hangLaProgress(state).done) {
        showToast("还有人没分完档");
        return;
      }
      paint("done");
    });
  };

  paint("setup");
}

async function renderSetup(artistId) {
  const base = getArtist(artistId) || runtimeArtistCatalog.get(artistId);
  if (!base) {
    app.innerHTML = shell(
      `<section class="setup"><p class="loading-line">名单里没有这位歌手</p></section>`,
      { back: "/" }
    );
    bindBack();
    return;
  }

  app.innerHTML = shell(
    `<section class="setup"><p class="loading-line">正在拉取「${esc(base.name)}」热门…</p></section>`,
    { back: "/" }
  );
  bindBack();

  let artist;
  try {
    const online = base.source === "itunes" ? await pingItunesApi() : await pingApi();
    if (!online) {
      throw new Error(
        base.source === "itunes"
          ? "连不上 iTunes 接口，请检查网络后重试"
          : "连不上音乐接口，请先启动本地服务后再刷新"
      );
    }
    artist = await hydrateArtist(artistId);
  } catch (e) {
    app.innerHTML = shell(
      `<section class="setup"><p class="loading-line">拉取失败：${esc(e.message || e)}</p></section>`,
      { back: "/" }
    );
    bindBack();
    return;
  }

  const fieldSize = nearestFieldSize(Math.min(artist.songs.length, FIELD_MAX), { max: FIELD_MAX });
  let mode = "battle";
  let fieldSongs = buildField(artist.songs, { mode, max: FIELD_MAX });

  const paint = () => {
    const preview = fieldSongs;

    app.innerHTML = shell(
      `
      <section class="setup">
        <div class="setup-head setup-head-with-avatar">
          ${imgTag(artist.avatar, { alt: artist.name, className: "setup-avatar" })}
          <div>
            <h1>${esc(artist.name)}</h1>
            <p>${esc(artist.city)} · ${esc(artist.tag)} · 热门 ${artist.songs.length} 首 · ${fieldSize} 强</p>
          </div>
        </div>
        <div class="section-title">对阵玩法</div>
        <div class="mode-row">
          <button type="button" class="mode-chip ${mode === "battle" ? "active" : ""}" data-mode="battle">1v1 Battle</button>
          <button type="button" class="mode-chip ${mode === "hot" ? "active" : ""}" data-mode="hot">热门顺序</button>
        </div>
        <div class="setup-actions">
          <button type="button" class="primary-btn" id="start-btn">一键开赛 · ${fieldSize} 强</button>
          ${
            mode === "battle"
              ? `<button type="button" class="ghost-btn" id="reshuffle-btn">再打乱一次</button>`
              : ""
          }
        </div>
        <div class="section-title">参赛签表（${fieldSize} / Top ${artist.songs.length}）</div>
        <ul class="song-preview">
          ${preview
            .map(
              (s, i) => `
              <li>
                ${imgTag(coverUrl(s, artist.avatar), { alt: s.title, className: "song-cover" })}
                <span class="song-preview-text">
                  <strong>${i + 1}. ${esc(s.title)}</strong>
                  <em>${esc(s.album || "单曲")}${
                    mode === "battle" && i % 2 === 0 && preview[i + 1]
                      ? ` · vs ${esc(preview[i + 1].title)}`
                      : ""
                  }${
                    s.playSource === "itunes"
                      ? " · Apple"
                      : s.playSource === "netease"
                        ? " · 网易云"
                        : ""
                  }</em>
                </span>
              </li>`
            )
            .join("")}
        </ul>
      </section>
    `,
      { back: "/" }
    );
    bindBack();

    app.querySelectorAll("[data-mode]").forEach((chip) => {
      chip.addEventListener("click", () => {
        mode = chip.dataset.mode;
        fieldSongs = buildField(artist.songs, { mode, max: FIELD_MAX });
        paint();
      });
    });

    document.getElementById("reshuffle-btn")?.addEventListener("click", () => {
      fieldSongs = buildField(artist.songs, { mode: "battle", max: FIELD_MAX });
      paint();
    });

    document.getElementById("start-btn").addEventListener("click", async () => {
      const btn = document.getElementById("start-btn");
      const prevLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = "准备开赛…";
      const aliases = [artist.search, artist.neteaseArtistName].filter(Boolean);
      try {
        // First 4 songs ≈ first 2 matches — enough to start; rest match in background
        const { songs: partial, background } = await enrichSongsPlaySourceProgressive(
          fieldSongs,
          artist.name,
          {
            concurrency: 6,
            artistAliases: aliases,
            readyCount: 4,
            onSong: (song) => {
              const s = loadState();
              if (!s?.bracket) return;
              s.bracket = patchPlaySourceInBracket(s.bracket, song);
              saveState(s);
            },
          }
        );
        fieldSongs = partial;
        const bracket = buildBracket(artist.songs, {
          mode,
          max: FIELD_MAX,
          field: fieldSongs,
        });
        saveState({
          artistId: artist.id,
          artistName: artist.name,
          artistAvatar: artist.avatar || "",
          neteaseArtistId: artist.neteaseArtistId || "",
          artistSearch: artist.search || "",
          playSourceReady: 4,
          bracket,
        });
        navigate("/bracket");
        background
          .then((all) => {
            const s = loadState();
            if (!s?.bracket) return;
            const itunesN = all.filter((x) => x.playSource === "itunes").length;
            s.playSourceStats = { itunes: itunesN, total: all.length };
            s.playSourceReady = all.length;
            saveState(s);
          })
          .catch(() => {});
      } catch (e) {
        btn.disabled = false;
        btn.textContent = prevLabel;
        alert(`准备开赛失败：${e.message || e}`);
      }
    });
  };

  paint();
}

function songKey(song) {
  if (!song) return "";
  return String(song.id || song.neteaseId || song.title || "");
}

/** Merge iTunes/netease play fields into every copy of a song inside the bracket. */
function patchPlaySourceInBracket(bracket, song) {
  const key = songKey(song);
  if (!key || !bracket) return bracket;
  const patch = (s) => {
    if (!s || songKey(s) !== key) return s;
    return {
      ...s,
      playSource: song.playSource,
      previewUrl: song.previewUrl || "",
      itunesTrackId: song.itunesTrackId || "",
      trackViewUrl: song.trackViewUrl || "",
    };
  };
  return {
    ...bracket,
    rounds: (bracket.rounds || []).map((round) =>
      round.map((m) => ({
        ...m,
        a: patch(m.a),
        b: patch(m.b),
        winner: m.winner ? patch(m.winner) : m.winner,
      }))
    ),
    champion: bracket.champion ? patch(bracket.champion) : null,
  };
}

async function ensureSongPlaySource(state, song) {
  if (!song) return song;
  if (song.playSource === "itunes" || song.playSource === "netease") return song;
  const aliases = [state.artistSearch, state.artistName].filter(Boolean);
  const resolved = await resolvePlaySource(song, state.artistName, {
    artistAliases: aliases,
  });
  const nextBracket = patchPlaySourceInBracket(state.bracket, resolved);
  const next = { ...state, bracket: nextBracket };
  saveState(next);
  return resolved;
}

function isSameSong(a, b) {
  const ka = songKey(a);
  const kb = songKey(b);
  return Boolean(ka && kb && ka === kb);
}

function bracketSlot(song, fallbackAvatar, { onPath = false, roundIndex = -1, wing = "" } = {}) {
  if (!song) {
    return `<div class="bracket-slot is-empty"><span>待定</span></div>`;
  }
  const pathCls = onPath ? " on-path" : "";
  const pathAttrs = onPath
    ? ` data-path-round="${roundIndex}" data-path-wing="${esc(wing)}"`
    : "";
  return `
    <div class="bracket-slot${pathCls}" title="${esc(song.title)}"${pathAttrs}>
      ${imgTag(coverUrl(song, fallbackAvatar), { alt: song.title, className: "bracket-slot-cover" })}
      <span class="bracket-slot-title">${esc(song.title)}</span>
    </div>
  `;
}

function shortRoundLabel(size, roundIndex) {
  const remaining = size / 2 ** roundIndex;
  if (remaining === 2) return "决赛";
  if (remaining === 4) return "半决赛";
  if (remaining === 8) return "8强";
  return `${remaining}强`;
}

function renderRoundColumn(matches, label, side, fallbackAvatar, champ, roundIndex) {
  return `
    <div class="bracket-round" data-side="${side}" data-round="${roundIndex}">
      <div class="bracket-round-label">${esc(label)}</div>
      <div class="bracket-round-matches">
        ${matches
          .map(
            (m) => `
            <div class="bracket-match${
              champ && (isSameSong(m.a, champ) || isSameSong(m.b, champ)) ? " has-path" : ""
            }">
              ${bracketSlot(m.a, fallbackAvatar, {
                onPath: isSameSong(m.a, champ),
                roundIndex,
                wing: side,
              })}
              ${bracketSlot(m.b, fallbackAvatar, {
                onPath: isSameSong(m.b, champ),
                roundIndex,
                wing: side,
              })}
            </div>`
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderBracketHtml(bracket, fallbackAvatar) {
  const rounds = bracket.rounds;
  const finalIndex = rounds.length - 1;
  const finalRound = rounds[finalIndex] || [];
  const feederCount = Math.max(0, finalIndex);
  const champ = bracket.champion || null;
  const pathClass = champ ? " has-champ-path" : "";

  const leftCols = [];
  const rightCols = [];
  for (let ri = 0; ri < feederCount; ri++) {
    const round = rounds[ri] || [];
    const mid = Math.ceil(round.length / 2);
    const leftMatches = round.slice(0, mid);
    const rightMatches = round.slice(mid);
    const label = shortRoundLabel(bracket.size, ri);
    leftCols.push(renderRoundColumn(leftMatches, label, "left", fallbackAvatar, champ, ri));
    rightCols.unshift(renderRoundColumn(rightMatches, label, "right", fallbackAvatar, champ, ri));
  }

  const finalMatch = finalRound[0] || { a: null, b: null };
  const artistBg = fallbackAvatar
    ? `--artist-bg:url('${String(fallbackAvatar).replace(/'/g, "%27")}');`
    : "";

  const champHero = champ
    ? `
      <div
        class="bracket-champ-hero"
        data-path-round="${finalIndex + 1}"
        data-path-wing="champ"
      >
        <div class="champ-hero-aura" aria-hidden="true"></div>
        <div class="champ-hero-orbit" aria-hidden="true"></div>
        <div class="champ-hero-cover-wrap">
          ${imgTag(coverUrl(champ, fallbackAvatar), {
            alt: champ.title,
            className: "champ-hero-cover",
          })}
          <span class="champ-hero-crown" aria-hidden="true">♛</span>
        </div>
        <div class="champ-hero-badge">冠军 · CHAMPION</div>
        <div class="champ-hero-title">${esc(champ.title)}</div>
        <div class="champ-hero-meta">${esc(metaLine(champ) || "")}</div>
      </div>`
    : `
      <div class="bracket-champ">
        <div class="bracket-round-label">冠军</div>
        <div class="bracket-slot is-empty champ-slot"><span>本命曲</span></div>
      </div>`;

  return `
    <div class="bracket-fit" id="bracket-fit">
      <div class="bracket-board is-split${pathClass} ${fallbackAvatar ? "has-center-bg" : ""}" id="bracket-board" style="--feeders:${feederCount};${artistBg}">
        <div class="bracket-wing bracket-wing-left">
          ${leftCols.join("")}
        </div>
        <div class="bracket-center${champ ? " is-hero" : ""}">
          <div class="bracket-round-label">决赛</div>
          <div class="bracket-match bracket-final${
            champ && (isSameSong(finalMatch.a, champ) || isSameSong(finalMatch.b, champ))
              ? " has-path"
              : ""
          }">
            ${bracketSlot(finalMatch.a, fallbackAvatar, {
              onPath: isSameSong(finalMatch.a, champ),
              roundIndex: finalIndex,
              wing: "center",
            })}
            ${bracketSlot(finalMatch.b, fallbackAvatar, {
              onPath: isSameSong(finalMatch.b, champ),
              roundIndex: finalIndex,
              wing: "center",
            })}
          </div>
          ${champHero}
        </div>
        <div class="bracket-wing bracket-wing-right">
          ${rightCols.join("")}
        </div>
      </div>
    </div>
  `;
}

/** Box relative to board, undoing CSS transform:scale on the board. */
function boxInBoard(el, board) {
  const er = el.getBoundingClientRect();
  const br = board.getBoundingClientRect();
  const sx = board.offsetWidth / Math.max(br.width, 1);
  const sy = board.offsetHeight / Math.max(br.height, 1);
  return {
    x: (er.left - br.left) * sx,
    y: (er.top - br.top) * sy,
    w: er.width * sx,
    h: er.height * sy,
  };
}

/** Draw glowing polyline chain along champion path slots. */
function drawChampionPathChain(board) {
  if (!board?.classList.contains("has-champ-path")) return;
  board.querySelector(".path-chain-svg")?.remove();

  const slots = [...board.querySelectorAll("[data-path-wing]")];
  if (slots.length < 2) return;

  const scored = slots.map((el) => {
    const round = Number(el.dataset.pathRound ?? -1);
    const wing = el.dataset.pathWing || "";
    const box = boxInBoard(el, board);
    return { el, round, wing, box };
  });
  scored.sort((a, b) => a.round - b.round || a.box.y - b.box.y);

  const W = board.offsetWidth;
  const H = board.offsetHeight;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "path-chain-svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("aria-hidden", "true");

  const defs = document.createElementNS(ns, "defs");
  defs.innerHTML = `
    <filter id="champ-path-glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="1.2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <linearGradient id="champ-path-grad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#c6e86a" stop-opacity="0.55"/>
      <stop offset="50%" stop-color="#b8ff1a" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#8fbf20" stop-opacity="0.55"/>
    </linearGradient>
  `;
  svg.appendChild(defs);

  const anchor = (item, towardNext) => {
    const { box, wing } = item;
    const cy = box.y + box.h / 2;
    if (wing === "left") {
      return towardNext ? { x: box.x + box.w, y: cy } : { x: box.x, y: cy };
    }
    if (wing === "right") {
      return towardNext ? { x: box.x, y: cy } : { x: box.x + box.w, y: cy };
    }
    // center / champ: connect from top/bottom or sides toward previous
    if (wing === "champ") {
      // connect into top-center of big cover
      const cover = item.el.querySelector?.(".champ-hero-cover-wrap") || item.el;
      const cb = cover === item.el ? item.box : boxInBoard(cover, board);
      return { x: cb.x + cb.w / 2, y: cb.y };
    }
    // final center slot → point toward champ (down) or previous (side)
    return towardNext
      ? { x: box.x + box.w / 2, y: box.y + box.h }
      : { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  };

  for (let i = 0; i < scored.length - 1; i++) {
    const a = scored[i];
    const b = scored[i + 1];
    const p1 = anchor(a, true);
    const p2 = anchor(b, false);

    // Adjust center→champ and feeder→final anchors
    let x1 = p1.x;
    let y1 = p1.y;
    let x2 = p2.x;
    let y2 = p2.y;

    if (a.wing === "left" && (b.wing === "center" || b.wing === "champ")) {
      x1 = a.box.x + a.box.w;
      y1 = a.box.y + a.box.h / 2;
      x2 = b.box.x;
      y2 = b.box.y + b.box.h / 2;
    } else if (a.wing === "right" && (b.wing === "center" || b.wing === "champ")) {
      x1 = a.box.x;
      y1 = a.box.y + a.box.h / 2;
      x2 = b.box.x + b.box.w;
      y2 = b.box.y + b.box.h / 2;
    } else if (a.wing === "center" && b.wing === "champ") {
      const cover = b.el.querySelector?.(".champ-hero-cover-wrap");
      const cb = cover ? boxInBoard(cover, board) : b.box;
      x1 = a.box.x + a.box.w / 2;
      y1 = a.box.y + a.box.h;
      x2 = cb.x + cb.w / 2;
      y2 = cb.y;
    } else if ((a.wing === "left" || a.wing === "right") && b.wing === "champ") {
      const cover = b.el.querySelector?.(".champ-hero-cover-wrap");
      const cb = cover ? boxInBoard(cover, board) : b.box;
      if (a.wing === "left") {
        x1 = a.box.x + a.box.w;
        y1 = a.box.y + a.box.h / 2;
        x2 = cb.x;
        y2 = cb.y + cb.h / 2;
      } else {
        x1 = a.box.x;
        y1 = a.box.y + a.box.h / 2;
        x2 = cb.x + cb.w;
        y2 = cb.y + cb.h / 2;
      }
    } else if (a.wing === "left" && b.wing === "left") {
      x1 = a.box.x + a.box.w;
      y1 = a.box.y + a.box.h / 2;
      x2 = b.box.x;
      y2 = b.box.y + b.box.h / 2;
    } else if (a.wing === "right" && b.wing === "right") {
      x1 = a.box.x;
      y1 = a.box.y + a.box.h / 2;
      x2 = b.box.x + b.box.w;
      y2 = b.box.y + b.box.h / 2;
    }

    const mx = (x1 + x2) / 2;
    const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${mx.toFixed(1)} ${y1.toFixed(1)} L ${mx.toFixed(1)} ${y2.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;

    const glow = document.createElementNS(ns, "path");
    glow.setAttribute("d", d);
    glow.setAttribute("class", "path-chain-glow");
    glow.setAttribute("fill", "none");
    svg.appendChild(glow);

    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", d);
    line.setAttribute("class", "path-chain-line");
    line.setAttribute("fill", "none");
    line.setAttribute("filter", "url(#champ-path-glow)");
    svg.appendChild(line);
  }

  board.appendChild(svg);
}

function fitBracketToScreen() {
  const fit = document.getElementById("bracket-fit");
  const board = document.getElementById("bracket-board");
  if (!fit || !board) return;

  board.style.transform = "none";

  // Use viewport-bounded width — board is width:max-content and must not inflate availW
  const parentW = fit.parentElement?.getBoundingClientRect().width || window.innerWidth;
  const availW = Math.min(fit.getBoundingClientRect().width || fit.clientWidth, parentW, window.innerWidth - 8);
  const availH = Math.min(
    fit.clientHeight || 0,
    Math.max(280, window.innerHeight - (window.innerWidth <= 720 ? 160 : 200))
  ) || Math.max(280, window.innerHeight - 200);
  const needW = Math.max(board.scrollWidth, 1);
  const needH = Math.max(board.scrollHeight, 1);
  const pad = window.innerWidth <= 720 ? 0.9 : 0.98;
  const scale = Math.min(availW / needW, availH / needH) * pad;

  board.style.transformOrigin = "center center";
  board.style.transform = `scale(${scale})`;
  requestAnimationFrame(() => drawChampionPathChain(board));
}

function renderBracketPreview(state) {
  const avatar = state.artistAvatar || "";
  const size = state.bracket.size;
  let cancelled = false;
  let timer = null;

  app.innerHTML = shell(
    `
    <section class="bracket-preview">
      <div class="bracket-preview-head">
        ${imgTag(avatar, { alt: state.artistName, className: "setup-avatar" })}
        <div class="bracket-preview-copy">
          <h1 class="bracket-title-fx"><span class="rapper-name">${esc(state.artistName)} · ${size} 强对阵图</span></h1>
        </div>
      </div>
      ${renderBracketHtml(state.bracket, avatar)}
      <div class="countdown-overlay" id="countdown-overlay" aria-live="polite">
        <div class="countdown-num" id="countdown-num">3</div>
      </div>
      <div class="setup-actions bracket-actions">
        <button type="button" class="ghost-btn" id="back-setup">返回调整签表</button>
      </div>
    </section>
  `,
    { back: `/artist/${state.artistId}`, wide: true }
  );
  bindBack();

  const cleanup = () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener("resize", runFit);
  };

  const runFit = () => fitBracketToScreen();
  requestAnimationFrame(() => {
    runFit();
    requestAnimationFrame(runFit);
  });
  const board = document.getElementById("bracket-board");
  board?.querySelectorAll("img").forEach((img) => {
    if (!img.complete) img.addEventListener("load", runFit, { once: true });
  });
  window.addEventListener("resize", runFit, { passive: true });

  document.getElementById("back-setup").addEventListener("click", () => {
    cleanup();
    clearState();
    navigate(`/artist/${state.artistId}`);
  });

  const steps = ["3", "2", "1", "GO"];
  let i = 0;
  const numEl = document.getElementById("countdown-num");
  const tick = () => {
    if (cancelled) return;
    if (i >= steps.length) {
      cleanup();
      navigate("/play");
      return;
    }
    if (numEl) {
      numEl.textContent = steps[i];
      numEl.classList.remove("pop");
      void numEl.offsetWidth;
      numEl.classList.add("pop");
    }
    i += 1;
    timer = setTimeout(tick, i === steps.length ? 480 : 820);
  };
  timer = setTimeout(tick, 350);
}

function renderMatch(state) {
  stopAllPageAudio();
  const match = currentMatch(state.bracket);
  if (!match) {
    if (state.bracket.champion) {
      navigate("/champ");
      return;
    }
    app.innerHTML = shell(`<p>赛程异常，请重新开赛。</p>`, { back: "/" });
    bindBack();
    return;
  }

  const label = roundLabel(state.bracket, match);
  const isBeef = state.cupType === "label-beef";
  const avatar = state.artistAvatar || "";
  const scoreSongs = isBeef
    ? songsAliveInBracket(state.bracket)
    : [];
  const scores = isBeef ? labelScoreFromSongs(scoreSongs, state.labels || []) : null;
  const la = state.labels?.[0];
  const lb = state.labels?.[1];
  const scoreA = la ? scores?.[la.id] || 0 : 0;
  const scoreB = lb ? scores?.[lb.id] || 0 : 0;
  const totalScore = Math.max(1, scoreA + scoreB);

  app.innerHTML = shell(
    `
    <section class="match-screen">
      <div class="match-meta">
        ${
          isBeef
            ? `<div class="beef-match-brand" aria-hidden="true">⚔</div>`
            : imgTag(avatar, { alt: state.artistName, className: "match-artist-avatar" })
        }
        <div>
          <strong>${esc(label)}</strong>
          <div class="match-meta-sub">
            <span>${esc(
              isBeef
                ? `${la?.name || "A"} vs ${lb?.name || "B"}`
                : state.artistName || ""
            )}</span>
            <span>进度 ${progressText(state.bracket)}</span>
          </div>
        </div>
      </div>
      ${
        isBeef && la && lb
          ? `<div class="beef-scorebar" aria-label="厂牌曲目存活">
              <div class="beef-scorebar-names">
                <span>${esc(la.name)} ${scoreA}</span>
                <span>${scoreB} ${esc(lb.name)}</span>
              </div>
              <div class="beef-scorebar-track">
                <i style="width:${(scoreA / totalScore) * 100}%"></i>
                <b style="width:${(scoreB / totalScore) * 100}%"></b>
              </div>
            </div>`
          : ""
      }
      <div class="vs-grid">
        ${pickButton("a", match.a, avatar)}
        <div class="vs-mark">VS</div>
        ${pickButton("b", match.b, avatar)}
      </div>
      <div id="player-mount" class="player-mount"></div>
    </section>
  `,
    {
      back: isBeef ? "/label-beef" : `/artist/${state.artistId}`,
    }
  );
  bindBack();

  const player = createPlayer(document.getElementById("player-mount"));
  let previewReq = 0;

  app.querySelectorAll("[data-preview]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const side = btn.dataset.preview;
      const raw = side === "a" ? match.a : match.b;
      const latest = loadState() || state;
      const req = ++previewReq;
      const song = await ensureSongPlaySource(latest, raw);
      if (req !== previewReq) return;
      player.load(song, {
        autoplay: true,
        artistName: song.rosterArtistName || latest.artistName || "",
        artistAliases: [latest.artistSearch, song.rosterArtistName].filter(Boolean),
      });
    });
  });

  app.querySelectorAll("[data-side]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // ignore clicks that bubbled from preview
      if (e.target.closest("[data-preview]")) return;
      previewReq += 1;
      player.stop();
      stopAllPageAudio();
      const roundIdx = findRoundIndex(state.bracket, match.id);
      const nextBracket = chooseWinner(state.bracket, match.id, btn.dataset.side);
      const next = { ...state, bracket: nextBracket };
      saveState(next);
      if (nextBracket.champion) {
        const champLabel = nextBracket.champion.labelName
          ? ` · ${nextBracket.champion.labelName}`
          : "";
        showRoundSplash(
          {
            title: "冠军诞生",
            sub: isBeef
              ? `${nextBracket.champion.title}${champLabel} 加冕厂牌混战之王`
              : `${nextBracket.champion.title} · ${state.artistName} 本命曲加冕`,
          },
          () => navigate("/champ")
        );
        return;
      }
      // 本轮全部打完 → 弹出下一轮环节动画（32→16、16→8…）
      if (roundIdx >= 0 && isRoundComplete(nextBracket, roundIdx)) {
        const splash = splashForBracket(nextBracket);
        if (splash) {
          showRoundSplash(splash, () => renderMatch(next));
          return;
        }
      }
      renderMatch(next);
    });
  });
}

function showRoundSplash({ title, sub }, onDone) {
  const existing = document.getElementById("round-splash");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "round-splash";
  el.className = "round-splash";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <div class="round-splash-bg" aria-hidden="true"></div>
    <div class="round-splash-card">
      <div class="round-splash-badge">黑怕巅峰对决</div>
      <h2 class="round-splash-title">${esc(title)}</h2>
      <p class="round-splash-sub">${esc(sub)}</p>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  let done = false;
  let auto = null;
  function finish() {
    if (done) return;
    done = true;
    if (auto) clearTimeout(auto);
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => {
      el.remove();
      onDone?.();
    }, 320);
  }

  el.addEventListener("click", finish);
  auto = setTimeout(finish, 2200);
}

function podiumCard(label, en, song, fallback) {
  if (!song) {
    return `
      <div class="podium-card is-empty">
        <div class="podium-label">${esc(label)} · ${esc(en)}</div>
        <div class="podium-title">—</div>
      </div>
    `;
  }
  return `
    <div class="podium-card">
      ${imgTag(coverUrl(song, fallback), { alt: song.title, className: "podium-cover" })}
      <div class="podium-copy">
        <div class="podium-label">${esc(label)} · ${esc(en)}</div>
        <div class="podium-title">${esc(song.title)}</div>
      </div>
    </div>
  `;
}

function openShareBracket(state) {
  const existing = document.getElementById("share-bracket");
  if (existing) existing.remove();

  const avatar = state.artistAvatar || "";
  const c = state.bracket.champion;
  const el = document.createElement("div");
  el.id = "share-bracket";
  el.className = "share-bracket";
  el.innerHTML = `
    <div class="share-bracket-panel">
      <header class="share-bracket-head">
        <div>
          <h2>${esc(state.artistName)} · ${state.bracket.size} 强对阵图</h2>
          <p class="share-bracket-champ-line">冠军 · <span class="share-bracket-champ-song">${esc(
            c?.title || ""
          )}</span></p>
        </div>
        <div class="share-bracket-actions">
          <button type="button" class="primary-btn" id="share-save-btn">保存图片</button>
          <button type="button" class="ghost-btn" id="share-close-btn">关闭</button>
        </div>
      </header>
      <div class="share-bracket-stage" id="share-bracket-capture">
        <div class="share-bracket-brand">黑怕巅峰对决</div>
        ${renderBracketHtml(state.bracket, avatar)}
        <div class="share-bracket-qr">
          <canvas id="share-qr-canvas" width="132" height="132" aria-label="网站二维码"></canvas>
          <div class="share-bracket-qr-copy">
            <div class="share-bracket-site">
              <span class="share-site-name" aria-label="heipaclub.com">
                <span class="share-site-heipa">HEIPA</span><span class="share-site-club">CLUB</span><span class="share-site-tld">.COM</span>
              </span>
              <span class="share-site-z" aria-hidden="true">z</span>
            </div>
            <em class="share-bracket-slogan">给你的本命 RapStar 办一场真正的说唱巅峰对决</em>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  const fitShare = () => {
    const fit = el.querySelector("#bracket-fit");
    const board = el.querySelector("#bracket-board");
    if (!fit || !board) return;
    board.style.transform = "none";
    const availW = fit.clientWidth;
    const availH = fit.clientHeight || Math.max(280, window.innerHeight * 0.62);
    const scale =
      Math.min(availW / Math.max(board.scrollWidth, 1), availH / Math.max(board.scrollHeight, 1)) * 0.96;
    board.style.transformOrigin = "center center";
    board.style.transform = `scale(${scale})`;
    requestAnimationFrame(() => drawChampionPathChain(board));
  };
  requestAnimationFrame(() => {
    el.classList.add("is-on");
    fitShare();
    requestAnimationFrame(fitShare);
  });
  const qrCanvas = el.querySelector("#share-qr-canvas");
  if (qrCanvas) {
    QRCode.toCanvas(qrCanvas, SITE_URL, {
      width: 132,
      margin: 1,
      color: { dark: "#111110", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).catch(() => {});
  }
  el.querySelectorAll("img").forEach((img) => {
    if (!img.complete) img.addEventListener("load", fitShare, { once: true });
  });
  window.addEventListener("resize", fitShare, { passive: true });

  const close = () => {
    window.removeEventListener("resize", fitShare);
    el.classList.remove("is-on");
    setTimeout(() => el.remove(), 280);
  };
  el.querySelector("#share-close-btn").addEventListener("click", close);
  el.addEventListener("click", (e) => {
    if (e.target === el) close();
  });

  el.querySelector("#share-save-btn").addEventListener("click", async () => {
    const btn = el.querySelector("#share-save-btn");
    btn.disabled = true;
    btn.textContent = "生成中…";
    try {
      await downloadShareCard(state);
      btn.textContent = "已保存";
    } catch {
      btn.textContent = "请直接截图";
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "保存图片";
    }, 1600);
  });
}

/** Draw a shareable PNG card — portrait bracket for mobile WeChat shares. */
async function downloadShareCard(state) {
  const { champion } = podiumFromBracket(state.bracket);
  const W = 1080;
  const H = 1920;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#eceae4");
  g.addColorStop(1, "#d2cec6");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#111110";
  ctx.font = "600 28px Noto Sans SC, sans-serif";
  ctx.fillText("黑怕巅峰对决", 64, 78);
  ctx.font = "400 30px Noto Sans SC, sans-serif";
  ctx.fillStyle = "#5c5a55";
  ctx.fillText(`${state.artistName} · 冠军诞生`, 64, 122);

  // champion banner (compact)
  ctx.fillStyle = "#b8ff1a";
  roundRect(ctx, 64, 150, W - 128, 200, 16);
  ctx.fill();
  ctx.fillStyle = "#111110";
  ctx.font = "700 36px Bebas Neue, sans-serif";
  ctx.fillText("CHAMPION", 96, 210);
  ctx.font = "700 56px Noto Sans SC, sans-serif";
  const champTitle = champion?.title || "";
  ctx.fillStyle = "#c9a227";
  ctx.fillText(champTitle.length > 12 ? `${champTitle.slice(0, 12)}…` : champTitle, 96, 280);
  ctx.font = "600 24px Noto Sans SC, sans-serif";
  ctx.fillStyle = "#a67c00";
  ctx.fillText(metaLine(champion) || state.artistName, 96, 320);

  ctx.fillStyle = "#111110";
  ctx.font = "700 28px Noto Sans SC, sans-serif";
  ctx.fillText("夺冠对阵图", 64, 400);
  ctx.fillStyle = "#5c5a55";
  ctx.font = "400 20px Noto Sans SC, sans-serif";
  ctx.fillText("8强 → 决赛（晋级高亮）", 64, 432);

  drawPortraitShareBracket(ctx, state.bracket, champion, 40, 460, W - 80, 1180);

  // QR → heipaclub.com
  const qrSize = 160;
  const qrDataUrl = await QRCode.toDataURL(SITE_URL, {
    width: qrSize,
    margin: 1,
    color: { dark: "#111110", light: "#ffffff" },
    errorCorrectionLevel: "M",
  });
  const qrImg = await loadImageFromUrl(qrDataUrl);
  const qrX = 64;
  const qrY = H - 230;
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 12);
  ctx.fill();
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

  ctx.fillStyle = "#111110";
  ctx.font = "italic 800 34px Bebas Neue, Noto Sans SC, sans-serif";
  const siteX = qrX + qrSize + 32;
  ctx.fillText("HEIPA", siteX, qrY + 48);
  const heipaW = ctx.measureText("HEIPA").width;
  const clubGrad = ctx.createLinearGradient(siteX + heipaW, 0, siteX + heipaW + 90, 0);
  clubGrad.addColorStop(0, "#5a7a12");
  clubGrad.addColorStop(0.55, "#7a9a1e");
  clubGrad.addColorStop(1, "#8aab28");
  ctx.fillStyle = clubGrad;
  ctx.fillText("CLUB", siteX + heipaW, qrY + 48);
  const clubW = ctx.measureText("CLUB").width;
  ctx.fillStyle = "#111110";
  ctx.fillText(".COM", siteX + heipaW + clubW, qrY + 48);
  const comW = ctx.measureText(".COM").width;
  ctx.fillStyle = "#5a6e22";
  ctx.font = "italic 700 16px Bebas Neue, Noto Sans SC, sans-serif";
  ctx.fillText("z", siteX + heipaW + clubW + comW + 4, qrY + 42);

  ctx.fillStyle = "#5c5a55";
  ctx.font = "400 20px Noto Sans SC, sans-serif";
  const slogan = "给你的本命 RapStar 办一场真正的说唱巅峰对决";
  const sloganMax = W - siteX - 48;
  // wrap slogan to 2 lines if needed
  if (ctx.measureText(slogan).width <= sloganMax) {
    ctx.fillText(slogan, siteX, qrY + 92);
  } else {
    const mid = Math.floor(slogan.length / 2);
    let split = slogan.lastIndexOf(" ", mid);
    if (split < 8) split = mid;
    ctx.fillText(slogan.slice(0, split).trim(), siteX, qrY + 86);
    ctx.fillText(slogan.slice(split).trim(), siteX, qrY + 114);
  }

  ctx.fillStyle = "#5c5a55";
  ctx.font = "400 20px Noto Sans SC, sans-serif";
  ctx.fillText(`${state.bracket.size} 强 · ${progressText(state.bracket)}`, 64, H - 36);

  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    } catch (err) {
      reject(err);
    }
  });

  const fileName = `${state.artistName}-本命曲对阵图.png`;
  if (navigator.share && navigator.canShare) {
    const file = new File([blob], fileName, { type: "image/png" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: `${state.artistName} 本命曲对阵图`,
          text: `冠军：${champion?.title || ""} · 扫码玩 heipaclub.com`,
        });
        return;
      } catch {
        /* fall through */
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Mobile-first portrait bracket: from ≤8强 to 决赛, left | center | right
 * (same structure as on-site 对阵图, text chips — no remote art / CORS).
 */
function drawPortraitShareBracket(ctx, bracket, champ, x, y, w, h) {
  const rounds = bracket?.rounds || [];
  if (!rounds.length) return;
  const size = bracket.size || 32;

  let startRi = 0;
  for (let ri = 0; ri < rounds.length; ri++) {
    if (size / 2 ** ri <= 8) {
      startRi = ri;
      break;
    }
  }

  const feederRis = [];
  for (let ri = startRi; ri < rounds.length - 1; ri++) feederRis.push(ri);
  const finalRi = rounds.length - 1;
  const leftCols = feederRis.length;
  const colCount = Math.max(1, leftCols * 2 + 1);
  const colW = w / colCount;
  const pad = 6;
  const chipW = Math.max(100, colW - pad * 2);
  const chipH = 40;
  const matchH = chipH * 2 + 8;

  /** @type {{ id: string, col: number, mx: number, my: number, m: object }[]} */
  const placed = [];

  function planColumn(matches, colIndex, label) {
    const colX = x + colIndex * colW + (colW - chipW) / 2;
    ctx.fillStyle = "#5c5a55";
    ctx.font = "700 18px Noto Sans SC, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, colX + chipW / 2, y + 22);
    ctx.textAlign = "left";

    const n = Math.max(matches.length, 1);
    const usable = h - 52;
    const step = usable / n;
    matches.forEach((m, i) => {
      const my = y + 44 + i * step + (step - matchH) / 2;
      placed.push({ id: m.id, col: colIndex, mx: colX, my, m });
    });
  }

  feederRis.forEach((ri, ci) => {
    const round = rounds[ri] || [];
    const mid = Math.ceil(round.length / 2);
    planColumn(round.slice(0, mid), ci, shortRoundLabel(size, ri));
  });

  const finalMatch = rounds[finalRi]?.[0];
  if (finalMatch) {
    planColumn([finalMatch], leftCols, shortRoundLabel(size, finalRi));
  }

  feederRis.forEach((ri, ci) => {
    const round = rounds[ri] || [];
    const mid = Math.ceil(round.length / 2);
    planColumn(round.slice(mid), colCount - 1 - ci, shortRoundLabel(size, ri));
  });

  const byId = new Map(placed.map((p) => [p.id, p]));

  // lines under chips
  for (let ri = startRi; ri < finalRi; ri++) {
    for (const parent of rounds[ri + 1] || []) {
      if (!parent?.from) continue;
      const p = byId.get(parent.id);
      if (!p) continue;
      const pCx = p.mx + chipW / 2;
      const pCy = p.my + matchH / 2;
      for (const fromId of parent.from) {
        const c = byId.get(fromId);
        if (!c) continue;
        const fromMatch = (rounds[ri] || []).find((mm) => mm.id === fromId);
        const onPath = Boolean(
          champ && fromMatch?.winner && isSameSong(fromMatch.winner, champ)
        );
        ctx.strokeStyle = onPath ? "rgba(120, 160, 20, 0.9)" : "rgba(17,17,16,0.18)";
        ctx.lineWidth = onPath ? 3 : 1.5;
        ctx.beginPath();
        const cCx = c.mx + chipW / 2;
        const cCy = c.my + matchH / 2;
        const midX = (cCx + pCx) / 2;
        ctx.moveTo(cCx, cCy);
        ctx.bezierCurveTo(midX, cCy, midX, pCy, pCx, pCy);
        ctx.stroke();
      }
    }
  }

  for (const p of placed) {
    drawShareMatchChips(ctx, p.m, champ, p.mx, p.my, chipW, chipH);
  }
}

function drawShareMatchChips(ctx, m, champ, x, y, w, chipH) {
  drawShareSongChip(ctx, m?.a, champ, x, y, w, chipH);
  drawShareSongChip(ctx, m?.b, champ, x, y + chipH + 6, w, chipH);
}

function drawShareSongChip(ctx, song, champ, x, y, w, h) {
  const onPath = Boolean(song && champ && isSameSong(song, champ));
  ctx.fillStyle = onPath ? "#b8ff1a" : "rgba(255,255,255,0.92)";
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  if (onPath) {
    ctx.strokeStyle = "#111110";
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, w, h, 8);
    ctx.stroke();
  }
  ctx.fillStyle = "#111110";
  ctx.font = `${onPath ? "700" : "500"} 16px Noto Sans SC, sans-serif`;
  const title = song?.title || "—";
  ctx.fillText(clipCanvasText(ctx, title, w - 16), x + 8, y + h / 2 + 5);
}

function clipCanvasText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = String(text);
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("qr image load failed"));
    img.src = url;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function pickButton(side, song, fallback) {
  const labelBadge = song?.labelName
    ? `<span class="pick-label-badge">${esc(song.labelName)}</span>`
    : "";
  const artistLine = song?.rosterArtistName || song?.artist || "";
  return `
    <div class="pick-wrap">
      <button type="button" class="pick" data-side="${side}">
        ${imgTag(coverUrl(song, fallback), { alt: song.title, className: "pick-cover" })}
        <div class="pick-copy">
          <div class="side">TRACK ${side.toUpperCase()}${labelBadge}</div>
          <h2 class="title">${esc(song.title)}</h2>
          <p class="album">${esc(artistLine)}${artistLine && metaLine(song) ? " · " : ""}${esc(
            metaLine(song) || ""
          )}</p>
          <span class="cta">选这首晋级</span>
        </div>
      </button>
      <button type="button" class="preview-btn" data-preview="${side}">试听</button>
    </div>
  `;
}

function renderChamp(state) {
  const c = state.bracket.champion;
  const avatar = state.artistAvatar || "";
  const { runnerUp, semis } = podiumFromBracket(state.bracket);

  app.innerHTML = shell(
    `
    <section class="champ champ-cup">
      <div class="champ-cup-stage">
        <p class="champ-cup-artist"><span class="rapper-name">${esc(
          state.cupType === "label-beef"
            ? `${state.labels?.[0]?.name || ""} vs ${state.labels?.[1]?.name || ""}`
            : state.artistName || ""
        )}</span></p>
        <p class="champ-cup-born">冠军诞生</p>
        <p class="champ-cup-brand">黑怕巅峰对决</p>
        <p class="champ-cup-champion-word">C H A M P I O N</p>
        <div class="champ-cup-cover-wrap">
          ${imgTag(coverUrl(c, avatar), { alt: c.title, className: "champ-cup-cover" })}
        </div>
        <h1 class="champ-cup-title">${esc(c.title)}</h1>
        <p class="champ-cup-meta">${esc(metaLine(c))}</p>
      </div>

      <div class="podium-row">
        ${podiumCard("亚军", "RUNNER-UP", runnerUp, avatar)}
        ${podiumCard("四强", "SEMI", semis[0], avatar)}
        ${podiumCard("四强", "SEMI", semis[1], avatar)}
      </div>

      <div id="player-mount" class="player-mount champ-player"></div>

      <div class="champ-cup-actions">
        <button type="button" class="primary-btn share-bracket-btn" id="share-bracket-btn">分享我的对阵图</button>
        <div class="champ-cup-secondary">
          <button type="button" class="ghost-btn" id="again-same">再来一场</button>
          <button type="button" class="ghost-btn" id="again-home">${
            state.cupType === "label-beef" ? "换个厂牌" : "换个歌手"
          }</button>
        </div>
      </div>
    </section>
  `,
    {
      back: "/",
      actions: `<a class="ghost-btn rank-link" href="#/rank">排行榜</a>`,
    }
  );
  bindBack();

  const player = createPlayer(document.getElementById("player-mount"));
  player.load(c, { autoplay: false });
  document.getElementById("cup-player").hidden = false;

  // still report wins silently
  reportChampionWin({
    song: c,
    artistId: state.neteaseArtistId,
    artistName: state.artistName,
    artistAvatar: avatar,
  }).catch(() => {});

  document.getElementById("share-bracket-btn").addEventListener("click", () => openShareBracket(state));
  document.getElementById("again-same").addEventListener("click", () => {
    clearState();
    if (state.cupType === "label-beef") navigate("/label-beef");
    else navigate(`/artist/${state.artistId}`);
  });
  document.getElementById("again-home").addEventListener("click", () => {
    clearState();
    navigate("/");
  });
}

async function renderRank(tab = "songs") {
  let region = "cn"; // 中文 | 欧美
  app.innerHTML = shell(
    `<section class="rank-page"><p class="loading-line">加载排行榜…</p></section>`,
    { back: "/" }
  );
  bindBack();

  const tabHref = (t) =>
    t === "artists" ? "/rank/artists" : t === "labels" ? "/rank/labels" : "/rank";

  const paint = async (active, q = "") => {
    const showRegion = active === "songs" || active === "artists";
    app.innerHTML = shell(
      `
      <section class="rank-page">
        <div class="rank-head">
          <h1>排行榜</h1>
          <p class="rank-sub" id="rank-sub"></p>
        </div>
        <div class="rank-tabs" role="tablist" aria-label="排行榜类型">
          <button type="button" class="mode-chip ${active === "songs" ? "active" : ""}" data-rank-tab="songs">歌曲</button>
          <button type="button" class="mode-chip ${active === "artists" ? "active" : ""}" data-rank-tab="artists">歌手</button>
          <button type="button" class="mode-chip ${active === "labels" ? "active" : ""}" data-rank-tab="labels">厂牌</button>
        </div>
        ${
          showRegion
            ? `<div class="filter-row sort-row rank-region-row" id="rank-region-row" role="group" aria-label="地区榜">
          <button type="button" class="mode-chip ${region === "cn" ? "active" : ""}" data-rank-region="cn">中文</button>
          <button type="button" class="mode-chip ${region === "west" ? "active" : ""}" data-rank-region="west">欧美</button>
        </div>`
            : ""
        }
        <div class="search-row">
          <input id="rank-search" type="search" placeholder="${
            active === "songs"
              ? "搜索歌曲…"
              : active === "artists"
                ? "搜索歌手…"
                : "搜索厂牌…"
          }" value="${esc(q)}" autocomplete="off" />
        </div>
        <div id="rank-list" class="rank-list"><p class="loading-line">加载中…</p></div>
        <div id="player-mount" class="player-mount"></div>
      </section>
    `,
      { back: "/" }
    );
    bindBack();

    const player = createPlayer(document.getElementById("player-mount"));
    let timer = null;
    const input = document.getElementById("rank-search");

    const loadList = async (query) => {
      const box = document.getElementById("rank-list");
      if (!box) return;
      box.innerHTML = `<p class="loading-line">加载中…</p>`;
      try {
        let items = [];
        let updatedAt = null;
        if (active === "labels") {
          const data = await fetchArtistRank({ limit: 200, q: "" });
          updatedAt = data.updatedAt;
          items = filterLabelRank(buildLabelRank(data.items || []), query);
        } else if (active === "songs") {
          const data = await fetchSongRank({ limit: 200, q: query });
          updatedAt = data.updatedAt;
          items = filterRankItemsByRegion(data.items || [], region, "songs");
        } else {
          const data = await fetchArtistRank({ limit: 200, q: query });
          updatedAt = data.updatedAt;
          items = filterRankItemsByRegion(data.items || [], region, "artists");
        }

        const sub = document.getElementById("rank-sub");
        if (sub) {
          const board =
            active === "labels"
              ? "厂牌榜"
              : `${region === "west" ? "欧美" : "中文"}${active === "songs" ? "单曲" : "歌手"}榜`;
          sub.textContent = updatedAt
            ? `${board} · ${String(updatedAt).slice(0, 10)}`
            : board;
        }

        if (!items.length) {
          box.innerHTML = `<p class="loading-line">暂无数据</p>`;
          return;
        }

        box.innerHTML = items
          .map((item, i) => {
            const rank = i + 1;
            const rankClass = rank <= 3 ? `top${rank}` : "";
            if (active === "songs") {
              return `
                <article class="rank-row">
                  <div class="rank-num ${rankClass}">${rank}</div>
                  ${imgTag(item.cover, { alt: item.title, className: "rank-cover" })}
                  <div class="rank-meta">
                    <div class="rank-title">${esc(item.title)}</div>
                    <div class="rank-desc">${esc(item.artist)} · 单曲夺冠 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次</div>
                  </div>
                  <button type="button" class="rank-play" data-song-id="${esc(item.songId)}" data-title="${esc(item.title)}" data-artist="${esc(item.artist)}" data-cover="${esc(item.cover || "")}" aria-label="试听">▶</button>
                </article>`;
            }
            if (active === "labels") {
              return `
                <article class="rank-row">
                  <div class="rank-num ${rankClass}">${rank}</div>
                  ${imgTag(item.avatar, { alt: item.name, className: "rank-cover round" })}
                  <div class="rank-meta">
                    <div class="rank-title">${esc(item.name)}</div>
                    <div class="rank-desc">${esc(item.city || "厂牌")} · ${item.members} 人 · 成员夺冠累计 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次</div>
                  </div>
                </article>`;
            }
            return `
              <article class="rank-row">
                <div class="rank-num ${rankClass}">${rank}</div>
                ${imgTag(item.avatar || item.cover, { alt: item.name, className: "rank-cover round" })}
                <div class="rank-meta">
                  <div class="rank-title">${esc(item.name)}</div>
                  <div class="rank-desc">单曲夺冠 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次</div>
                </div>
              </article>`;
          })
          .join("");

        box.querySelectorAll("[data-song-id]").forEach((btn) => {
          btn.addEventListener("click", () => {
            player.load(
              {
                title: btn.dataset.title,
                artist: btn.dataset.artist,
                cover: btn.dataset.cover,
                neteaseId: btn.dataset.songId,
              },
              { autoplay: true }
            );
          });
        });
      } catch (e) {
        box.innerHTML = `<p class="loading-line">排行榜加载失败</p>`;
      }
    };

    document.querySelectorAll("[data-rank-tab]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const next = chip.dataset.rankTab;
        navigate(tabHref(next));
      });
    });

    document.querySelectorAll("[data-rank-region]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const next = chip.dataset.rankRegion === "west" ? "west" : "cn";
        if (next === region) return;
        region = next;
        paint(active, input?.value?.trim() || "");
      });
    });

    input?.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => loadList(input.value.trim()), 220);
    });

    await loadList(q);
  };

  await paint(tab);
}

function metaLine(song) {
  if (!song) return "";
  const album = song.album || song.collection || "";
  let year = song.year || "";
  if (!year && song.publishTime) {
    const y = new Date(Number(song.publishTime)).getFullYear();
    if (y && !Number.isNaN(y)) year = String(y);
  }
  return [album, year].filter(Boolean).join(" · ") || album || "单曲";
}

function uniquePath(path, champion) {
  const seen = new Set();
  const out = [];
  for (const s of path) {
    if (!s?.title || seen.has(s.id || s.title)) continue;
    seen.add(s.id || s.title);
    out.push(s);
  }
  if (champion && !seen.has(champion.id || champion.title)) out.push(champion);
  return out;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
