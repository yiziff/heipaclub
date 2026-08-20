import "./style.css";
import {
  ARTISTS,
  getArtist,
} from "./data/artists.js";
import { HIPHOP_LABELS, artistsInLabel, getLabel, labelLeader } from "./data/labels.js";
import {
  BEEF_GROUP_COUNT,
  BEEF_PICKS_PER_GROUP,
  BEEF_SONGS_PER_LABEL,
  beefProgressText,
  beefRevivalTarget,
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
import {
  bindImageFallback,
  coverUrl,
  IMAGE_SIZES,
  imgTag,
  optimizedImageUrl,
  sizedCoverUrl,
} from "./artwork.js";
import {
  ARTIST_PK_COUNT,
  artistsToPkSongs,
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
import { expandArtistPool, loadArtistCup, pingApi, searchArtist as searchNeteaseArtist } from "./netease.js";
import {
  enrichSongsPlaySourceProgressive,
  loadArtistCup as loadItunesArtistCup,
  pingApi as pingItunesApi,
  resolvePlaySource,
  searchArtist as searchItunesArtist,
} from "./itunes.js";
import { hasHotTopPack, loadHotTopPack } from "./hot-tops.js";
import { fetchArtistTopCache, putArtistTopCache } from "./artist-top-cache.js";
import { initPerfVitalsTracking, trackEvent } from "./metrics.js";
import { createPlayer, stopAllPageAudio } from "./player.js";
import {
  fetchArtistRank,
  fetchArtistPkRank,
  fetchDuelKingRank,
  fetchDuelKingSongs,
  fetchHangLaRank,
  fetchLabelBeefMatchups,
  fetchLabelBeefRank,
  fetchRankMeta,
  fetchSongRank,
  markMilestoneShown,
  reportChampionWin,
  reportHangLaRound,
} from "./rank-api.js";
import {
  filterLabelRank,
  filterRankItemsByQuery,
  filterRankItemsByRegion,
  mergeLabelBeefRank,
} from "./rank-filter.js";
import {
  buildBracket,
  buildField,
  chooseWinner,
  currentMatch,
  findRoundIndex,
  isRoundComplete,
  nearestFieldSize,
  pickSongs,
  podiumFromBracket,
  progressText,
  roundLabel,
  splashForBracket,
} from "./tournament.js";
import {
  DUEL_SONGS_PER_SIDE,
  buildDuelBracket,
  duelAliveScores,
  emptyDuelState,
  rebalanceRoundForAb,
  songKey as duelSongKey,
  tagDuelSong,
} from "./duel-king.js";

const STORAGE_KEY = "cn-rap-cup:v5";
const TOP_N = 50;
const FIELD_MAX = 32;
const SITE_URL = "https://heipaclub.com";
const CHAMP_DONATE_QR_SRC = "/champ-donate-qr.png";
const CHAMP_DONATE_TIP_KEY = "heipa:champ-donate-tip-day";
const CHAMP_DONATE_TIP_DELAY_MS = 1400;
const SHARE_CTA_LABEL = "分享对阵图";
let champDonateTipTimer = null;
const app = document.getElementById("app");
const artistCache = new Map();
const runtimeArtistCatalog = new Map();
const avatarFillInFlight = new Set();
const preloadedImageHrefs = new Set();
let shareCardModulePromise = null;
let qrCodeModulePromise = null;

function normArtistKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·．._\-#（）()]/g, "");
}

/** iTunes 搜索命中 → 运行时歌手（可 hydrate / 办赛） */
function toRuntimeItunesArtist(hit) {
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
}

/** 本地名单优先，再并入 iTunes 搜索结果（去重按名）。 */
async function mergeLocalArtistsWithItunes(query, localList) {
  const q = String(query || "").trim();
  if (!q) return localList;
  try {
    const hits = await searchItunesArtist(q, { limit: 8, countries: ["cn", "us"] });
    if (!hits.length) return localList;
    const seen = new Set(localList.map((a) => normArtistKey(a.name || a.search)));
    const extra = [];
    for (const hit of hits) {
      const key = normArtistKey(hit.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      extra.push(toRuntimeItunesArtist(hit));
    }
    return [...localList, ...extra];
  } catch {
    return localList;
  }
}

function resolveRosterArtist(id) {
  return (
    getArtist(id) ||
    runtimeArtistCatalog.get(id) ||
    ARTISTS.find((a) => a.id === id) ||
    null
  );
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 支持者数据 — 核对微信赞赏留言后手动更新
 *
 * sponsorTicker: ¥30+ 首页滚动冠名（until 到期日后删除）
 * permanent:     ¥20+ 永久墙（共建档 / 冠名档），no 为第几位支持者，date 为赞赏日期
 * weekly:        ¥5  本周墙（7 天后手动移除），date 为赞赏日期
 */
const SUPPORTERS = {
  sponsorTicker: [
    { name: "匿名者", amount: "¥20", until: "2026-08-20" },
    { name: "Chos1npm", amount: "¥20", until: "2026-08-21" },
  ],
  permanent: [
    { no: 1, name: "coolbreeze", message: "nb", amount: "¥20", date: "2026-08-12" },
    { no: 2, name: "匿名者", message: "Work out well", amount: "¥20", date: "2026-08-13" },
    { no: 3, name: "Chos1npm", message: "加油 bro", amount: "¥20", date: "2026-08-14" },
  ],
  weekly: [
    { name: "擦绒", message: "", amount: "¥5", date: "2026-08-04" },
    { name: "沐屿白", message: "Hiphop forever", amount: "¥5", date: "2026-08-13" },
    {
      name: "乌昂乐艾",
      message: "做的很好，但是好像没有topbarry，希望加一下（其实是有的哈哈哈）",
      amount: "¥5",
      date: "2026-08-13",
    },
    { name: "Kimi、", message: "", amount: "¥5", date: "2026-08-13" },
    { name: "恋", message: "好玩", amount: "¥5", date: "2026-08-13" },
    { name: "侧柏叶", message: "", amount: "¥5", date: "2026-08-14" },
    { name: "ReginFi", message: "资金有限只能支持到这了💜", amount: "¥5", date: "2026-08-14" },
    { name: "1", message: "加油", amount: "¥5", date: "2026-08-15" },
    { name: "兔本兔", message: "", amount: "¥5", date: "2026-08-15" },
    { name: "这是名字", message: "do it better 👍", amount: "¥5", date: "2026-08-17" },
  ],
};

function supporterNoLabel(no) {
  const n = Number(no);
  if (n === 1) return "🥇 第 1 位支持者";
  if (n === 2) return "🥈 第 2 位支持者";
  if (n === 3) return "🥉 第 3 位支持者";
  if (Number.isFinite(n) && n > 0) return `第 ${n} 位支持者`;
  return "";
}

function activeSponsorTickers() {
  const today = new Date().toISOString().slice(0, 10);
  return (SUPPORTERS.sponsorTicker || []).filter(
    (s) => s?.name && (!s.until || String(s.until) >= today)
  );
}

function getDonateTickerText() {
  return "大家可以点击支持运营，扫码 ¥5 / ¥20 / ¥30 支持网站持续运行 · 奶茶档留名一周 · 共建档永久上墙 · 冠名档首页致谢一周！！！";
}

function champDonateTipDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hasDismissedChampDonateTipToday() {
  try {
    return localStorage.getItem(CHAMP_DONATE_TIP_KEY) === champDonateTipDayKey();
  } catch (_) {
    return false;
  }
}

function markChampDonateTipDismissedToday() {
  try {
    localStorage.setItem(CHAMP_DONATE_TIP_KEY, champDonateTipDayKey());
  } catch (_) {}
}

function closeChampDonateTip() {
  if (champDonateTipTimer) {
    clearTimeout(champDonateTipTimer);
    champDonateTipTimer = null;
  }
  const tip = document.getElementById("champ-donate-tip");
  if (!tip) return;
  tip.classList.remove("is-on");
  setTimeout(() => tip.remove(), 220);
}

function showChampDonateTip() {
  if (document.getElementById("champ-donate-tip")) return;
  if (!document.querySelector(".champ.champ-cup")) return;

  const tip = document.createElement("div");
  tip.id = "champ-donate-tip";
  tip.className = "champ-donate-tip";
  tip.innerHTML = `
    <div class="champ-donate-tip-backdrop" data-champ-donate-close></div>
    <div class="champ-donate-tip-card" role="dialog" aria-modal="true" aria-labelledby="champ-donate-tip-title">
      <header class="champ-donate-tip-head">
        <h3 id="champ-donate-tip-title">👊 Respect！给服务器加点油</h3>
        <button type="button" class="champ-donate-tip-close" data-champ-donate-close aria-label="关闭">×</button>
      </header>
      <p class="champ-donate-tip-copy">为了给家人们做个好玩的说唱专属小游戏，本站的所有开销都是我自掏腰包，纯靠“为爱发电”。现在流量越来越大，服务器急需升级才能保证大家顺畅访问。如果你玩得开心，欢迎赞助一瓶水钱，帮助网站持续运营下去，感谢支持！</p>
      <p class="champ-donate-tip-perk">🔥 福利放送：扫码赞助后有<button type="button" class="champ-donate-tip-perk-link" data-champ-open-support>特殊福利</button>哦</p>
      <figure class="champ-donate-tip-qr">
        <img src="${CHAMP_DONATE_QR_SRC}" alt="微信赞赏码" width="132" height="132" decoding="async" />
      </figure>
      <p class="champ-donate-tip-hint">微信扫一扫</p>
      <button type="button" class="champ-donate-tip-dismiss" data-champ-donate-close>先看看冠军</button>
    </div>
  `;
  document.body.appendChild(tip);

  const dismiss = () => {
    markChampDonateTipDismissedToday();
    closeChampDonateTip();
  };
  tip.querySelectorAll("[data-champ-donate-close]").forEach((node) => {
    node.addEventListener("click", dismiss);
  });
  tip.querySelector("[data-champ-open-support]")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    markChampDonateTipDismissedToday();
    closeChampDonateTip();
    openSupportSite({ scrollToPerks: true });
  });
  requestAnimationFrame(() => tip.classList.add("is-on"));
}

function maybeShowChampDonateTip() {
  closeChampDonateTip();
  if (hasDismissedChampDonateTipToday()) return;
  champDonateTipTimer = setTimeout(() => {
    champDonateTipTimer = null;
    showChampDonateTip();
  }, CHAMP_DONATE_TIP_DELAY_MS);
}

function getSponsorTickerText() {
  const sponsors = activeSponsorTickers();
  if (!sponsors.length) return "";
  return sponsors
    .map((s) => {
      const amt = s.amount ? `（${s.amount}）` : "";
      return `感谢 @${s.name}${amt} 支持本站运营 ♥`;
    })
    .join("　　");
}

function renderSponsorTickerHtml() {
  const text = getSponsorTickerText();
  if (!text) return "";
  const safe = esc(text);
  return `
    <div class="sponsor-ticker" role="marquee" aria-label="支持者致谢">
      <span class="sponsor-ticker-track">
        <span class="sponsor-ticker-text">${safe}</span>
        <span class="sponsor-ticker-text" aria-hidden="true">${safe}</span>
      </span>
    </div>`;
}

function renderSupporterCard(s, { showNo = false, showAmount = false } = {}) {
  const rank = showNo && s.no ? supporterNoLabel(s.no) : "";
  const msg = String(s.message || "").trim();
  return `<li class="about-site-supporter-card">
    ${rank ? `<div class="about-site-supporter-rank">${esc(rank)}</div>` : ""}
    <div class="about-site-supporter-card-head">
      <span class="about-site-supporter-name">${esc(s.name)}</span>
      ${showAmount && s.amount ? `<span class="about-site-supporter-amt">${esc(s.amount)}</span>` : ""}
    </div>
    ${msg ? `<p class="about-site-supporter-msg">「${esc(msg)}」</p>` : ""}
  </li>`;
}

function renderSupportersWallHtml({ showAmount = false } = {}) {
  const permanent = SUPPORTERS.permanent || [];
  const weekly = SUPPORTERS.weekly || [];
  const empty =
    !permanent.length && !weekly.length
      ? `<p class="about-site-supporters-empty">暂无上榜 · 扫码赞赏，留言格式：你的昵称和想说的一段话！</p>`
      : "";

  const permanentBlock = permanent.length
    ? `<div class="about-site-supporters-block">
        <h3 class="about-site-supporters-subtitle">永久支持者</h3>
        <ul class="about-site-supporters-cards">${permanent
          .map((s) => renderSupporterCard(s, { showNo: true, showAmount }))
          .join("")}</ul>
      </div>`
    : "";

  const weeklyBlock = weekly.length
    ? `<div class="about-site-supporters-block">
        <h3 class="about-site-supporters-subtitle">本周支持者</h3>
        <ul class="about-site-supporters-cards">${weekly
          .map((s) => renderSupporterCard(s, { showAmount }))
          .join("")}</ul>
      </div>`
    : "";

  return empty || `${permanentBlock}${weeklyBlock}`;
}

function parseDonateAmount(amount) {
  const n = parseFloat(String(amount ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function getAllSupporters() {
  const permanent = (SUPPORTERS.permanent || []).map((s) => ({ ...s, tier: "permanent" }));
  const weekly = (SUPPORTERS.weekly || []).map((s) => ({ ...s, tier: "weekly" }));
  return [...permanent, ...weekly];
}

function sortSupporters(list, mode = "amount") {
  const copy = [...list];
  if (mode === "time") {
    return copy.sort((a, b) => {
      const da = String(a.date || "");
      const db = String(b.date || "");
      if (da && db) return db.localeCompare(da);
      if (db) return 1;
      if (da) return -1;
      return (a.no || 999) - (b.no || 999);
    });
  }
  return copy.sort((a, b) => {
    const diff = parseDonateAmount(b.amount) - parseDonateAmount(a.amount);
    if (diff !== 0) return diff;
    return (a.no || 999) - (b.no || 999);
  });
}

function getTopSupporters(n = 5) {
  return sortSupporters(getAllSupporters(), "amount").slice(0, n);
}

function homeDonateWallRankLabel(index) {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return String(index + 1);
}

function renderHomeDonateWallItemsHtml(list) {
  return list
    .map(
      (s, i) => `<li class="home-donate-wall-item">
      <span class="home-donate-wall-rank" aria-hidden="true">${homeDonateWallRankLabel(i)}</span>
      <span class="home-donate-wall-name">${esc(s.name)}</span>
      <span class="home-donate-wall-amt">${esc(s.amount || "")}</span>
    </li>`
    )
    .join("");
}

function renderHomeDonateWallHtml() {
  const allCount = getAllSupporters().length;
  const top5 = getTopSupporters(5);
  const hasSupporters = top5.length > 0;
  const canExpand = allCount > 5;
  const listHtml = hasSupporters
    ? renderHomeDonateWallItemsHtml(top5)
    : `<li class="home-donate-wall-empty">
      <button type="button" class="home-donate-wall-placeholder" data-home-donate-placeholder>期待你的名字 · 扫码支持</button>
    </li>`;

  return `
    <aside class="home-donate-wall" aria-label="赞赏墙" data-home-donate-wall>
      <div class="home-donate-wall-head">
        <span class="home-donate-wall-title">赞赏墙</span>
        ${
          canExpand
            ? `<button type="button" class="home-donate-wall-expand" data-toggle-donate-wall>展开</button>`
            : ""
        }
      </div>
      <ol class="home-donate-wall-list" data-home-donate-list>${listHtml}</ol>
    </aside>`;
}

function renderDonateWallModalListHtml(sortMode = "amount") {
  const sorted = sortSupporters(getAllSupporters(), sortMode);
  if (!sorted.length) {
    return `<p class="donate-wall-modal-empty">暂无上榜 · 扫码赞赏，留言格式：你的昵称和想说的一段话！</p>`;
  }
  return `<ol class="donate-wall-modal-list">${sorted
    .map((s, i) => {
      const msg = String(s.message || "").trim();
      const tierLabel = s.tier === "permanent" ? "永久" : "本周";
      return `<li class="donate-wall-modal-item">
      <div class="donate-wall-modal-item-head">
        <span class="donate-wall-modal-rank">${i + 1}</span>
        <span class="donate-wall-modal-name">${esc(s.name)}</span>
        <span class="donate-wall-modal-tier">${tierLabel}</span>
        ${s.amount ? `<span class="donate-wall-modal-amt">${esc(s.amount)}</span>` : ""}
      </div>
      ${msg ? `<p class="donate-wall-modal-msg">「${esc(msg)}」</p>` : ""}
    </li>`;
    })
    .join("")}</ol>`;
}

function openDonateWallModal() {
  const existing = document.getElementById("donate-wall-modal");
  if (existing) existing.remove();

  let sortMode = "amount";
  const el = document.createElement("div");
  el.id = "donate-wall-modal";
  el.className = "donate-wall-modal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "donate-wall-modal-title");
  el.innerHTML = `
    <div class="donate-wall-modal-backdrop" data-donate-wall-close></div>
    <div class="donate-wall-modal-panel">
      <header class="donate-wall-modal-head">
        <h2 id="donate-wall-modal-title">支持者留言墙</h2>
        <button type="button" class="donate-wall-modal-close" data-donate-wall-close aria-label="关闭">×</button>
      </header>
      <div class="donate-wall-modal-sort" role="group" aria-label="排序方式">
        <button type="button" class="donate-wall-sort-chip active" data-donate-wall-sort="amount">按金额</button>
        <button type="button" class="donate-wall-sort-chip" data-donate-wall-sort="time">按时间</button>
      </div>
      <div class="donate-wall-modal-body">
        <div class="donate-wall-modal-body-list"></div>
        <p class="donate-wall-modal-note">名单由作者根据赞赏留言手动更新</p>
      </div>
      <div class="donate-wall-modal-actions">
        <button type="button" class="donate-wall-modal-support" data-donate-wall-support>我也要支持</button>
        <button type="button" class="donate-wall-modal-done" data-donate-wall-close>关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const renderList = () => {
    const listEl = el.querySelector(".donate-wall-modal-body-list");
    if (listEl) listEl.innerHTML = renderDonateWallModalListHtml(sortMode);
    el.querySelectorAll("[data-donate-wall-sort]").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.donateWallSort === sortMode);
    });
  };

  const close = () => {
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  };

  el.querySelectorAll("[data-donate-wall-close]").forEach((node) => {
    node.addEventListener("click", close);
  });
  el.querySelectorAll("[data-donate-wall-sort]").forEach((chip) => {
    chip.addEventListener("click", () => {
      sortMode = chip.dataset.donateWallSort || "amount";
      renderList();
    });
  });
  el.querySelector("[data-donate-wall-support]")?.addEventListener("click", () => {
    close();
    setTimeout(() => {
      openSupportSite();
    }, 200);
  });

  const onKey = (ev) => {
    if (ev.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      close();
    }
  };
  document.addEventListener("keydown", onKey);
  renderList();
}

function getShareCardModule() {
  if (!shareCardModulePromise) {
    shareCardModulePromise = import("./share-card.js");
  }
  return shareCardModulePromise;
}

function getQrCodeModule() {
  if (!qrCodeModulePromise) {
    qrCodeModulePromise = import("qrcode");
  }
  return qrCodeModulePromise;
}

function ensureImagePreload(src, size, fetchPriority = "high") {
  const href = optimizedImageUrl(src, { size, proxy: "netease" });
  if (!href || preloadedImageHrefs.has(href)) return;
  preloadedImageHrefs.add(href);
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "image";
  link.href = href;
  if (fetchPriority === "high" || fetchPriority === "low") {
    link.setAttribute("fetchpriority", fetchPriority);
  }
  document.head.appendChild(link);
}

/** Warm both LQIP thumb + display size for a match cover. */
function preloadMatchCover(src, { priority = "high" } = {}) {
  if (!src) return;
  ensureImagePreload(src, IMAGE_SIZES.list, priority);
  ensureImagePreload(src, IMAGE_SIZES.match, priority);
}

/** After current pick, peek both outcomes and warm the next match covers. */
function prefetchUpcomingMatchCovers(state, match, avatar) {
  if (!match?.id) return;
  for (const side of ["a", "b"]) {
    try {
      const nextBracket = chooseWinner(state.bracket, match.id, side);
      const next = currentMatch(nextBracket);
      if (!next?.a || !next?.b) continue;
      preloadMatchCover(coverUrl(next.a, avatar), { priority: "low" });
      preloadMatchCover(coverUrl(next.b, avatar), { priority: "low" });
    } catch {
      /* ignore peek failures */
    }
  }
}

/**
 * Yield one frame before heavy sync work so clicks/typing paint first.
 */
function runAfterNextPaint(task) {
  requestAnimationFrame(() => {
    setTimeout(task, 0);
  });
}

function progressivePickCover(song, fallback) {
  const raw = coverUrl(song, fallback);
  if (!raw) {
    return `<div class="pick-cover img-fallback" aria-hidden="true"></div>`;
  }
  const thumb = optimizedImageUrl(raw, { size: IMAGE_SIZES.list });
  const full = optimizedImageUrl(raw, { size: IMAGE_SIZES.match });
  const direct = sizedCoverUrl(raw, IMAGE_SIZES.match);
  const directAttr =
    direct && direct !== thumb ? ` data-direct-src="${esc(direct)}"` : "";
  return `<img class="pick-cover" src="${esc(thumb)}" data-full-src="${esc(
    full
  )}"${directAttr} alt="${esc(song?.title || "")}" loading="eager" fetchpriority="high" decoding="async" referrerpolicy="no-referrer" width="320" height="320" onerror="window.__heipaImgError&&window.__heipaImgError(this)" />`;
}

function upgradeProgressiveCovers(root = document) {
  root.querySelectorAll("img.pick-cover[data-full-src]").forEach((img) => {
    const full = img.getAttribute("data-full-src");
    if (!full || img.dataset.upgraded === "1") return;
    const hi = new Image();
    hi.decoding = "async";
    hi.fetchPriority = "high";
    hi.onload = () => {
      if (!img.isConnected) return;
      img.src = full;
      img.removeAttribute("data-full-src");
      img.dataset.upgraded = "1";
    };
    hi.onerror = () => {
      img.removeAttribute("data-full-src");
      // keep current thumb; do not clear src
    };
    hi.src = full;
  });
}

app?.addEventListener("click", (e) => {
  const about = e.target.closest("[data-about-site]");
  if (about) {
    e.preventDefault();
    trackEvent("about_open");
    openAboutSite();
    return;
  }
  const support = e.target.closest("[data-support-site]");
  if (support) {
    e.preventDefault();
    trackEvent("support_open");
    openSupportSite();
    return;
  }
  const messageWall = e.target.closest("[data-message-wall]");
  if (messageWall) {
    e.preventDefault();
    openMessageWall();
  }
});

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

/** Only show SEO guide on home (and /guide which opens home + modal). */
function syncSeoGuideVisibility(parts) {
  const guide = document.getElementById("seo-guide");
  if (!guide) return;
  const home = !parts?.[0] || parts[0] === "guide";
  guide.hidden = !home;
}

window.addEventListener("hashchange", render);
bootstrap();

function ensureLoadBanner() {
  if (document.getElementById("heipa-load-banner")) return;
  const el = document.createElement("div");
  el.id = "heipa-load-banner";
  el.className = "heipa-load-banner";
  el.innerHTML = `
    <p>当前访问高峰，排行榜 / 试听可能延迟 10–30 秒，对决选边不受影响。</p>
    <button type="button" class="heipa-load-banner-close" aria-label="关闭">×</button>`;
  document.body.prepend(el);
  el.querySelector(".heipa-load-banner-close")?.addEventListener("click", () => {
    el.classList.remove("is-on");
  });
}

function showLoadBanner() {
  ensureLoadBanner();
  document.getElementById("heipa-load-banner")?.classList.add("is-on");
}

async function bootstrap() {
  initPerfVitalsTracking();
  fetch("/api/health", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d?.load === "high") showLoadBanner();
    })
    .catch(() => {});
  // Soft-fill home avatars in background after first paint
  render();
  softFillAvatars();
}

function render() {
  stopAllPageAudio();
  const { parts } = route();
  if (parts[0] !== "champ") {
    closeChampDonateTip();
  }
  const saved = loadState();
  syncSeoGuideVisibility(parts);

  if (parts[0] === "rank") {
    const tab =
      parts[1] === "artists"
        ? "artists"
        : parts[1] === "artists-pk"
          ? "artists-pk"
          : parts[1] === "duel-king"
            ? "duel-king"
            : parts[1] === "labels"
              ? "labels"
              : parts[1] === "hangla"
                ? "hangla"
                : "songs";
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
  if (parts[0] === "artist-pk") {
    renderArtistPk();
    return;
  }
  if (parts[0] === "label-beef") {
    renderLabelBeef();
    return;
  }
  if (parts[0] === "duel-king") {
    renderDuelKing();
    return;
  }
  if (parts[0] === "guide") {
    renderHome();
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

function openAboutSite() {
  const existing = document.getElementById("about-site");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "about-site";
  el.className = "about-site";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "about-site-title");
  el.innerHTML = `
    <div class="about-site-backdrop" data-about-close></div>
    <div class="about-site-panel">
      <header class="about-site-head">
        <div class="about-site-head-main">
          <div class="about-site-icon brand-wordmark" aria-hidden="true">
            <span class="brand-heipa">黑怕</span>
          </div>
          <h2 id="about-site-title">关于本站</h2>
        </div>
        <button type="button" class="about-site-close" data-about-close aria-label="关闭">×</button>
      </header>
      <div class="about-site-body">
        <p>大家好！我是一名大四在读学生，非常喜欢各式的音乐，尤其喜欢 HipHop 这种表现形式。最近在网上经常刷到 MusicCup 的歌曲二选一，但发现大部分以流行音乐为主，没有什么说唱音乐的玩法，想着自己也是学计算机的，就想着自己着手实现一下。本网站从有这个想法到实现只用了不到三天，所以有些不妥的地方还希望大家多多包涵。</p>
        <p>对 HipHop 的热爱让我做出了 HeiPaClub，希望这游戏也能给你带来一点快乐，选出你心中的 Rap Star 和 HitSong！Peace!</p>
        <div class="about-site-section-label">作者账号</div>
        <div class="about-site-links">
          <a class="about-site-link-card" href="https://github.com/yiziff" target="_blank" rel="noopener noreferrer">
            <span class="about-site-link-ico" aria-hidden="true">GH</span>
            <span class="about-site-link-copy">
              <strong>GitHub</strong>
              <em>@yiziff</em>
            </span>
          </a>
          <a class="about-site-link-card" href="https://v.douyin.com/Fe6sWPXT4MM/" target="_blank" rel="noopener noreferrer">
            <span class="about-site-link-ico" aria-hidden="true">抖</span>
            <span class="about-site-link-copy">
              <strong>抖音</strong>
              <em>打开主页</em>
            </span>
          </a>
          <a class="about-site-link-card" href="https://xhslink.cn/m/8hif4VUVuec" target="_blank" rel="noopener noreferrer">
            <span class="about-site-link-ico" aria-hidden="true">红</span>
            <span class="about-site-link-copy">
              <strong>小红书</strong>
              <em>感谢朋友的宣发帮助</em>
            </span>
          </a>
        </div>
        <p class="about-site-footnote">
          特别鸣谢：<a href="https://musiccup.app" target="_blank" rel="noopener noreferrer">MusicCup.app</a>
        </p>
      </div>
      <button type="button" class="about-site-done" data-about-close>关闭</button>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const close = () => {
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  };
  el.querySelectorAll("[data-about-close]").forEach((node) => {
    node.addEventListener("click", close);
  });
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      close();
    }
  };
  document.addEventListener("keydown", onKey);
}

function openMessageWall() {
  const existing = document.getElementById("message-wall");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "message-wall";
  el.className = "about-site";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "message-wall-title");
  el.innerHTML = `
    <div class="about-site-backdrop" data-message-wall-close></div>
    <div class="about-site-panel">
      <header class="about-site-head">
        <div class="about-site-head-main">
          <div class="about-site-icon brand-wordmark" aria-hidden="true">
            <span class="brand-heipa">黑怕</span>
          </div>
          <h2 id="message-wall-title">支持者留言墙</h2>
        </div>
        <button type="button" class="about-site-close" data-message-wall-close aria-label="关闭">×</button>
      </header>
      <div class="about-site-body">
        <div class="about-site-supporters">
          ${renderSupportersWallHtml({ showAmount: false })}
          <p class="about-site-supporters-note">名单由作者根据赞赏留言手动更新 · 永久墙与本周墙分开展示，感谢每一位支持者 🙏</p>
        </div>
      </div>
      <div class="message-wall-actions">
        <button type="button" class="about-site-done message-wall-support" data-message-wall-support>我也要支持</button>
        <button type="button" class="about-site-done" data-message-wall-close>关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const close = () => {
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  };
  el.querySelectorAll("[data-message-wall-close]").forEach((node) => {
    node.addEventListener("click", close);
  });
  el.querySelector("[data-message-wall-support]")?.addEventListener("click", () => {
    close();
    setTimeout(() => openSupportSite(), 200);
  });
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      close();
    }
  };
  document.addEventListener("keydown", onKey);
}

function openSupportSite(opts = {}) {
  const existing = document.getElementById("support-site");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "support-site";
  el.className = "about-site";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "support-site-title");
  el.innerHTML = `
    <div class="about-site-backdrop" data-support-close></div>
    <div class="about-site-panel">
      <header class="about-site-head">
        <div class="about-site-head-main">
          <div class="about-site-icon brand-wordmark" aria-hidden="true">
            <span class="brand-heipa">黑怕</span>
          </div>
          <h2 id="support-site-title">👊 Respect！给服务器加点油</h2>
        </div>
        <button type="button" class="about-site-close" data-support-close aria-label="关闭">×</button>
      </header>
      <div class="about-site-body">
        <div class="about-site-donate">
          <p class="about-site-donate-copy">为了给家人们做个好玩的说唱专属小游戏，本站的所有开销都是我自掏腰包，纯靠“为爱发电”。现在流量越来越大，服务器急需升级才能保证大家顺畅访问。如果你玩得开心，欢迎赞助一瓶水钱，帮助网站持续运营下去，感谢支持！</p>
          <p class="about-site-donate-perk-tip">🔥 福利放送：扫码赞助后有<button type="button" class="about-site-perk-link" data-support-scroll-perks>特殊福利</button>哦</p>
          <ul class="about-site-tiers" id="support-site-perks">
            <li class="about-site-tier">
              <div class="about-site-tier-head"><strong>奶茶档</strong><span class="about-site-tier-price">¥5</span></div>
              <p>本周支持者墙留名 7 天 · 显示昵称 + 你的留言</p>
            </li>
            <li class="about-site-tier">
              <div class="about-site-tier-head"><strong>共建档</strong><span class="about-site-tier-price">¥20</span></div>
              <p>永久支持者墙 · 昵称 + 留言 · 获得「第 N 位支持者」编号</p>
            </li>
            <li class="about-site-tier about-site-tier--featured">
              <div class="about-site-tier-head"><strong>冠名档</strong><span class="about-site-tier-price">¥30+</span></div>
              <p>首页滚动致谢一周 + 永久支持者墙 · 例：感谢 @你的昵称 支持本站运营 ♥</p>
            </li>
          </ul>
          <ol class="about-site-donate-steps">
            <li>微信扫一扫下方赞赏码，按档位选择 <strong>¥5 / ¥20 / ¥30+</strong></li>
            <li><strong>留言格式：</strong><span class="about-site-key-highlight">你的昵称和想说的一段话！</span></li>
            <li>勾选<span class="about-site-key-highlight">「向对方展示我的名字」</span>，方便核对</li>
            <li>留言后 1–3 天内我会核对并更新上墙 / 首页致谢</li>
          </ol>
          <img class="about-site-donate-qr" src="/donate-qr.png" width="220" height="220" alt="微信赞赏码" loading="lazy" decoding="async" />
          <p class="about-site-donate-hint">微信扫一扫 · 赞赏码 · 记得留言昵称和想说的话</p>
        </div>
        <div class="about-site-section-label">支持者留言墙</div>
        <div class="about-site-supporters">
          ${renderSupportersWallHtml()}
          <p class="about-site-supporters-note">名单由作者根据赞赏留言手动更新 · 永久墙与本周墙分开展示，感谢每一位支持者 🙏</p>
        </div>
      </div>
      <button type="button" class="about-site-done" data-support-close>关闭</button>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const body = el.querySelector(".about-site-body");
  const scrollToPerks = () => {
    const perks = el.querySelector("#support-site-perks");
    if (!perks || !body) return;
    perks.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  el.querySelector("[data-support-scroll-perks]")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    scrollToPerks();
  });
  if (opts.scrollToPerks) {
    requestAnimationFrame(() => setTimeout(scrollToPerks, 280));
  }

  const close = () => {
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  };
  el.querySelectorAll("[data-support-close]").forEach((node) => {
    node.addEventListener("click", close);
  });
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      close();
    }
  };
  document.addEventListener("keydown", onKey);
}

function openPlayGuide() {
  const existing = document.getElementById("play-guide");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "play-guide";
  el.className = "about-site play-guide";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "play-guide-title");
  el.innerHTML = `
    <div class="about-site-backdrop" data-guide-close></div>
    <div class="about-site-panel play-guide-panel">
      <header class="about-site-head">
        <div class="about-site-head-main">
          <div class="about-site-icon brand-wordmark" aria-hidden="true">
            <span class="brand-heipa">黑怕</span>
          </div>
          <h2 id="play-guide-title">玩法指南</h2>
        </div>
        <button type="button" class="about-site-close" data-guide-close aria-label="关闭">×</button>
      </header>
      <div class="about-site-body">
        <p>
          <strong>黑怕巅峰对决</strong>专注说唱，尤其是<strong>中文说唱</strong>：
          单曲 1v1 淘汰、歌手大比拼、新颖厂牌对战、流行锐评「从夯到拉」，选出你心中的 Rap Star 与 Hit Song。
        </p>
        <div class="about-site-section-label">单曲巅峰对决</div>
        <p>
          选歌手开赛，热门单曲或自定义歌单均可。每轮两首对决，决出冠军后计入排行榜——用耳朵投出本命曲。
        </p>
        <div class="about-site-section-label">歌手大比拼</div>
        <p>
          先选华语 / 欧美与粉丝门槛，再随机抽最多 32 位歌手两两 PK，规则与单曲淘汰赛相同，冠军计入歌手夺冠榜。
        </p>
        <div class="about-site-section-label">厂牌巅峰混战</div>
        <p>
          以 HipHop 厂牌为单位拉人对垒的新颖对战模式，适合厂牌粉一起刷，感受说唱厂牌之间的对决张力。
        </p>
        <div class="about-site-section-label">锐评从夯到拉</div>
        <p>
          随机抽取 Rapper，分进夯 / 顶级 / 人上人 / NPC / 拉了等档位，快速输出你的锐评排序，结果可复制分享。
        </p>
        <div class="about-site-section-label">排行榜与防刷</div>
        <p>
          冠军匿名累计进榜。战绩已开启防刷：每人每天最多计入 5 次有效评选。
        </p>
        <p class="about-site-footnote">
          想了解作者故事？
          <button type="button" class="about-inline-link" data-open-about>关于本站</button>
        </p>
      </div>
      <button type="button" class="about-site-done" data-guide-close>知道了</button>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  const close = () => {
    el.classList.remove("is-on");
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
    if ((location.hash.replace(/^#/, "") || "/") === "/guide") {
      history.replaceState(null, "", "#/");
    }
  };
  el.querySelectorAll("[data-guide-close]").forEach((node) => {
    node.addEventListener("click", close);
  });
  el.querySelector("[data-open-about]")?.addEventListener("click", () => {
    close();
    setTimeout(() => openAboutSite(), 180);
  });
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      close();
    }
  };
  document.addEventListener("keydown", onKey);
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
  const cards = app.querySelectorAll(".artist-card[data-artist]");
  let idx = -1;
  cards.forEach((card, i) => {
    if (card.dataset.artist === artist.id) idx = i;
  });
  const eager = idx >= 0 && idx < 4;
  const img = document.createElement("img");
  img.className = "artist-avatar";
  img.src = optimizedImageUrl(artist.avatar, { size: IMAGE_SIZES.avatar });
  img.alt = artist.name;
  img.loading = eager ? "eager" : "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.dataset.directSrc = sizedCoverUrl(artist.avatar, IMAGE_SIZES.avatar);
  if (eager && idx < 2) img.fetchPriority = "high";
  img.width = 96;
  img.height = 96;
  bindImageFallback(img);
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

  // ① VIP 静态包：常用歌手秒开
  if (base.source !== "itunes" && hasHotTopPack(id)) {
    try {
      const pack = await loadHotTopPack(id);
      if (pack?.songs?.length) {
        const live = {
          ...base,
          neteaseArtistId: pack.neteaseArtistId || base.neteaseArtistId,
          neteaseArtistName: pack.name || base.name,
          avatar: pack.avatar || base.avatar || "",
          songs: pack.songs.slice(0, TOP_N),
          fromHotTopPack: true,
        };
        artistCache.set(id, live);
        base.avatar = live.avatar;
        return live;
      }
    } catch (_) {
      /* fall through */
    }
  }

  // ② KV 记忆：24h 内别人拉过 → 边缘命中
  if (base.source !== "itunes" && base.neteaseArtistId) {
    try {
      const cached = await fetchArtistTopCache(base.neteaseArtistId);
      if (cached?.songs?.length) {
        const live = {
          ...base,
          neteaseArtistId: cached.neteaseArtistId || base.neteaseArtistId,
          neteaseArtistName: cached.name || base.name,
          avatar: cached.avatar || base.avatar || "",
          songs: cached.songs.slice(0, TOP_N),
          fromKvCache: true,
        };
        artistCache.set(id, live);
        if (live.avatar) base.avatar = live.avatar;
        return live;
      }
    } catch (_) {
      /* fall through to live */
    }
  }

  // ③ 实时拉；成功后写入 KV 造福后来者。失败则用热门包 / KV / 本地曲库保底开赛。
  try {
    const live =
      base.source === "itunes"
        ? await loadItunesArtistCup(base, { limit: TOP_N })
        : await loadArtistCup(base, { limit: TOP_N });
    artistCache.set(id, live);
    base.avatar = live.avatar;
    if (base.source !== "itunes" && live?.neteaseArtistId && live?.songs?.length) {
      putArtistTopCache(live);
    }
    return live;
  } catch (err) {
    if (base.source !== "itunes" && base.neteaseArtistId) {
      try {
        const cached = await fetchArtistTopCache(base.neteaseArtistId);
        if (cached?.songs?.length) {
          const live = {
            ...base,
            neteaseArtistId: cached.neteaseArtistId || base.neteaseArtistId,
            neteaseArtistName: cached.name || base.name,
            avatar: cached.avatar || base.avatar || "",
            songs: cached.songs.slice(0, TOP_N),
            fromOfflineFallback: true,
          };
          artistCache.set(id, live);
          if (live.avatar) base.avatar = live.avatar;
          return live;
        }
      } catch {
        /* ignore */
      }
    }
    if (base.source !== "itunes" && hasHotTopPack(id)) {
      try {
        const pack = await loadHotTopPack(id);
        if (pack?.songs?.length) {
          const live = {
            ...base,
            neteaseArtistId: pack.neteaseArtistId || base.neteaseArtistId,
            neteaseArtistName: pack.name || base.name,
            avatar: pack.avatar || base.avatar || "",
            songs: pack.songs.slice(0, TOP_N),
            fromOfflineFallback: true,
          };
          artistCache.set(id, live);
          base.avatar = live.avatar;
          return live;
        }
      } catch {
        /* ignore */
      }
    }
    if (Array.isArray(base.songs) && base.songs.length) {
      const live = {
        ...base,
        songs: base.songs.slice(0, TOP_N),
        fromOfflineFallback: true,
      };
      artistCache.set(id, live);
      return live;
    }
    throw err;
  }
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
  let lastPaintQuery = "";

  const norm = normArtistKey;

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

  const mergeWithItunes = (query, localList) =>
    mergeLocalArtistsWithItunes(query, localList);

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
          const boss = labelLeader(ARTISTS, l.id);
          return `
            <button type="button" class="label-chip${labelId === l.id ? " active" : ""}" data-label="${esc(l.id)}">
              ${imgTag(boss?.avatar, {
                alt: l.name,
                className: "label-chip-avatar",
                size: IMAGE_SIZES.chip,
                width: 40,
                height: 40,
              })}
              <span class="label-chip-text">
                <strong>${esc(l.name)}</strong>
                <span>${n} 人${city}</span>
              </span>
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
  const artistGridClick = (event) => {
    const card = event.target.closest("[data-artist]");
    if (!card) return;
    navigate(`/artist/${card.dataset.artist}`);
  };
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
    bar.innerHTML = `
      <div class="home-more-row">
        <button type="button" class="ghost-btn home-more-btn" id="home-more-btn">
          显示更多
        </button>
        ${
          homeLimit > 50
            ? `<button type="button" class="primary-btn home-all-btn" id="home-all-btn">显示全部</button>`
            : ""
        }
        <p class="home-more-hint">（许多这里没有显示出来的歌手可以通过上方的搜索栏直接搜到哦）</p>
      </div>
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
    const grid = document.getElementById("artist-grid");
    const count = document.getElementById("artist-count");
    if (!grid) return;

    const writeGrid = (list) => {
      const labelMeta = regionMode === "label" && labelId ? getLabel(labelId) : null;
      if (count) {
        if (labelMeta) {
          count.hidden = false;
          count.textContent = `${labelMeta.name}${labelMeta.city ? ` · ${labelMeta.city}` : ""} · ${list.length} 位成员`;
        } else {
          count.hidden = true;
          count.textContent = "";
        }
      }
      if (list[0]?.avatar) {
        ensureImagePreload(list[0].avatar, IMAGE_SIZES.avatar, "high");
      }
      if (list[1]?.avatar) {
        ensureImagePreload(list[1].avatar, IMAGE_SIZES.avatar, "high");
      }
      /** First-screen avatars should not be lazy (LCP); rest of the long list stays lazy. */
      const HOME_EAGER_COUNT = 4;
      grid.innerHTML = list.length
        ? list
            .map((a, index) => {
              const wins = rankWins.get(artistRankKey(a)) || rankWins.get(a.name) || 0;
              const winMeta =
                sortMode === "rank" && wins
                  ? ` · 夺冠 ${Number(wins).toLocaleString("zh-CN")} 次`
                  : "";
              const eager = index < HOME_EAGER_COUNT;
              const metaBits = [];
              if (a.fans) metaBits.push(`${Number(a.fans).toLocaleString("zh-CN")} 粉`);
              if (winMeta) metaBits.push(winMeta.replace(/^\s*·\s*/, ""));
              return `
        <button type="button" class="artist-card" data-artist="${a.id}">
          ${imgTag(a.avatar, {
            alt: a.name,
            className: "artist-avatar",
            size: IMAGE_SIZES.avatar,
            loading: eager ? "eager" : "lazy",
            fetchPriority: index < 2 ? "high" : "auto",
            width: 96,
            height: 96,
            sizes: "96px",
            responsive: false,
          })}
          <div class="artist-card-body">
            <div class="name">${esc(a.name)}</div>
            <p class="meta">${esc(metaBits.join(" · "))}</p>
          </div>
        </button>`;
            })
            .join("")
        : `<p class="loading-line">${
            regionMode === "label"
              ? "该厂牌成员暂未匹配到名单，或尚未收录。"
              : "没有匹配的 Rapper，换个关键词试试。"
          }</p>`;

      list.slice(0, 24).forEach((a) => {
        if (!a.avatar) fillAvatarForArtist(a);
      });

      lastPaintQuery = query;
      paintMoreBar(list.length, poolTotal, query);
    };

    // Paint local results first so search INP is not blocked by iTunes.
    writeGrid(localList);

    if (query && regionMode !== "label" && query.length >= 2) {
      const merged = sortList(await mergeWithItunes(query, localList)).filter(
        (a) => artistRegion(a) === regionMode
      );
      if (token !== searchToken) return;
      writeGrid(merged);
    }
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
        <span class="hero-tagline-lead">给你的本命 Rapper 办一场真正的说唱巅峰对决</span>
        <span class="hero-tagline-sub">单曲对决 · 歌手大比拼 · 厂牌对抗 · 从夯到拉 · 选出你心中的 Rap Star</span>
      </p>
      <div class="hero-about-actions">
        <button type="button" class="about-site-btn" data-about-site>[关于本站]</button>
        <button type="button" class="about-site-btn" data-support-site>[支持运营]</button>
        <button type="button" class="about-site-btn" data-message-wall>[留言墙]</button>
      </div>
      <button type="button" class="donate-ticker" data-support-site aria-label="打开支持运营">
        <span class="donate-ticker-track">
          <span class="donate-ticker-text">${esc(getDonateTickerText())}</span>
          <span class="donate-ticker-text" aria-hidden="true">${esc(getDonateTickerText())}</span>
        </span>
      </button>
    </section>
    ${renderSponsorTickerHtml()}
    <div class="home-controls-layout">
      <div class="home-controls-main">
        <div class="section-title">选择歌手 <span id="artist-count" hidden></span></div>
        <p class="home-search-hint">没显示到的歌手也可以直接搜索哦</p>
        <div class="search-row">
          <input id="artist-search" type="search" placeholder="搜索歌手…" autocomplete="off" />
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
      </div>
      ${renderHomeDonateWallHtml()}
    </div>
    <div class="artist-grid" id="artist-grid"></div>
    <div class="home-more" id="home-more" hidden></div>
  `,
    {
      actions: `
        <button type="button" class="ghost-btn duel-king-top-btn" id="duel-king-entry">谁是单挑王</button>
        <button type="button" class="ghost-btn artist-pk-top-btn" id="artist-pk-entry">歌手大比拼</button>
        <button type="button" class="ghost-btn beef-top-btn" id="beef-entry">厂牌巅峰混战</button>
        <button type="button" class="ghost-btn hangla-top-btn" id="hangla-entry">锐评从夯到拉</button>
      `,
    }
  );

  const input = document.getElementById("artist-search");
  const grid = document.getElementById("artist-grid");
  grid?.addEventListener("click", artistGridClick);
  paintGrid("");

  document.getElementById("hangla-entry")?.addEventListener("click", () => navigate("/hangla"));
  document.getElementById("artist-pk-entry")?.addEventListener("click", () => navigate("/artist-pk"));
  document.getElementById("beef-entry")?.addEventListener("click", () => navigate("/label-beef"));
  document.getElementById("duel-king-entry")?.addEventListener("click", () => navigate("/duel-king"));

  const donateToggle = app.querySelector("[data-toggle-donate-wall]");
  donateToggle?.addEventListener("click", () => {
    trackEvent("donate_wall_expand");
    openMessageWall();
  });
  app.querySelector("[data-home-donate-placeholder]")?.addEventListener("click", () => {
    trackEvent("support_open");
    openSupportSite();
  });

  let timer = null;
  const apply = (force = false) => {
    clearTimeout(timer);
    const nextQuery = String(input?.value || "").trim();
    if (!force && nextQuery === lastPaintQuery) return;
    timer = setTimeout(() => {
      runAfterNextPaint(() => paintGrid(input?.value || ""));
    }, 180);
  };
  input?.addEventListener("input", () => {
    // searching: no need to reset paging permanently; empty search keeps limit
    apply(false);
  });

  document.querySelectorAll("#sort-row [data-sort]").forEach((chip) => {
    chip.addEventListener("click", () => {
      sortMode = chip.dataset.sort || "fans";
      document
        .querySelectorAll("#sort-row .mode-chip")
        .forEach((c) => c.classList.toggle("active", c === chip));
      apply(true);
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
        if (labelId) apply(true);
        return;
      }
      regionMode = r === "west" ? "west" : "cn";
      labelId = null;
      labelPanelOpen = false;
      resetHomePaging();
      syncRegionChips();
      paintLabelPanel();
      apply(true);
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
      if (sortMode === "rank") apply(true);
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
  } else if (saved?.cupType === "duel-king" && saved?.bracket && !saved.bracket.champion) {
    const resume = document.createElement("p");
    resume.style.marginTop = "1.5rem";
    resume.innerHTML = `<button type="button" class="primary-btn" id="resume-btn">继续单挑王 · ${esc(
      saved.artistName || "进行中"
    )}</button>`;
    app.querySelector(".shell")?.appendChild(resume);
    document.getElementById("resume-btn")?.addEventListener("click", () => navigate("/play"));
  } else if (saved?.cupType === "artist-cup" && saved?.bracket && !saved.bracket.champion) {
    const resume = document.createElement("p");
    resume.style.marginTop = "1.5rem";
    resume.innerHTML = `<button type="button" class="primary-btn" id="resume-btn">继续歌手大比拼 · ${esc(
      saved.artistName || "进行中"
    )}</button>`;
    app.querySelector(".shell")?.appendChild(resume);
    document.getElementById("resume-btn")?.addEventListener("click", () => navigate("/play"));
  } else if (saved?.bracket && !saved.bracket.champion && saved.cupType !== "label-beef") {
    const resume = document.createElement("p");
    resume.style.marginTop = "1.5rem";
    resume.innerHTML = `<button type="button" class="primary-btn" id="resume-btn">继续未完赛的 ${esc(saved.artistName)}</button>`;
    app.querySelector(".shell")?.appendChild(resume);
    document.getElementById("resume-btn").addEventListener("click", () => navigate("/play"));
  }
}

function renderDuelKing() {
  let pickA = null;
  let pickB = null;
  let queryA = "";
  let queryB = "";
  let toastMsg = "";
  let toastTimer = null;
  let loading = false;
  /** @type {null | { side: "a"|"b", artistA: any, artistB: any, poolA: any[], poolB: any[], selectedA: Set<string>, selectedB: Set<string>, expandA: string, expandB: string }} */
  let customPick = null;

  const top20 = () =>
    [...ARTISTS].sort((a, b) => Number(b.fans || 0) - Number(a.fans || 0)).slice(0, 20);

  const filterArtists = (q) => {
    const query = String(q || "").trim().toLowerCase();
    if (!query) return top20();
    return ARTISTS.filter((a) =>
      [a.name, a.search, a.city, a.tag].join(" ").toLowerCase().includes(query)
    ).slice(0, 80);
  };

  let searchTokenA = 0;
  let searchTokenB = 0;

  const resolveDuelArtist = (id) => resolveRosterArtist(id);

  const bindLanePicks = (root = app) => {
    root.querySelectorAll("[data-duel-pick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const side = btn.dataset.duelPick;
        const id = btn.dataset.artistId;
        const artist = resolveDuelArtist(id);
        if (!artist) return;
        if (side === "a") pickA = artist;
        else pickB = artist;
        paint();
      });
    });
  };

  const syncLaneHint = (side, query) => {
    const hint = app.querySelector(`.duel-lane-${side} .duel-lane-hint`);
    if (!hint) return;
    hint.hidden = Boolean(String(query || "").trim());
  };

  const writeLaneGrid = (side, list, query = "") => {
    const grid = app.querySelector(`.duel-lane-${side} .duel-artist-grid`);
    if (!grid) return;
    grid.innerHTML = list.length
      ? list.map((a) => artistCard(a, side)).join("")
      : `<p class="loading-line">没有匹配的歌手，换个关键词试试</p>`;
    list.slice(0, 16).forEach((a) => {
      if (!a.avatar) fillAvatarForArtist(a);
    });
    syncLaneHint(side, query);
    bindLanePicks(grid);
  };

  const refreshLaneSearch = async (side, query) => {
    const token = side === "a" ? ++searchTokenA : ++searchTokenB;
    const local = filterArtists(query);
    writeLaneGrid(side, local, query);
    const q = String(query || "").trim();
    if (q.length < 2) return;
    const merged = await mergeLocalArtistsWithItunes(q, local);
    if (side === "a" ? token !== searchTokenA : token !== searchTokenB) return;
    const current = side === "a" ? queryA : queryB;
    if (String(current || "").trim() !== q) return;
    writeLaneGrid(side, merged, query);
  };

  const showToast = (msg) => {
    toastMsg = msg || "";
    const el = document.getElementById("duel-toast");
    if (el) {
      el.textContent = toastMsg;
      el.classList.toggle("is-on", Boolean(toastMsg));
    }
    clearTimeout(toastTimer);
    if (toastMsg) {
      toastTimer = setTimeout(() => {
        toastMsg = "";
        const t = document.getElementById("duel-toast");
        if (t) {
          t.textContent = "";
          t.classList.remove("is-on");
        }
      }, 2800);
    }
  };

  const artistCard = (artist, side) => {
    const selected =
      (side === "a" && pickA?.id === artist.id) || (side === "b" && pickB?.id === artist.id);
    const takenOther =
      (side === "a" && pickB?.id === artist.id) || (side === "b" && pickA?.id === artist.id);
    return `
      <button type="button" class="duel-artist-card${selected ? " is-selected" : ""}${
        takenOther ? " is-taken" : ""
      }" data-duel-pick="${esc(side)}" data-artist-id="${esc(artist.id)}" ${
        takenOther ? "disabled" : ""
      }>
        ${imgTag(artist.avatar, {
          alt: artist.name,
          className: "duel-artist-avatar",
          size: IMAGE_SIZES.chip,
          width: 44,
          height: 44,
        })}
        <span class="duel-artist-name">${esc(artist.name)}</span>
      </button>`;
  };

  const laneHtml = (side, query) => {
    const list = filterArtists(query);
    const picked = side === "a" ? pickA : pickB;
    const label = side === "a" ? "歌手 A" : "歌手 B";
    const hasQuery = Boolean(String(query || "").trim());
    return `
      <section class="duel-lane duel-lane-${side}" aria-label="${label}">
        <div class="duel-lane-head">
          <h2>${label}${picked ? ` · ${esc(picked.name)}` : ""}</h2>
          <input type="search" class="duel-lane-search" data-duel-search="${side}"
            placeholder="搜索你的出战歌手！" value="${esc(query)}" autocomplete="off" />
        </div>
        <div class="duel-artist-grid">${list.map((a) => artistCard(a, side)).join("")}</div>
        <p class="duel-lane-hint"${hasQuery ? " hidden" : ""}>其他歌手可在搜索框中检索</p>
      </section>`;
  };

  const loadSongsForArtist = async (artist) => {
    let live = null;
    try {
      live = await hydrateArtist(artist.id);
    } catch {
      /* fall through */
    }
    if (!live?.songs?.length) {
      live =
        artist.source === "itunes"
          ? await loadItunesArtistCup(artist, { limit: TOP_N })
          : await loadArtistCup(artist, { limit: TOP_N });
    }
    return live;
  };

  const startDuelWithSongs = (artistA, artistB, songsA, songsB) => {
    const taggedA = songsA.map((s) => tagDuelSong(s, "a", artistA));
    const taggedB = songsB.map((s) => tagDuelSong(s, "b", artistB));
    if (taggedA.length < DUEL_SONGS_PER_SIDE || taggedB.length < DUEL_SONGS_PER_SIDE) {
      showToast(`两边都至少需要 ${DUEL_SONGS_PER_SIDE} 首歌`);
      return false;
    }
    const bracket = buildDuelBracket(taggedA, taggedB);
    if (!bracket) {
      showToast("组签失败，请换人重试");
      return false;
    }
    const state = emptyDuelState(artistA, artistB);
    state.phase = "bracket";
    state.songs = [...taggedA.slice(0, DUEL_SONGS_PER_SIDE), ...taggedB.slice(0, DUEL_SONGS_PER_SIDE)];
    state.bracket = bracket;
    saveState(state);
    enrichSongsPlaySourceProgressive(state.songs.slice(0, 8), artistA.name, {
      readyCount: 4,
      concurrency: 2,
      mapArtistId: artistA.id,
    }).catch(() => {});
    navigate("/play");
    return true;
  };

  const startOneClick = async () => {
    if (!pickA || !pickB || pickA.id === pickB.id) {
      showToast("请上下栏各选一位不同歌手");
      return;
    }
    if (loading) return;
    loading = true;
    paint();
    try {
      const [liveA, liveB] = await Promise.all([loadSongsForArtist(pickA), loadSongsForArtist(pickB)]);
      const songsA = (liveA?.songs || []).slice(0, DUEL_SONGS_PER_SIDE);
      const songsB = (liveB?.songs || []).slice(0, DUEL_SONGS_PER_SIDE);
      if (songsA.length < DUEL_SONGS_PER_SIDE || songsB.length < DUEL_SONGS_PER_SIDE) {
        showToast(`曲库不足 ${DUEL_SONGS_PER_SIDE} 首，请换人`);
        loading = false;
        paint();
        return;
      }
      startDuelWithSongs(liveA || pickA, liveB || pickB, songsA, songsB);
    } catch (e) {
      showToast(e.message || "拉歌失败");
      loading = false;
      paint();
    }
  };

  const beginCustom = async () => {
    if (!pickA || !pickB || pickA.id === pickB.id) {
      showToast("请上下栏各选一位不同歌手");
      return;
    }
    if (loading) return;
    loading = true;
    paint();
    try {
      const [liveA, liveB] = await Promise.all([loadSongsForArtist(pickA), loadSongsForArtist(pickB)]);
      if (!(liveA?.songs?.length) || !(liveB?.songs?.length)) {
        showToast("曲库加载失败");
        loading = false;
        paint();
        return;
      }
      customPick = {
        side: "a",
        artistA: liveA,
        artistB: liveB,
        poolA: [...(liveA.songs || [])],
        poolB: [...(liveB.songs || [])],
        selectedA: new Set(),
        selectedB: new Set(),
        expandA: "hot50",
        expandB: "hot50",
      };
      loading = false;
      paint();
    } catch (e) {
      showToast(e.message || "曲库加载失败");
      loading = false;
      paint();
    }
  };

  const paintCustom = () => {
    const cp = customPick;
    if (!cp) return;
    const side = cp.side;
    const artist = side === "a" ? cp.artistA : cp.artistB;
    const pool = side === "a" ? cp.poolA : cp.poolB;
    const selected = side === "a" ? cp.selectedA : cp.selectedB;
    const count = selected.size;
    const ready = count === DUEL_SONGS_PER_SIDE;
    const expandStage = side === "a" ? cp.expandA : cp.expandB;
    const expandLabel =
      expandStage === "hot50" ? "再展开到 Top 100" : expandStage === "top100" ? "展示全部歌曲" : "";

    app.innerHTML = shell(
      `
      <section class="duel-king duel-king-pick">
        <div class="setup-head">
          <h1>单挑王 · 自定义选歌</h1>
          <p>${esc(cp.artistA.name)} vs ${esc(cp.artistB.name)} · 各选 ${DUEL_SONGS_PER_SIDE} 首进 32 强</p>
        </div>
        <div class="beef-pick-progress">
          <span class="${side === "a" ? "is-active" : ""}">A ${cp.selectedA.size}/${DUEL_SONGS_PER_SIDE} · ${esc(
            cp.artistA.name
          )}</span>
          <span class="${side === "b" ? "is-active" : ""}">B ${cp.selectedB.size}/${DUEL_SONGS_PER_SIDE} · ${esc(
            cp.artistB.name
          )}</span>
        </div>
        <div class="pick-status ${ready ? "is-ready" : ""}">正在选 ${side === "a" ? "A" : "B"}：(${count}/${DUEL_SONGS_PER_SIDE})</div>
        <div class="setup-actions">
          ${
            side === "a"
              ? `<button type="button" class="primary-btn" id="duel-pick-next" ${
                  ready ? "" : "disabled"
                }>选完 A，去选 B</button>`
              : `<button type="button" class="primary-btn" id="duel-pick-start" ${
                  ready ? "" : "disabled"
                }>生成签表并开赛</button>
                 <button type="button" class="ghost-btn" id="duel-pick-back-a">返回改 A</button>`
          }
          <button type="button" class="ghost-btn" id="duel-pick-cancel">取消</button>
          ${
            expandLabel
              ? `<button type="button" class="ghost-btn" id="duel-pick-expand">${expandLabel}</button>`
              : ""
          }
        </div>
        <div class="section-title">${esc(artist.name)} · 曲库 ${pool.length} 首</div>
        <ul class="song-preview pick-mode">
          ${pool
            .map((s, i) => {
              const key = duelSongKey(s);
              const checked = selected.has(key);
              return `
              <li class="${checked ? "is-picked" : ""}" data-duel-song="${esc(key)}">
                <input type="checkbox" class="song-pick-cb" data-duel-song-id="${esc(key)}" ${
                  checked ? "checked" : ""
                } aria-label="选择 ${esc(s.title)}" />
                ${imgTag(coverUrl(s, artist.avatar), {
                  alt: s.title,
                  className: "song-cover",
                  size: IMAGE_SIZES.list,
                  width: 48,
                  height: 48,
                })}
                <div class="song-meta">
                  <strong>${i + 1}. ${esc(s.title)}</strong>
                  <span>${esc(s.album || s.collection || "")}</span>
                </div>
              </li>`;
            })
            .join("")}
        </ul>
        <p class="hangla-toast${toastMsg ? " is-on" : ""}" id="duel-toast" role="status">${esc(toastMsg)}</p>
      </section>
    `,
      { back: "/duel-king" }
    );
    bindBack();

    app.querySelectorAll("[data-duel-song-id]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const key = cb.dataset.duelSongId;
        if (!key) return;
        if (cb.checked) {
          if (selected.size >= DUEL_SONGS_PER_SIDE) {
            cb.checked = false;
            showToast(`最多选 ${DUEL_SONGS_PER_SIDE} 首`);
            return;
          }
          selected.add(key);
        } else {
          selected.delete(key);
        }
        paintCustom();
      });
    });

    document.getElementById("duel-pick-cancel")?.addEventListener("click", () => {
      customPick = null;
      paint();
    });
    document.getElementById("duel-pick-back-a")?.addEventListener("click", () => {
      cp.side = "a";
      paintCustom();
    });
    document.getElementById("duel-pick-next")?.addEventListener("click", () => {
      if (cp.selectedA.size !== DUEL_SONGS_PER_SIDE) {
        showToast(`A 需恰好 ${DUEL_SONGS_PER_SIDE} 首`);
        return;
      }
      cp.side = "b";
      paintCustom();
    });
    document.getElementById("duel-pick-start")?.addEventListener("click", () => {
      if (cp.selectedA.size !== DUEL_SONGS_PER_SIDE || cp.selectedB.size !== DUEL_SONGS_PER_SIDE) {
        showToast(`两边都需恰好 ${DUEL_SONGS_PER_SIDE} 首`);
        return;
      }
      const songsA = cp.poolA.filter((s) => cp.selectedA.has(duelSongKey(s)));
      const songsB = cp.poolB.filter((s) => cp.selectedB.has(duelSongKey(s)));
      startDuelWithSongs(cp.artistA, cp.artistB, songsA, songsB);
    });
    document.getElementById("duel-pick-expand")?.addEventListener("click", async () => {
      const btn = document.getElementById("duel-pick-expand");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "扩展中…";
      }
      try {
        const stage = side === "a" ? cp.expandA : cp.expandB;
        const target = stage === "hot50" ? "top100" : "all";
        const result = await expandArtistPool(
          pool,
          artist.neteaseArtistId || artist.id,
          target
        );
        const nextPool = result?.songs || pool;
        if (side === "a") {
          cp.poolA = nextPool;
          cp.expandA = result?.stage === "all" || !result?.more ? "all" : result.stage || "top100";
        } else {
          cp.poolB = nextPool;
          cp.expandB = result?.stage === "all" || !result?.more ? "all" : result.stage || "top100";
        }
        paintCustom();
      } catch {
        showToast("扩展曲库失败");
        paintCustom();
      }
    });
  };

  const paint = () => {
    if (customPick) {
      paintCustom();
      return;
    }
    const canStart = Boolean(pickA && pickB && pickA.id !== pickB.id) && !loading;
    app.innerHTML = shell(
      `
      <section class="duel-king">
        <div class="setup-head">
          <div class="setup-head-title-row">
            <h1>谁是单挑王</h1>
            <span class="feature-glow-tip">8.13 新功能上线啦！！！！</span>
          </div>
          <p>上下栏各选一位歌手 · 各 ${DUEL_SONGS_PER_SIDE} 首混进 32 强 · 首轮强制 A vs B</p>
        </div>
        <div class="duel-king-actions">
          <button type="button" class="primary-btn" id="duel-one-click" ${
            canStart ? "" : "disabled"
          }>${loading ? "拉歌中…" : "一键开赛"}</button>
          <button type="button" class="ghost-btn" id="duel-custom" ${
            canStart ? "" : "disabled"
          }>自定义选歌开战</button>
        </div>
        ${laneHtml("a", queryA)}
        ${laneHtml("b", queryB)}
        <p class="hangla-toast${toastMsg ? " is-on" : ""}" id="duel-toast" role="status">${esc(
          toastMsg
        )}</p>
      </section>
    `,
      { back: "/" }
    );
    bindBack();
    bindLanePicks();

    let searchTimer = null;
    app.querySelectorAll("[data-duel-search]").forEach((input) => {
      input.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          const side = input.dataset.duelSearch;
          const value = input.value || "";
          if (side === "a") queryA = value;
          else queryB = value;
          refreshLaneSearch(side, value).catch(() => {});
        }, 180);
      });
    });

    // 有关键词时补拉 iTunes（本地结果已先画好）
    if (String(queryA || "").trim().length >= 2) {
      refreshLaneSearch("a", queryA).catch(() => {});
    }
    if (String(queryB || "").trim().length >= 2) {
      refreshLaneSearch("b", queryB).catch(() => {});
    }

    document.getElementById("duel-one-click")?.addEventListener("click", () => {
      startOneClick().catch(() => {});
    });
    document.getElementById("duel-custom")?.addEventListener("click", () => {
      beginCustom().catch(() => {});
    });
  };

  paint();
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
  let customPick = null;

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
      ${imgTag(song.cover || song.coverSm, {
        alt: song.title,
        className: "beef-song-cover",
        size: IMAGE_SIZES.list,
        width: 56,
        height: 56,
      })}
      <div class="beef-song-meta">
        <strong>${esc(song.title)}</strong>
        <span>${esc(song.rosterArtistName || song.artist || "")}</span>
        <em class="beef-song-label">${esc(song.labelName || "")}</em>
      </div>
    </button>`;

  const labelMembersSorted = (labelId) =>
    artistsInLabel(ARTISTS, labelId).sort((a, b) => Number(b.fans || 0) - Number(a.fans || 0));

  const tagCustomSong = (song, label, member) => ({
    id: String(song?.id || song?.neteaseId || beefSongKey(song)),
    neteaseId: song?.neteaseId ? String(song.neteaseId) : song?.id ? String(song.id) : null,
    title: song?.title || "",
    artist: song?.artist || member?.name || "",
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
    labelId: label.id,
    labelName: label.name,
    rosterArtistId: member.id,
    rosterArtistName: member.name,
  });

  const selectedForSide = (side) => (side === "a" ? customPick.selectedA : customPick.selectedB);

  const selectedMapForSide = (side) => {
    const map = new Map();
    for (const s of selectedForSide(side)) map.set(beefSongKey(s), s);
    return map;
  };

  const selectedCountByArtist = (side) => {
    const map = new Map();
    for (const s of selectedForSide(side)) {
      const key = String(s.rosterArtistId || "");
      if (!key) continue;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  };

  const currentPickLabel = () => (customPick?.side === "a" ? customPick?.labelA : customPick?.labelB);
  const currentPickMembers = () => (customPick?.side === "a" ? customPick?.membersA : customPick?.membersB);

  const closeCustomPick = () => {
    customPick = null;
    paint();
  };

  const startCustomBeef = (songsA, songsB, la, lb) => {
    state = emptyBeefState(la, lb);
    state.artistName = `${la.name} vs ${lb.name}`;
    const groups = buildBeefGroups(songsA, songsB);
    if (groups.length < BEEF_GROUP_COUNT) {
      throw new Error(`无法组成 ${BEEF_GROUP_COUNT} 组混战（A ${songsA.length} / B ${songsB.length} 首）`);
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
    enrichSongsPlaySourceProgressive(state.songs.slice(0, 8), la.name, {
      readyCount: 4,
      concurrency: 2,
    }).catch(() => {});
    paint();
  };

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
      const loadCup = async (m, opts) => {
        const limit = Math.max(1, Number(opts?.limit) || 5);
        try {
          const live = await hydrateArtist(m.id);
          if (live?.songs?.length) {
            return { ...live, songs: live.songs.slice(0, limit) };
          }
        } catch {
          /* 热门包 / KV 失败时再打网易 */
        }
        return loadArtistCup(m, opts);
      };
      const [songsA, songsB] = await Promise.all([
        loadLabelHotSongs(la, ARTISTS, {
          target: BEEF_SONGS_PER_LABEL,
          perArtist: 5,
          loadCup,
        }),
        loadLabelHotSongs(lb, ARTISTS, {
          target: BEEF_SONGS_PER_LABEL,
          perArtist: 5,
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

  const startCustomPick = () => {
    const la = getLabel(pickA);
    const lb = getLabel(pickB);
    if (!la || !lb || la.id === lb.id) {
      showToast("请选择两个不同厂牌");
      return;
    }
    const membersA = labelMembersSorted(la.id);
    const membersB = labelMembersSorted(lb.id);
    if (!membersA.length || !membersB.length) {
      showToast("厂牌成员不足，无法自定义选歌");
      return;
    }
    customPick = {
      side: "a",
      labelA: la,
      labelB: lb,
      membersA,
      membersB,
      selectedA: [],
      selectedB: [],
      view: "roster",
      focusArtist: null,
      poolSongs: [],
      expandStage: "hot50",
      expandLoading: false,
      artistLoading: false,
    };
    paint();
  };

  const openPickArtist = async (artist) => {
    if (!customPick || customPick.artistLoading) return;
    customPick.artistLoading = true;
    customPick.focusArtist = artist;
    customPick.view = "artist";
    customPick.poolSongs = [];
    customPick.expandStage = "hot50";
    paint();
    try {
      let live = null;
      try {
        live = await hydrateArtist(artist.id);
      } catch {
        /* ignore */
      }
      if (!live?.songs?.length) {
        live = await loadArtistCup(artist, { limit: TOP_N });
      }
      customPick.poolSongs = [...(live?.songs || [])];
      customPick.expandStage = customPick.poolSongs.length >= 90 ? "top100" : "hot50";
    } catch {
      showToast(`拉取 ${artist.name} 曲库失败`);
      customPick.view = "roster";
      customPick.focusArtist = null;
      customPick.poolSongs = [];
    } finally {
      customPick.artistLoading = false;
      paint();
    }
  };

  const toggleCustomSong = (rawSong) => {
    if (!customPick?.focusArtist) return;
    const side = customPick.side;
    const label = currentPickLabel();
    const tagged = tagCustomSong(rawSong, label, customPick.focusArtist);
    const key = beefSongKey(tagged);
    const selected = selectedMapForSide(side);
    if (selected.has(key)) {
      selected.delete(key);
    } else if (selected.size >= BEEF_SONGS_PER_LABEL) {
      showToast("本厂牌最多选 24 首");
      return;
    } else {
      selected.set(key, tagged);
    }
    if (side === "a") customPick.selectedA = [...selected.values()];
    else customPick.selectedB = [...selected.values()];
    paint();
  };

  const advanceCustomSide = () => {
    if (!customPick) return;
    if (customPick.side === "a") {
      if (customPick.selectedA.length !== BEEF_SONGS_PER_LABEL) {
        showToast("厂牌 A 需恰好 24 首");
        return;
      }
      customPick.side = "b";
      customPick.view = "roster";
      customPick.focusArtist = null;
      customPick.poolSongs = [];
      paint();
      return;
    }
    if (customPick.selectedB.length !== BEEF_SONGS_PER_LABEL) {
      showToast("厂牌 B 需恰好 24 首");
      return;
    }
    try {
      startCustomBeef(customPick.selectedA, customPick.selectedB, customPick.labelA, customPick.labelB);
      customPick = null;
    } catch (e) {
      showToast(e.message || "组签失败");
    }
  };

  const expandCustomArtistPool = async () => {
    if (!customPick || customPick.expandLoading || !customPick.focusArtist?.neteaseArtistId) return;
    const target = "top100";
    customPick.expandLoading = true;
    paint();
    try {
      const result = await expandArtistPool(
        customPick.poolSongs,
        customPick.focusArtist.neteaseArtistId,
        target
      );
      customPick.poolSongs = result.songs;
      customPick.expandStage = result.stage;
      customPick.expandStage = "top100";
    } catch {
      showToast("扩展曲库失败");
    } finally {
      customPick.expandLoading = false;
      paint();
    }
  };

  const paint = () => {
    // Setup picker
    if (!state || (state.phase === "loading" && !state.groups?.length)) {
      if (customPick) {
        const side = customPick.side;
        const selectedA = customPick.selectedA.length;
        const selectedB = customPick.selectedB.length;
        const sideLabel = side === "a" ? customPick.labelA : customPick.labelB;
        const members = currentPickMembers();
        const pickedMap = selectedCountByArtist(side);
        if (customPick.view === "roster") {
          app.innerHTML = shell(
            `
            <section class="beef-screen">
              <header class="beef-head">
                <h1>厂牌自定义选歌</h1>
                <p>先选满厂牌 A 的 24 首，再选厂牌 B 的 24 首，最后进入混战</p>
              </header>
              <div class="beef-pick-progress">
                <span class="${side === "a" ? "is-active" : ""}">${esc(customPick.labelA.name)} ${selectedA}/24</span>
                <span>·</span>
                <span class="${side === "b" ? "is-active" : ""}">${esc(customPick.labelB.name)} ${selectedB}/24</span>
              </div>
              <div class="beef-section-label">当前选择：${esc(sideLabel.name)}（${selectedForSide(side).length}/24）</div>
              <div class="beef-roster-grid">
                ${members
                  .map((m) => {
                    const cnt = pickedMap.get(String(m.id)) || 0;
                    return `<button type="button" class="beef-roster-card" data-pick-artist="${esc(m.id)}">
                      ${imgTag(m.avatar, {
                        alt: m.name,
                        className: "beef-roster-avatar",
                        size: IMAGE_SIZES.chip,
                        width: 52,
                        height: 52,
                      })}
                      <span class="beef-roster-name">${esc(m.name)}</span>
                      <span class="beef-roster-count">${cnt} 首</span>
                    </button>`;
                  })
                  .join("")}
              </div>
              <div class="beef-actions">
                <button type="button" class="ghost-btn" id="beef-custom-cancel">返回改厂牌</button>
                <button type="button" class="primary-btn" id="beef-custom-next" ${
                  selectedForSide(side).length === BEEF_SONGS_PER_LABEL ? "" : "disabled"
                }>${side === "a" ? "下一步：选择厂牌 B" : "开始混战"}</button>
              </div>
              <p class="hangla-toast beef-toast${toastMsg ? " is-on" : ""}" id="beef-toast" role="status">${esc(
                toastMsg
              )}</p>
            </section>
          `,
            { back: "/" }
          );
          bindBack();
          app.querySelectorAll("[data-pick-artist]").forEach((btn) => {
            btn.addEventListener("click", () => {
              const artist = members.find((m) => String(m.id) === String(btn.dataset.pickArtist));
              if (artist) openPickArtist(artist);
            });
          });
          document.getElementById("beef-custom-cancel")?.addEventListener("click", closeCustomPick);
          document.getElementById("beef-custom-next")?.addEventListener("click", advanceCustomSide);
          return;
        }

        const selectedMap = selectedMapForSide(side);
        const listSongs = customPick.poolSongs.slice(0, 100);
        const canExpand = Boolean(customPick.focusArtist?.neteaseArtistId && customPick.expandStage === "hot50");
        const expandLabel = "再展开到 Top 100";
        app.innerHTML = shell(
          `
          <section class="beef-screen">
            <header class="beef-head">
              <h1>${esc(sideLabel.name)} · ${esc(customPick.focusArtist?.name || "")}</h1>
              <p>当前厂牌已选 ${selectedForSide(side).length}/24（点击歌曲勾选）</p>
            </header>
            <div class="beef-pick-progress">
              <span class="${side === "a" ? "is-active" : ""}">${esc(customPick.labelA.name)} ${selectedA}/24</span>
              <span>·</span>
              <span class="${side === "b" ? "is-active" : ""}">${esc(customPick.labelB.name)} ${selectedB}/24</span>
            </div>
            <ul class="song-preview pick-mode">
              ${listSongs
                .map((s, i) => {
                  const tagged = tagCustomSong(s, sideLabel, customPick.focusArtist);
                  const key = beefSongKey(tagged);
                  const checked = selectedMap.has(key);
                  return `<li class="${checked ? "is-picked" : ""}" data-pick-song="${esc(key)}">
                    <input type="checkbox" class="song-pick-cb" data-pick-song="${esc(key)}" ${
                      checked ? "checked" : ""
                    } aria-label="选择 ${esc(s.title)}" />
                    ${imgTag(tagged.cover || tagged.coverSm, {
                      alt: tagged.title,
                      className: "song-cover",
                      size: IMAGE_SIZES.chip,
                      width: 36,
                      height: 36,
                    })}
                    <span class="song-preview-text">
                      <strong>${i + 1}. ${esc(tagged.title)}</strong>
                      <em>${esc(tagged.album || "单曲")}</em>
                    </span>
                  </li>`;
                })
                .join("")}
            </ul>
            ${
              canExpand
                ? `<button type="button" class="setup-expand-btn" id="beef-expand-btn" ${
                    customPick.expandLoading ? "disabled" : ""
                  }>${customPick.expandLoading ? "加载中…" : expandLabel}</button>`
                : ""
            }
            <div class="beef-actions">
              <button type="button" class="ghost-btn" id="beef-back-roster">返回厂牌歌手</button>
            </div>
            <p class="hangla-toast beef-toast${toastMsg ? " is-on" : ""}" id="beef-toast" role="status">${esc(
              toastMsg
            )}</p>
          </section>
        `,
          { back: "/" }
        );
        bindBack();
        app.querySelectorAll("[data-pick-song]").forEach((node) => {
          node.addEventListener("click", (ev) => {
            if (ev.target.closest("input")) return;
            const key = node.dataset.pickSong;
            const song = listSongs.find(
              (s) => beefSongKey(tagCustomSong(s, sideLabel, customPick.focusArtist)) === key
            );
            if (song) toggleCustomSong(song);
          });
        });
        app.querySelectorAll(".song-pick-cb[data-pick-song]").forEach((cb) => {
          cb.addEventListener("change", () => {
            const key = cb.dataset.pickSong;
            const song = listSongs.find(
              (s) => beefSongKey(tagCustomSong(s, sideLabel, customPick.focusArtist)) === key
            );
            if (song) toggleCustomSong(song);
          });
        });
        document.getElementById("beef-back-roster")?.addEventListener("click", () => {
          customPick.view = "roster";
          customPick.focusArtist = null;
          customPick.poolSongs = [];
          paint();
        });
        document.getElementById("beef-expand-btn")?.addEventListener("click", expandCustomArtistPool);
        return;
      }

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
                const boss = labelLeader(ARTISTS, l.id);
                return `<button type="button" class="label-chip${
                  pickA === l.id ? " active" : ""
                }" data-pick="a" data-label="${esc(l.id)}" ${loading ? "disabled" : ""}>
                  ${imgTag(boss?.avatar, {
                    alt: l.name,
                    className: "label-chip-avatar",
                    size: IMAGE_SIZES.chip,
                    width: 40,
                    height: 40,
                  })}
                  <span class="label-chip-text">
                    <strong>${esc(l.name)}</strong>
                    <span>${n} 人${l.city ? ` · ${esc(l.city)}` : ""}</span>
                  </span>
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
                const boss = labelLeader(ARTISTS, l.id);
                return `<button type="button" class="label-chip${
                  pickB === l.id ? " active" : ""
                }" data-pick="b" data-label="${esc(l.id)}" ${loading ? "disabled" : ""}>
                  ${imgTag(boss?.avatar, {
                    alt: l.name,
                    className: "label-chip-avatar",
                    size: IMAGE_SIZES.chip,
                    width: 40,
                    height: 40,
                  })}
                  <span class="label-chip-text">
                    <strong>${esc(l.name)}</strong>
                    <span>${n} 人${l.city ? ` · ${esc(l.city)}` : ""}</span>
                  </span>
                </button>`;
              }).join("")}
            </div>
          </div>
          <div class="beef-actions">
            <button type="button" class="primary-btn" id="beef-start" ${
              loading || !pickA || !pickB || pickA === pickB ? "disabled" : ""
            }>${loading ? "正在抽取曲库…" : "开始混战（48 首）"}</button>
            <button type="button" class="ghost-btn" id="beef-custom" ${
              loading || !pickA || !pickB || pickA === pickB ? "disabled" : ""
            }>自定义选歌</button>
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
      document.getElementById("beef-custom")?.addEventListener("click", () => startCustomPick());
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
      const revivalNeed = beefRevivalTarget(state.advanced);
      const thru = state.advanced?.length || 0;
      app.innerHTML = shell(
        `
        <section class="beef-screen">
          <header class="beef-head">
            <h1>败者复活</h1>
            <p>直通 ${thru} 首，再从落选 ${state.revivalPool.length} 首里复活 ${revivalNeed} 首 → 凑齐 32 强</p>
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
              state.revivalPicks.length === revivalNeed ? "" : "disabled"
            }>进入 32 强（已选 ${state.revivalPicks.length}/${revivalNeed}）</button>
          </div>
          <p class="hangla-toast beef-toast" id="beef-toast" role="status"></p>
        </section>
      `,
        { back: "/" }
      );
      bindBack();
      app.querySelectorAll("[data-song]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const res = toggleRevivalPick(
            state.revivalPicks,
            state.revivalPool,
            btn.dataset.song,
            revivalNeed
          );
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
          trackEvent("cup_start");
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
    const revivalNeed = beefRevivalTarget(advanced);
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
        sub: `直通 ${advanced.length} 首 · 落选 ${revivalPool.length} 首再复活 ${revivalNeed} 首`,
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
      ${imgTag(artist.avatar, {
        alt: artist.name,
        className: "hangla-chip-avatar",
        size: IMAGE_SIZES.chip,
        width: 28,
        height: 28,
      })}
      <span class="hangla-chip-name">${esc(artist.name)}</span>
    </button>
  `;
}

function hangLaBlindCard(artist) {
  if (!artist) return `<p class="hangla-empty">全部排完了</p>`;
  return `
    <div class="hangla-blind-card" data-hangla-id="${esc(artist.id)}">
      ${imgTag(artist.avatar, {
        alt: artist.name,
        className: "hangla-blind-avatar",
        size: IMAGE_SIZES.list,
        loading: "eager",
        width: 72,
        height: 72,
      })}
      <div class="hangla-blind-meta">
        <strong>${esc(artist.name)}</strong>
        <span>${esc(artist.city || artist.tag || "Rapper")}${artist.fans ? ` · ${Number(artist.fans).toLocaleString("zh-CN")} 粉` : ""}</span>
      </div>
    </div>
  `;
}

/** 歌手大比拼：华语/欧美 + 粉丝门槛 → 随机最多 32 人单败淘汰 */
function renderArtistPk() {
  let fanFilterId = "any";
  let regionFilterId = "cn";
  /** @type {any[] | null} */
  let cachedArtistRank = null;
  let rankLoadToken = 0;

  const fanLabel = () => fanFilterMeta(fanFilterId).label;
  const regionLabel = () => regionFilterMeta(regionFilterId).label;

  const poolArtists = () => {
    const fan = fanFilterMeta(fanFilterId);
    return filterArtistsByMinFans(
      filterArtistsByRegion(ARTISTS, regionFilterId),
      fan.minFans
    ).filter((a) => /^\d+$/.test(String(a.neteaseArtistId || "")));
  };

  const startCup = () => {
    const fan = fanFilterMeta(fanFilterId);
    const roster = ARTISTS.filter((a) => /^\d+$/.test(String(a.neteaseArtistId || "")));
    const drawn = drawHangLaField(roster, ARTIST_PK_COUNT, {
      minFans: fan.minFans,
      region: regionFilterId,
    });
    if (drawn.length < 4) {
      showToast("当前档位歌手不足 4 位，请放宽粉丝门槛或换范围");
      return false;
    }
    const size = nearestFieldSize(drawn.length, { min: 4, max: ARTIST_PK_COUNT });
    const fieldArtists = drawn.slice(0, size);
    const songs = artistsToPkSongs(fieldArtists);
    const bracket = buildBracket(songs, { mode: "battle", max: size, field: songs });
    const region = regionFilterMeta(regionFilterId);
    const state = {
      cupType: "artist-cup",
      artistId: "",
      artistName: `歌手大比拼 · ${region.label}`,
      artistSearch: "",
      artistAvatar: fieldArtists[0]?.avatar || "",
      neteaseArtistId: "",
      regionFilterId,
      fanFilterId,
      bracket,
      createdAt: new Date().toISOString(),
    };
    saveState(state);
    trackEvent("cup_start");
    navigate("/play");
    return true;
  };

  const showToast = (msg) => {
    const el = document.getElementById("artist-pk-toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("is-on");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("is-on"), 2200);
  };

  const renderChampPreview = (items) => {
    const top = (items || []).slice(0, 10);
    if (!top.length) {
      return `<p class="artist-pk-rank-empty">暂无夺冠数据 · 打完一场后就会上榜</p>`;
    }
    return `
      <ol class="artist-pk-rank-list">
        ${top
          .map((item, i) => {
            const rank = i + 1;
            const rankClass = rank <= 3 ? ` top${rank}` : "";
            return `
              <li class="artist-pk-rank-row">
                <span class="artist-pk-rank-num${rankClass}">${rank}</span>
                ${imgTag(item.avatar || item.cover, {
                  alt: item.name,
                  className: "artist-pk-rank-avatar",
                  size: IMAGE_SIZES.list,
                  width: 40,
                  height: 40,
                })}
                <div class="artist-pk-rank-meta">
                  <strong>${esc(item.name || "未知歌手")}</strong>
                  <span>夺冠 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次</span>
                </div>
              </li>`;
          })
          .join("")}
      </ol>`;
  };

  const paintChampBoard = async () => {
    const box = document.getElementById("artist-pk-rank-board");
    if (!box) return;
    const token = ++rankLoadToken;
    box.innerHTML = `<p class="loading-line">加载歌手夺冠榜…</p>`;
    try {
      if (!cachedArtistRank) {
        const data = await fetchArtistPkRank({ limit: 200 });
        cachedArtistRank = data.items || [];
      }
      if (token !== rankLoadToken) return;
      const filtered = filterRankItemsByRegion(
        cachedArtistRank,
        regionFilterId === "west" ? "west" : "cn",
        "artists"
      );
      box.innerHTML = renderChampPreview(filtered);
    } catch {
      if (token !== rankLoadToken) return;
      box.innerHTML = `<p class="artist-pk-rank-empty">榜单暂时加载失败 · 仍可直接开赛</p>`;
    }
  };

  const paint = () => {
    const count = poolArtists().length;
    const drawN = Math.min(ARTIST_PK_COUNT, nearestFieldSize(Math.max(count, 4), { max: ARTIST_PK_COUNT }));
    const canStart = count >= 4;
    app.innerHTML = shell(
      `
      <section class="hangla-screen">
        <header class="hangla-head">
          <h1>歌手大比拼</h1>
          <p>随机抽最多 ${ARTIST_PK_COUNT} 位 · 两两 PK · 冠军计入歌手夺冠榜</p>
        </header>
        <div class="hangla-setup">
          <div class="hangla-section-label">抽签范围</div>
          <div class="filter-row sort-row" id="artist-pk-region-row" role="group" aria-label="抽签范围">
            ${HANG_LA_REGION_FILTERS.map(
              (f) => `
              <button type="button" class="mode-chip hangla-region-chip${f.id === regionFilterId ? " active" : ""}" data-region-filter="${f.id}">
                ${esc(f.label)}
              </button>`
            ).join("")}
          </div>
          <div class="hangla-section-label">网易云粉丝最低要求</div>
          <div class="filter-row sort-row" id="artist-pk-fan-row" role="group" aria-label="粉丝门槛">
            ${HANG_LA_FAN_FILTERS.map(
              (f) => `
              <button type="button" class="mode-chip${f.id === fanFilterId ? " active" : ""}" data-fan-filter="${f.id}">
                ${esc(f.label)}
              </button>`
            ).join("")}
          </div>
          <p class="hangla-setup-hint">先定好范围与粉丝档，再开赛；不足 ${ARTIST_PK_COUNT} 人时自动降到最接近的 2 的幂（最少 4 人）。</p>
          <p class="hangla-setup-meta">当前池子（${esc(regionLabel())} · ${esc(fanLabel())}）约 <strong>${count}</strong> 位 · 将随机抽取 ${canStart ? Math.min(drawN, count) : "—"} 人</p>
          <div class="hangla-actions">
            <button type="button" class="primary-btn" id="artist-pk-start" ${canStart ? "" : "disabled"}>开始比拼</button>
          </div>
        </div>

        <section class="artist-pk-rank" aria-labelledby="artist-pk-rank-title">
          <div class="artist-pk-rank-head">
            <div>
              <h2 id="artist-pk-rank-title">歌手夺冠榜</h2>
              <p>按本站夺冠次数排行 · 选出最好的 Rapper</p>
            </div>
            <a class="ghost-btn artist-pk-rank-more" href="#/rank/artists-pk">完整榜单</a>
          </div>
          <div id="artist-pk-rank-board" class="artist-pk-rank-board">
            <p class="loading-line">加载歌手夺冠榜…</p>
          </div>
        </section>
        <p class="hangla-toast" id="artist-pk-toast" role="status"></p>
      </section>
    `,
      {
        back: "/",
        actions: `<a class="ghost-btn rank-link" href="#/rank/artists-pk">歌手PK榜</a>`,
      }
    );
    bindBack();

    document.querySelectorAll("#artist-pk-region-row [data-region-filter]").forEach((chip) => {
      chip.addEventListener("click", () => {
        regionFilterId = chip.dataset.regionFilter || "cn";
        paint();
      });
    });
    document.querySelectorAll("#artist-pk-fan-row [data-fan-filter]").forEach((chip) => {
      chip.addEventListener("click", () => {
        fanFilterId = chip.dataset.fanFilter || "any";
        paint();
      });
    });
    document.getElementById("artist-pk-start")?.addEventListener("click", () => {
      startCup();
    });

    paintChampBoard();
  };

  paint();
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
                                size: IMAGE_SIZES.chip,
                                width: 28,
                                height: 28,
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
      // 计入最夯 / 最拉榜（防刷限额与单曲夺冠共用）
      const toEntry = (id) => {
        const a = findArtist(state.field, id);
        return {
          artistId: id,
          name: a?.name || id,
          avatar: a?.avatar || "",
        };
      };
      reportHangLaRound({
        hang: (state.tiers.hang || []).map(toEntry),
        lale: (state.tiers.lale || []).map(toEntry),
      }).catch(() => {});
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
    artist = await hydrateArtist(artistId);
  } catch (e) {
    const msg = String(e?.message || e || "");
    const offlineHint =
      /Failed to fetch|NetworkError|HTTP 5\d\d|unavailable/i.test(msg)
        ? base.source === "itunes"
          ? "连不上 iTunes 接口，请检查网络后重试"
          : "连不上音乐接口，请稍后重试"
        : msg;
    app.innerHTML = shell(
      `<section class="setup"><p class="loading-line">拉取失败：${esc(offlineHint)}</p></section>`,
      { back: "/" }
    );
    bindBack();
    return;
  }

  const canExpand =
    artist.source !== "itunes" && /^\d+$/.test(String(artist.neteaseArtistId || ""));
  let poolSongs = [...(artist.songs || [])];
  /** @type {"hot50"|"top100"|"all"} */
  let expandStage = poolSongs.length >= 90 ? "top100" : "hot50";
  let expandLoading = false;
  let pickMode = false;
  /** @type {Set<string>} */
  let selectedIds = new Set();

  const fieldSize = () =>
    nearestFieldSize(Math.min(poolSongs.length, FIELD_MAX), { max: FIELD_MAX });
  let mode = "battle";
  let fieldSongs = buildField(poolSongs, { mode, max: FIELD_MAX });

  const setupToast = (msg) => {
    let el = document.getElementById("setup-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "setup-toast";
      el.className = "setup-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2200);
  };

  const syncArtistPool = () => {
    artist.songs = poolSongs;
    artistCache.set(artist.id, artist);
  };

  const selectedSongsInPoolOrder = () =>
    poolSongs.filter((s) => selectedIds.has(songKey(s)));

  const startCupWithField = (cupField) => {
    const aliases = [artist.search, artist.neteaseArtistName].filter(Boolean);
    const bracket = buildBracket(poolSongs, {
      mode,
      max: FIELD_MAX,
      field: cupField,
    });
    trackEvent("cup_start");
    saveState({
      artistId: artist.id,
      artistName: artist.name,
      artistAvatar: artist.avatar || "",
      neteaseArtistId: artist.neteaseArtistId || "",
      artistSearch: artist.search || "",
      playSourceReady: 0,
      bracket,
    });
    navigate("/bracket");
    enrichSongsPlaySourceProgressive(cupField, artist.name, {
      concurrency: 2,
      artistAliases: aliases,
      mapArtistId: artist.id,
      readyCount: 4,
      onSong: (song) => {
        const st = loadState();
        if (!st?.bracket) return;
        st.bracket = patchPlaySourceInBracket(st.bracket, song);
        saveState(st);
      },
    })
      .then(({ background }) => background)
      .then((all) => {
        const st = loadState();
        if (!st?.bracket || !all?.length) return;
        let next = st.bracket;
        for (const song of all) next = patchPlaySourceInBracket(next, song);
        const itunesN = all.filter((x) => x.playSource === "itunes").length;
        saveState({
          ...st,
          bracket: next,
          playSourceStats: { itunes: itunesN, total: all.length },
          playSourceReady: all.length,
        });
      })
      .catch(() => {});
  };

  const paint = () => {
    const size = fieldSize();
    const pickCount = selectedIds.size;
    const pickReady = pickCount === FIELD_MAX;
    // 始终展示完整曲库；一键开赛仍只取热度前 size 首
    const listSongs = poolSongs;
    const fieldKeySet = new Set(
      (pickMode ? [...selectedIds] : poolSongs.slice(0, size).map((s) => songKey(s))).filter(Boolean)
    );
    const expandLabel =
      expandStage === "hot50"
        ? "再展开到 Top 100"
        : expandStage === "top100"
          ? "展示全部歌曲"
          : "";
    const showExpand = canExpand && expandStage !== "all" && !!expandLabel;

    app.innerHTML = shell(
      `
      <section class="setup">
        <div class="setup-head setup-head-with-avatar">
          ${imgTag(artist.avatar, {
            alt: artist.name,
            className: "setup-avatar",
            size: IMAGE_SIZES.setup,
            loading: "eager",
            fetchPriority: "high",
            width: 120,
            height: 120,
          })}
          <div>
            <h1>${esc(artist.name)}</h1>
            <p>${esc(artist.city)} · ${esc(artist.tag)} · 曲库 ${poolSongs.length} 首 · ${size} 强</p>
          </div>
        </div>
        <div class="section-title">对阵玩法</div>
        <div class="mode-row">
          <button type="button" class="mode-chip ${mode === "battle" ? "active" : ""}" data-mode="battle">1v1 Battle</button>
          <button type="button" class="mode-chip ${mode === "hot" ? "active" : ""}" data-mode="hot">热门顺序</button>
        </div>
        ${
          pickMode
            ? `<div class="pick-status ${pickReady ? "is-ready" : ""}" id="pick-status">已选曲目：(${pickCount}/${FIELD_MAX})</div>`
            : ""
        }
        <div class="setup-actions">
          ${
            pickMode
              ? `<button type="button" class="primary-btn" id="custom-start-btn" ${
                  pickReady ? "" : "disabled"
                }>生成专属签表并开赛</button>
                 <button type="button" class="ghost-btn" id="pick-toggle-btn">取消自组</button>
                 ${
                   mode === "battle" && pickReady
                     ? `<button type="button" class="ghost-btn" id="reshuffle-pick-btn">打乱已选对位</button>`
                     : ""
                 }`
              : `<button type="button" class="primary-btn" id="start-btn">一键开赛 · ${size} 强</button>
                 <button type="button" class="ghost-btn" id="pick-toggle-btn">自组${FIELD_MAX}强</button>
                 ${
                   mode === "battle"
                     ? `<button type="button" class="ghost-btn" id="reshuffle-btn">再打乱一次</button>`
                     : ""
                 }`
          }
        </div>
        <div class="section-title">${
          pickMode
            ? `自组选歌（曲库 ${poolSongs.length} 首）`
            : `曲库列表（一键开赛取热度前 ${size} / 共 ${poolSongs.length}）`
        }</div>
        <ul class="song-preview ${pickMode ? "pick-mode" : "pool-mode"}">
          ${listSongs
            .map((s, i) => {
              const key = songKey(s);
              const checked = selectedIds.has(key);
              const inField = !pickMode && fieldKeySet.has(key);
              const vsHint =
                !pickMode &&
                mode === "battle" &&
                i < size &&
                i % 2 === 0 &&
                listSongs[i + 1] &&
                i + 1 < size
                  ? ` · vs ${esc(listSongs[i + 1].title)}`
                  : "";
              return `
              <li class="${
                pickMode && checked ? "is-picked" : inField ? "in-field" : ""
              }" ${pickMode ? `data-pick="${esc(key)}"` : ""}>
                ${
                  pickMode
                    ? `<input type="checkbox" class="song-pick-cb" data-pick-id="${esc(
                        key
                      )}" ${checked ? "checked" : ""} aria-label="选择 ${esc(s.title)}" />`
                    : inField
                      ? `<span class="song-field-tag">签</span>`
                      : `<span class="song-field-tag muted">${i + 1}</span>`
                }
                ${imgTag(coverUrl(s, artist.avatar), {
                  alt: s.title,
                  className: "song-cover",
                  size: IMAGE_SIZES.chip,
                  width: 36,
                  height: 36,
                })}
                <span class="song-preview-text">
                  <strong>${i + 1}. ${esc(s.title)}</strong>
                  <em>${esc(s.album || "单曲")}${vsHint}${
                    inField && !pickMode ? " · 将参赛" : ""
                  }${
                    s.playSource === "itunes"
                      ? " · Apple"
                      : s.playSource === "netease"
                        ? " · 网易云"
                        : ""
                  }</em>
                </span>
              </li>`;
            })
            .join("")}
        </ul>
        ${
          showExpand
            ? `<button type="button" class="setup-expand-btn" id="expand-btn" ${
                expandLoading ? "disabled" : ""
              }>${expandLoading ? "加载中…" : expandLabel}</button>`
            : ""
        }
      </section>
    `,
      { back: "/" }
    );
    bindBack();

    app.querySelectorAll("[data-mode]").forEach((chip) => {
      chip.addEventListener("click", () => {
        mode = chip.dataset.mode;
        if (!pickMode) {
          fieldSongs = buildField(poolSongs, { mode, max: FIELD_MAX });
        }
        paint();
      });
    });

    document.getElementById("pick-toggle-btn")?.addEventListener("click", () => {
      if (pickMode) {
        pickMode = false;
        selectedIds = new Set();
        fieldSongs = buildField(poolSongs, { mode, max: FIELD_MAX });
      } else {
        pickMode = true;
        selectedIds = new Set(fieldSongs.map((s) => songKey(s)).filter(Boolean));
      }
      paint();
    });

    document.getElementById("reshuffle-btn")?.addEventListener("click", () => {
      fieldSongs = buildField(poolSongs, { mode: "battle", max: FIELD_MAX });
      paint();
    });

    document.getElementById("reshuffle-pick-btn")?.addEventListener("click", () => {
      const picked = selectedSongsInPoolOrder();
      if (picked.length !== FIELD_MAX) {
        setupToast(`请确保选中刚好 ${FIELD_MAX} 首单曲`);
        return;
      }
      artist._pickShuffle = pickSongs(picked, "battle");
      setupToast("已打乱对位，开赛时生效");
      paint();
    });

    const togglePick = (key) => {
      if (!key) return;
      if (selectedIds.has(key)) {
        selectedIds.delete(key);
        artist._pickShuffle = null;
        paint();
        return;
      }
      if (selectedIds.size >= FIELD_MAX) {
        setupToast(`最多选 ${FIELD_MAX} 首`);
        return;
      }
      selectedIds.add(key);
      artist._pickShuffle = null;
      paint();
    };

    app.querySelectorAll(".song-pick-cb").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        e.stopPropagation();
        const key = cb.dataset.pickId;
        if (cb.checked) {
          if (selectedIds.size >= FIELD_MAX && !selectedIds.has(key)) {
            cb.checked = false;
            setupToast(`最多选 ${FIELD_MAX} 首`);
            return;
          }
          selectedIds.add(key);
        } else {
          selectedIds.delete(key);
        }
        artist._pickShuffle = null;
        paint();
      });
    });
    app.querySelectorAll("li[data-pick]").forEach((li) => {
      li.addEventListener("click", (e) => {
        if (e.target.closest(".song-pick-cb")) return;
        togglePick(li.dataset.pick);
      });
    });

    document.getElementById("start-btn")?.addEventListener("click", () => {
      const btn = document.getElementById("start-btn");
      btn.disabled = true;
      try {
        startCupWithField(fieldSongs);
      } catch (e) {
        btn.disabled = false;
        alert(`开赛失败：${e.message || e}`);
      }
    });

    document.getElementById("custom-start-btn")?.addEventListener("click", () => {
      const btn = document.getElementById("custom-start-btn");
      const picked =
        artist._pickShuffle?.length === FIELD_MAX
          ? artist._pickShuffle
          : pickSongs(selectedSongsInPoolOrder(), mode);
      if (picked.length !== FIELD_MAX) {
        setupToast(`请确保选中刚好 ${FIELD_MAX} 首单曲`);
        return;
      }
      btn.disabled = true;
      try {
        startCupWithField(picked);
      } catch (e) {
        btn.disabled = false;
        alert(`开赛失败：${e.message || e}`);
      }
    });

    document.getElementById("expand-btn")?.addEventListener("click", async () => {
      if (!canExpand || expandLoading || expandStage === "all") return;
      const target = expandStage === "hot50" ? "top100" : "all";
      expandLoading = true;
      paint();
      try {
        const result = await expandArtistPool(poolSongs, artist.neteaseArtistId, target);
        poolSongs = result.songs;
        expandStage = result.stage;
        if (result.stage === "top100" && !result.more) {
          expandStage = "all";
        }
        syncArtistPool();
        if (!pickMode) {
          fieldSongs = buildField(poolSongs, { mode, max: FIELD_MAX });
        }
        putArtistTopCache({
          ...artist,
          songs: poolSongs.slice(0, 100),
        });
        setupToast(
          target === "top100"
            ? `已展开到 ${poolSongs.length} 首`
            : `已加载全部 ${poolSongs.length} 首`
        );
      } catch (e) {
        setupToast(e.message || "扩库失败，请稍后重试");
      } finally {
        expandLoading = false;
        paint();
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
  // 已判定过音源就直接用（iTunes / 网易云都算已决议），避免点试听重复打接口
  if (song.playSource === "itunes" && song.previewUrl) return song;
  if (song.playSource === "netease") return song;
  const aliases = [state.artistSearch, state.artistName, song.rosterArtistName].filter(Boolean);
  const resolved = await resolvePlaySource(song, state.artistName, {
    artistAliases: aliases,
    mapArtistId: song.rosterArtistId || state.artistId || "",
  });
  const nextBracket = patchPlaySourceInBracket(state.bracket, resolved);
  const next = { ...state, bracket: nextBracket };
  saveState(next);
  return resolved;
}

/** 对战页预取双边音源，点试听时尽量秒开 */
function prefetchMatchPlaySources(state, match) {
  if (!state?.bracket || !match) return;
  for (const side of [match.a, match.b]) {
    if (!side) continue;
    if (side.playSource === "itunes" || side.playSource === "netease") continue;
    ensureSongPlaySource(state, side).catch(() => {});
  }
}

function isSameSong(a, b) {
  const ka = songKey(a);
  const kb = songKey(b);
  return Boolean(ka && kb && ka === kb);
}

function bracketSlot(
  song,
  fallbackAvatar,
  { onPath = false, won = null, roundIndex = -1, wing = "" } = {}
) {
  if (!song) {
    return `<div class="bracket-slot is-empty"><span>待定</span></div>`;
  }
  const pathCls = onPath ? " on-path" : "";
  const resultCls =
    won === true ? " is-winner" : won === false ? " is-loser" : "";
  const pathAttrs = onPath
    ? ` data-path-round="${roundIndex}" data-path-wing="${esc(wing)}"`
    : "";
  return `
    <div class="bracket-slot${pathCls}${resultCls}" title="${esc(song.title)}"${pathAttrs}>
      ${imgTag(coverUrl(song, fallbackAvatar), {
        alt: song.title,
        className: "bracket-slot-cover",
        size: IMAGE_SIZES.chip,
        width: 24,
        height: 24,
      })}
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
                won: m.winner ? isSameSong(m.a, m.winner) : null,
                roundIndex,
                wing: side,
              })}
              ${bracketSlot(m.b, fallbackAvatar, {
                onPath: isSameSong(m.b, champ),
                won: m.winner ? isSameSong(m.b, m.winner) : null,
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
    ? `--artist-bg:url('${optimizedImageUrl(fallbackAvatar, { size: IMAGE_SIZES.setup }).replace(/'/g, "%27")}');`
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
            size: IMAGE_SIZES.match,
            loading: "eager",
            fetchPriority: "high",
            width: 160,
            height: 160,
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
              won: finalMatch.winner
                ? isSameSong(finalMatch.a, finalMatch.winner)
                : champ
                  ? isSameSong(finalMatch.a, champ)
                  : null,
              roundIndex: finalIndex,
              wing: "center",
            })}
            ${bracketSlot(finalMatch.b, fallbackAvatar, {
              onPath: isSameSong(finalMatch.b, champ),
              won: finalMatch.winner
                ? isSameSong(finalMatch.b, finalMatch.winner)
                : champ
                  ? isSameSong(finalMatch.b, champ)
                  : null,
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
    <linearGradient id="champ-path-grad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#8fbf20" stop-opacity="1"/>
      <stop offset="100%" stop-color="#8fbf20" stop-opacity="1"/>
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
    svg.appendChild(line);
  }

  board.appendChild(svg);
}

/**
 * Scale bracket board into fit box without asymmetric clip.
 * Uses top-left origin + margin centering so overflow:hidden keeps both wings.
 */
function fitBracketBoard(fit, board, { pad = 0.96, maxAvailH } = {}) {
  if (!fit || !board) return 1;

  board.style.transform = "none";
  board.style.left = "";
  board.style.marginLeft = "0";
  board.style.marginRight = "0";
  board.style.marginBottom = "0";
  fit.style.height = "";

  const parentW = fit.parentElement?.getBoundingClientRect().width || window.innerWidth;
  const availW = Math.min(
    fit.getBoundingClientRect().width || fit.clientWidth || parentW,
    parentW,
    window.innerWidth - 8
  );
  const availH =
    maxAvailH ??
    (Math.min(
      fit.clientHeight || 0,
      Math.max(280, window.innerHeight - (window.innerWidth <= 720 ? 160 : 200))
    ) || Math.max(280, window.innerHeight - 200));
  const needW = Math.max(board.scrollWidth, 1);
  const needH = Math.max(board.scrollHeight, 1);
  const scale = Math.min(availW / needW, availH / needH, 1) * pad;
  const visualW = needW * scale;
  const visualH = needH * scale;

  board.style.transformOrigin = "top left";
  board.style.transform = `scale(${scale})`;
  board.style.marginLeft = `${Math.max(0, (availW - visualW) / 2)}px`;
  // reclaim unused layout space created by CSS transform (layout stays at needW×needH)
  board.style.marginRight = `${visualW - needW}px`;
  board.style.marginBottom = `${visualH - needH}px`;
  fit.style.height = `${Math.ceil(visualH + 4)}px`;
  fit.style.minHeight = `${Math.ceil(visualH + 4)}px`;

  requestAnimationFrame(() => drawChampionPathChain(board));
  return scale;
}

function fitBracketToScreen() {
  const fit = document.getElementById("bracket-fit");
  const board = document.getElementById("bracket-board");
  if (!fit || !board) return;
  const pad = window.innerWidth <= 720 ? 0.88 : 0.98;
  fitBracketBoard(fit, board, { pad });
}

function renderBracketPreview(state) {
  const avatar = state.artistAvatar || "";
  const size = state.bracket.size;
  let cancelled = false;
  let pollTimer = null;
  let started = false;

  void getShareCardModule()
    .then((mod) => mod.warmShareCovers(state))
    .catch(() => {});

  app.innerHTML = shell(
    `
    <section class="bracket-preview">
      <div class="bracket-preview-head">
        ${imgTag(avatar, {
          alt: state.artistName,
          className: "setup-avatar",
          size: IMAGE_SIZES.setup,
          loading: "eager",
          width: 120,
          height: 120,
        })}
        <div class="bracket-preview-copy">
          <h1 class="bracket-title-fx"><span class="rapper-name">${esc(state.artistName)} · ${size} 强对阵图</span></h1>
        </div>
      </div>
      ${renderBracketHtml(state.bracket, avatar)}
      <div class="countdown-overlay is-ready" id="countdown-overlay" aria-live="polite">
        <p class="bracket-ready-hint" id="bracket-ready-hint">准备开赛！</p>
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
    if (pollTimer) clearTimeout(pollTimer);
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

  const goPlay = () => {
    if (cancelled || started) return;
    started = true;
    const overlay = document.getElementById("countdown-overlay");
    overlay?.classList.add("is-out");
    setTimeout(() => {
      if (cancelled) return;
      cleanup();
      navigate("/play");
    }, 320);
  };

  const began = Date.now();
  const tickReady = () => {
    if (cancelled || started) return;
    const latest = loadState() || state;
    const ready = Number(latest.playSourceReady || 0);
    const waited = Date.now() - began;
    // 有至少 4 首播放源，或最多等约 2.8s，避免卡死
    if (ready >= 4 || waited >= 2800) {
      goPlay();
      return;
    }
    pollTimer = setTimeout(tickReady, 180);
  };
  pollTimer = setTimeout(tickReady, 400);
}

function renderMatchCoopHintHtml() {
  return `<span class="match-coop-hint">欢迎有想法的人一起<button type="button" class="match-coop-link" data-about-site>合作</button>！</span>`;
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
  const isDuel = state.cupType === "duel-king";
  const isArtistCup = state.cupType === "artist-cup";
  const avatar = state.artistAvatar || "";
  const duelA = state.duelArtists?.[0];
  const duelB = state.duelArtists?.[1];
  const duelScores = isDuel ? duelAliveScores(state.bracket) : null;
  const scoreSongs = isBeef
    ? songsAliveInBracket(state.bracket)
    : [];
  const scores = isBeef ? labelScoreFromSongs(scoreSongs, state.labels || []) : null;
  const la = state.labels?.[0];
  const lb = state.labels?.[1];
  const scoreA = isDuel ? duelScores?.a || 0 : la ? scores?.[la.id] || 0 : 0;
  const scoreB = isDuel ? duelScores?.b || 0 : lb ? scores?.[lb.id] || 0 : 0;
  const totalScore = Math.max(1, scoreA + scoreB);
  const barNameA = isDuel ? duelA?.name || "A" : la?.name || "A";
  const barNameB = isDuel ? duelB?.name || "B" : lb?.name || "B";
  preloadMatchCover(coverUrl(match.a, avatar), { priority: "high" });
  preloadMatchCover(coverUrl(match.b, avatar), { priority: "high" });
  prefetchUpcomingMatchCovers(state, match, avatar);

  const backHref = isBeef
    ? "/label-beef"
    : isDuel
      ? "/duel-king"
      : isArtistCup
        ? "/artist-pk"
        : `/artist/${state.artistId}`;

  app.innerHTML = shell(
    `
    <section class="match-screen">
      <div class="match-meta">
        ${
          isBeef || isArtistCup || isDuel
            ? `<div class="beef-match-brand" aria-hidden="true">${
                isArtistCup ? "PK" : isDuel ? "1v1" : "⚔"
              }</div>`
            : imgTag(avatar, {
                alt: state.artistName,
                className: "match-artist-avatar",
                size: IMAGE_SIZES.chip,
                loading: "eager",
                width: 36,
                height: 36,
              })
        }
        <div>
          <strong>${esc(label)}</strong>
          <div class="match-meta-sub">
            <span>${esc(
              isBeef
                ? `${la?.name || "A"} vs ${lb?.name || "B"}`
                : isDuel
                  ? `${duelA?.name || "A"} vs ${duelB?.name || "B"}`
                  : state.artistName || ""
            )}</span>
            <span>进度 ${progressText(state.bracket)}</span>
            ${renderMatchCoopHintHtml()}
          </div>
        </div>
      </div>
      ${
        (isBeef && la && lb) || isDuel
          ? `<div class="beef-scorebar${isDuel ? " duel-scorebar" : ""}" aria-label="曲目存活">
              <div class="beef-scorebar-names">
                <span>${esc(barNameA)} ${scoreA}</span>
                <span>${scoreB} ${esc(barNameB)}</span>
              </div>
              <div class="beef-scorebar-track">
                <i style="width:${(scoreA / totalScore) * 100}%"></i>
                <b style="width:${(scoreB / totalScore) * 100}%"></b>
              </div>
            </div>`
          : ""
      }
      <div class="vs-grid">
        ${pickButton("a", match.a, avatar, { artistCup: isArtistCup })}
        <div class="vs-mark">VS</div>
        ${pickButton("b", match.b, avatar, { artistCup: isArtistCup })}
      </div>
      ${isArtistCup ? "" : `<div id="player-mount" class="player-mount"></div>`}
    </section>
  `,
    {
      back: backHref,
    }
  );
  bindBack();

  const player = isArtistCup
    ? null
    : createPlayer(document.getElementById("player-mount"));
  let previewReq = 0;
  // 进入对战时后台预取 A/B 音源，减轻点试听等待
  if (!isArtistCup) prefetchMatchPlaySources(state, match);
  upgradeProgressiveCovers(app);

  if (!isArtistCup) {
    app.querySelectorAll("[data-preview]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const side = btn.dataset.preview;
        const raw = side === "a" ? match.a : match.b;
        const latest = loadState() || state;
        const req = ++previewReq;
        const prevLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = "匹配中…";
        try {
          const song = await ensureSongPlaySource(latest, raw);
          if (req !== previewReq) return;
          await player.load(song, {
            autoplay: true,
            artistName: song.rosterArtistName || latest.artistName || "",
            artistAliases: [latest.artistSearch, song.rosterArtistName].filter(Boolean),
            mapArtistId: song.rosterArtistId || latest.artistId || "",
          });
        } finally {
          if (req === previewReq) {
            btn.disabled = false;
            btn.textContent = prevLabel || "试听";
          }
        }
      });
    });
  }

  app.querySelectorAll("[data-side]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // ignore clicks that bubbled from preview
      if (e.target.closest("[data-preview]")) return;
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add("is-picking");
      const pickedSide = btn.dataset.side;
      runAfterNextPaint(() => {
        previewReq += 1;
        player?.stop();
        stopAllPageAudio();
        const roundIdx = findRoundIndex(state.bracket, match.id);
        let nextBracket = chooseWinner(state.bracket, match.id, pickedSide);
        if (
          state.cupType === "duel-king" &&
          roundIdx >= 0 &&
          isRoundComplete(nextBracket, roundIdx)
        ) {
          nextBracket = rebalanceRoundForAb(nextBracket, roundIdx);
        }
        const next = { ...state, bracket: nextBracket };
        saveState(next);
        if (nextBracket.champion) {
          goChampAfterWin(next);
          return;
        }
        // 本轮全部打完 → 弹出下一轮环节动画（32→16、16→8…）
        if (roundIdx >= 0 && isRoundComplete(nextBracket, roundIdx)) {
          const splash = splashForBracket(
            nextBracket,
            isArtistCup
              ? { subject: "位歌手", pickHint: "一位" }
              : { subject: "首歌", pickHint: "一首" }
          );
          if (splash) {
            showRoundSplash(splash, () => renderMatch(next));
            return;
          }
        }
        renderMatch(next);
      });
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

function resolveDuelChampArtist(state, champ) {
  const rosterId = String(champ?.rosterArtistId || "");
  const rosterName = String(champ?.rosterArtistName || "").trim();
  const hit = (state?.duelArtists || []).find(
    (a) =>
      String(a.id) === rosterId ||
      String(a.neteaseArtistId || "") === rosterId ||
      (rosterName && String(a.name || "") === rosterName)
  );
  const artistId = String(
    hit?.neteaseArtistId || hit?.id || champ?.rosterArtistId || ""
  ).trim();
  return {
    artistId,
    name: rosterName || hit?.name || "",
    avatar: hit?.avatar || champ?.cover || champ?.coverSm || "",
  };
}

/**
 * 决出冠军 →「冠军诞生」→（若撞上 ×100）里程碑彩蛋 → 冠军页
 * 上报与 splash 并行，尽量在动画结束时已拿到结果。
 */
function goChampAfterWin(state) {
  const champ = state.bracket?.champion;
  if (!champ) {
    navigate("/champ");
    return;
  }

  const isBeef = state.cupType === "label-beef";
  const isArtistCup = state.cupType === "artist-cup";
  const isDuel = state.cupType === "duel-king";
  const champLabel = champ.labelName ? ` · ${champ.labelName}` : "";
  const duelMeta = isDuel ? resolveDuelChampArtist(state, champ) : null;
  const winPayload = {
    song: champ,
    artistId: isArtistCup
      ? String(champ.neteaseId || champ.id || "")
      : isDuel
        ? duelMeta.artistId
        : state.neteaseArtistId,
    artistName: isArtistCup
      ? champ.title || champ.rosterArtistName || ""
      : isDuel
        ? duelMeta.name
        : state.artistName,
    artistAvatar: isArtistCup
      ? champ.cover || champ.coverSm || ""
      : isDuel
        ? duelMeta.avatar
        : state.artistAvatar || "",
  };
  if (isArtistCup) {
    winPayload.cupType = "artist-cup";
  }
  if (isDuel) {
    winPayload.cupType = "duel-king";
    winPayload.songArtist = duelMeta.name;
  }
  if (isBeef && state.labels?.length >= 2) {
    const winnerId = champ.labelId || "";
    const winnerName = champ.labelName || "";
    const loser =
      state.labels.find((l) => l.id && l.id !== winnerId) ||
      state.labels.find((l) => l.name && l.name !== winnerName) ||
      state.labels[1];
    winPayload.cupType = "label-beef";
    winPayload.songArtist = champ.rosterArtistName || champ.artist || "";
    winPayload.artistName = winPayload.songArtist;
    winPayload.winnerLabelId = winnerId;
    winPayload.winnerLabelName = winnerName;
    winPayload.loserLabelId = loser?.id || "";
    winPayload.loserLabelName = loser?.name || "";
  }
  const winPromise = reportChampionWin(winPayload).catch(() => null);

  showRoundSplash(
    {
      title: "冠军诞生",
      sub: isBeef
        ? `${champ.title}${champLabel} 加冕厂牌混战之王`
        : isArtistCup
          ? `${champ.title} 加冕歌手大比拼冠军`
          : isDuel
            ? `${champ.title} · ${duelMeta.name || ""} 加冕单挑王`
            : `${champ.title} · ${state.artistName} 本命曲加冕`,
    },
    async () => {
      // 上报若尚未返回，短暂遮罩避免闪回对战页
      let veil = null;
      const veilTimer = setTimeout(() => {
        veil = document.createElement("div");
        veil.className = "round-splash is-on";
        veil.innerHTML = `<div class="round-splash-bg" aria-hidden="true"></div>`;
        document.body.appendChild(veil);
      }, 40);
      const data = await winPromise;
      clearTimeout(veilTimer);
      veil?.remove();
      if (data?.songWins != null) {
        try {
          const st = loadState() || state;
          st.champSongWins = Number(data.songWins) || 0;
          saveState(st);
        } catch (_) {}
      }
      if (data?.milestone && data.participantNo) {
        markMilestoneShown({ song: champ, artistId: state.neteaseArtistId });
        showMilestoneSplash(data.participantNo, () => navigate("/champ"));
        return;
      }
      navigate("/champ");
    }
  );
}

/** 总参与人数撞上 100 倍数时的惊喜彩蛋，结束后进入冠军页 */
function showMilestoneSplash(participantNo, onDone) {
  const existing = document.getElementById("round-splash");
  if (existing) existing.remove();

  const n = Number(participantNo) || 0;
  const pretty = n.toLocaleString("zh-CN");
  const sparks = Array.from({ length: 18 }, (_, i) => {
    const left = 8 + ((i * 37) % 84);
    const delay = ((i * 0.11) % 1.4).toFixed(2);
    const dur = (1.6 + (i % 5) * 0.22).toFixed(2);
    const size = 4 + (i % 4) * 2;
    return `<span class="milestone-spark" style="--sx:${left}%;--sd:${delay}s;--sdu:${dur}s;--ss:${size}px"></span>`;
  }).join("");

  const el = document.createElement("div");
  el.id = "round-splash";
  el.className = "round-splash milestone-splash";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <div class="round-splash-bg" aria-hidden="true"></div>
    <div class="milestone-sparks" aria-hidden="true">${sparks}</div>
    <div class="round-splash-card">
      <div class="round-splash-badge">里程碑彩蛋</div>
      <p class="milestone-congrats">恭喜你！</p>
      <p class="milestone-line">你是全站第 <em>${esc(pretty)}</em> 位参与者！</p>
      <p class="milestone-tagline">正好卡在 ${esc(String(n))} · 运气爆棚</p>
      <p class="round-splash-hint">点击或稍候进入冠军页</p>
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
  auto = setTimeout(finish, 4200);
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
      ${imgTag(coverUrl(song, fallback), {
        alt: song.title,
        className: "podium-cover",
        size: IMAGE_SIZES.chip,
        width: 48,
        height: 48,
      })}
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

  void getShareCardModule()
    .then((mod) => mod.warmShareCovers(state))
    .catch(() => {});

  const avatar = state.artistAvatar || "";
  const c = state.bracket.champion;
  const el = document.createElement("div");
  el.id = "share-bracket";
  el.className = "share-bracket";
  // Light shell first so click paint stays responsive (INP).
  el.innerHTML = `
    <div class="share-bracket-panel">
      <header class="share-bracket-head">
        <div>
          <h2>${esc(state.artistName)}</h2>
          <p class="share-bracket-champ-line">冠军 · <span class="share-bracket-champ-song">${esc(
            c?.title || ""
          )}</span></p>
        </div>
        <div class="share-bracket-actions">
          <button type="button" class="share-save-btn" id="share-save-btn" disabled>保存照片</button>
          <button type="button" class="ghost-btn" id="share-close-btn">关闭</button>
        </div>
      </header>
      <div class="share-bracket-stage" id="share-bracket-stage">
        <p class="share-bracket-loading">对阵图加载中…</p>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-on"));

  /** @type {(() => void) | null} */
  let fitShare = null;
  const close = () => {
    if (fitShare) window.removeEventListener("resize", fitShare);
    const supportModal = document.getElementById("support-author-modal");
    if (supportModal) supportModal.remove();
    el.classList.remove("is-on");
    setTimeout(() => el.remove(), 280);
  };
  el.querySelector("#share-close-btn").addEventListener("click", close);
  el.addEventListener("click", (e) => {
    if (e.target === el) close();
  });

  const mountHeavyShareBody = () => {
    if (!el.isConnected) return;
    const stage = el.querySelector("#share-bracket-stage");
    if (!stage) return;
    stage.innerHTML = `
        <div class="share-bracket-card" id="battle-card">
          <div class="share-bracket-brand brand-wordmark" aria-label="黑怕巅峰对决">
            <span class="brand-heipa">黑怕</span><span class="brand-duel">巅峰对决</span>
          </div>
          ${renderBracketHtml(state.bracket, avatar)}
          <button type="button" class="share-cta-btn" id="share-go-btn">
            <svg class="share-cta-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="M12 3.2a1 1 0 0 1 .7.3l3.5 3.5a1 1 0 1 1-1.4 1.4L13 6.6V15a1 1 0 1 1-2 0V6.6L8.2 8.4a1 1 0 1 1-1.4-1.4L10.3 3.5a1 1 0 0 1 .7-.3Z"/>
              <path fill="currentColor" d="M5 12a1 1 0 0 1 1 1v5h12v-5a1 1 0 1 1 2 0v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"/>
            </svg>
            <span>${SHARE_CTA_LABEL}</span>
          </button>
          <div class="share-bracket-qr">
            <div class="share-bracket-qr-copy">
              <div class="share-bracket-site">
                <span class="share-site-name" aria-label="heipaclub.com">HEIPACLUB.COM</span>
                <span class="share-site-z" aria-hidden="true">z</span>
              </div>
              <em class="share-bracket-slogan">给你的本命 RapStar 办一场真正的说唱巅峰对决</em>
            </div>
            <canvas id="share-qr-canvas" width="66" height="66" aria-label="网站二维码"></canvas>
            <div class="share-support-wrap">
              <button type="button" class="share-support-btn" id="share-support-btn">赞助作者</button>
            </div>
          </div>
        </div>
    `;

  fitShare = () => {
    const fit = el.querySelector("#bracket-fit");
    const board = el.querySelector("#bracket-board");
    if (!fit || !board) return;
    const mobile = window.innerWidth <= 720;
    const availH = Math.max(260, window.innerHeight * (mobile ? 0.52 : 0.62));
    fitBracketBoard(fit, board, {
      pad: mobile ? 0.84 : 0.94,
      maxAvailH: availH,
    });
  };
  requestAnimationFrame(() => {
    fitShare?.();
    requestAnimationFrame(() => fitShare?.());
  });
  const qrCanvas = el.querySelector("#share-qr-canvas");
  if (qrCanvas) {
    void getQrCodeModule()
      .then((mod) =>
        mod.default.toCanvas(qrCanvas, SITE_URL, {
          width: 66,
          margin: 1,
          color: { dark: "#111110", light: "#ffffff" },
          errorCorrectionLevel: "M",
        })
      )
      .catch(() => {});
  }
  el.querySelectorAll("img").forEach((img) => {
    if (!img.complete) img.addEventListener("load", () => fitShare?.(), { once: true });
  });
  window.addEventListener("resize", fitShare, { passive: true });

  const shareBtn = el.querySelector("#share-go-btn");
  const shareLabel = shareBtn?.querySelector("span");
  const saveBtn = el.querySelector("#share-save-btn");
  const supportBtn = el.querySelector("#share-support-btn");
  /** @type {{ file: File, title: string, text: string } | null} */
  let shareReady = null;
  let shareImageReadyTracked = false;
  if (shareBtn && shareLabel) {
    shareBtn.disabled = true;
    shareBtn.classList.add("is-busy");
    shareLabel.textContent = "准备中…";
  }
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.classList.add("is-busy");
  }

  const setShareReady = (ready) => {
    shareReady = ready;
    if (!shareImageReadyTracked) {
      shareImageReadyTracked = true;
      trackEvent("share_image_ready");
    }
    if (shareBtn && shareLabel) {
      shareBtn.disabled = false;
      shareBtn.classList.remove("is-busy", "is-fail");
      shareLabel.textContent = SHARE_CTA_LABEL;
    }
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.classList.remove("is-busy");
      saveBtn.textContent = "保存照片";
    }
  };

  const setShareFail = () => {
    if (shareBtn && shareLabel) {
      shareBtn.disabled = false;
      shareBtn.classList.remove("is-busy");
      shareBtn.classList.add("is-fail");
      shareLabel.textContent = "失败重试";
    }
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.classList.remove("is-busy");
      saveBtn.textContent = "重试生成";
    }
  };

  void prepareNativeSharePayload(state).then(setShareReady).catch(setShareFail);

  const closeSupportModal = () => {
    const modal = document.getElementById("support-author-modal");
    if (!modal) return;
    modal.classList.remove("is-on");
    setTimeout(() => modal.remove(), 220);
  };

  const openSupportModal = () => {
    closeSupportModal();
    const modal = document.createElement("div");
    modal.id = "support-author-modal";
    modal.className = "champ-donate-tip";
    modal.innerHTML = `
      <div class="champ-donate-tip-backdrop" data-support-author-close></div>
      <div class="champ-donate-tip-card" role="dialog" aria-modal="true" aria-labelledby="support-author-title">
        <header class="champ-donate-tip-head">
          <h3 id="support-author-title">👊 Respect！给服务器加点油</h3>
          <button type="button" class="champ-donate-tip-close" data-support-author-close aria-label="关闭">×</button>
        </header>
        <p class="champ-donate-tip-copy">为了给家人们做个好玩的说唱专属小游戏，本站的所有开销都是我自掏腰包，纯靠“为爱发电”。现在流量越来越大，服务器急需升级才能保证大家顺畅访问。如果你玩得开心，欢迎赞助一瓶水钱，帮助网站持续运营下去，感谢支持！</p>
        <p class="champ-donate-tip-perk">🔥 福利放送：扫码赞助后有<button type="button" class="champ-donate-tip-perk-link" data-support-author-perks>特殊福利</button>哦</p>
        <figure class="champ-donate-tip-qr">
          <img src="${CHAMP_DONATE_QR_SRC}" alt="微信赞赏码" width="132" height="132" decoding="async" />
        </figure>
        <p class="champ-donate-tip-hint">微信扫一扫</p>
        <button type="button" class="champ-donate-tip-dismiss" data-support-author-close>知道了</button>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add("is-on"));
    const closeModal = () => closeSupportModal();
    modal.querySelectorAll("[data-support-author-close]").forEach((node) => {
      node.addEventListener("click", closeModal);
    });
    modal.querySelector("[data-support-author-perks]")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeModal();
      openSupportSite({ scrollToPerks: true });
    });
  };

  supportBtn?.addEventListener("click", () => {
    openSupportModal();
  });


  const downloadShareFile = (file) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name || "HeipaClub-Bracket.jpg";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
  };

  saveBtn?.addEventListener("click", async () => {
    if (!shareReady) {
      saveBtn.disabled = true;
      saveBtn.classList.add("is-busy");
      saveBtn.textContent = "准备中…";
      try {
        setShareReady(await prepareNativeSharePayload(state));
      } catch {
        setShareFail();
        return;
      }
    }
    if (!shareReady?.file) return;
    try {
      downloadShareFile(shareReady.file);
      saveBtn.textContent = "已保存";
      saveBtn.classList.add("is-ok");
      setTimeout(() => {
        if (saveBtn.isConnected) {
          saveBtn.textContent = "保存照片";
          saveBtn.classList.remove("is-ok");
        }
      }, 1600);
    } catch {
      saveBtn.textContent = "保存失败";
      setTimeout(() => {
        if (saveBtn.isConnected) saveBtn.textContent = "保存照片";
      }, 1400);
    }
  });

  shareBtn?.addEventListener("click", () => {
    // Must call navigator.share() synchronously in this click stack (iOS Safari).
    if (!shareReady) {
      shareBtn.disabled = true;
      shareBtn.classList.add("is-busy");
      shareBtn.classList.remove("is-fail");
      if (shareLabel) shareLabel.textContent = "准备中…";
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.classList.add("is-busy");
      }
      prepareNativeSharePayload(state)
        .then(setShareReady)
        .catch(setShareFail);
      return;
    }
    if (typeof navigator.share !== "function") {
      if (shareLabel) shareLabel.textContent = "请用系统分享";
      setTimeout(() => {
        if (shareLabel) shareLabel.textContent = SHARE_CTA_LABEL;
      }, 1400);
      return;
    }
    const full = {
      files: [shareReady.file],
      title: shareReady.title,
      text: shareReady.text,
    };
    const filesOnly = { files: [shareReady.file] };
    const payload =
      typeof navigator.canShare === "function"
        ? navigator.canShare(full)
          ? full
          : navigator.canShare(filesOnly)
            ? filesOnly
            : null
        : full;
    if (!payload) {
      if (shareLabel) shareLabel.textContent = "暂不支持分享";
      setTimeout(() => {
        if (shareLabel) shareLabel.textContent = SHARE_CTA_LABEL;
      }, 1400);
      return;
    }
    navigator.share(payload).catch((e) => {
      if (e?.name === "AbortError") return;
      if (shareLabel) {
        shareLabel.textContent = "分享失败";
        setTimeout(() => {
          shareLabel.textContent = SHARE_CTA_LABEL;
        }, 1400);
      }
    });
  });

  };

  requestAnimationFrame(mountHeavyShareBody);
}
/** Prefetch File for Web Share API — Music Cup style Canvas draw (fast + crisp). */
async function prepareNativeSharePayload(state) {
  const { champion } = podiumFromBracket(state.bracket);
  const title = `${state.artistName || ""} 本命曲对阵图`;
  const textBody = `冠军：${champion?.title || ""} · 扫码玩 heipaclub.com`;
  const { buildShareCardBlob } = await getShareCardModule();
  const blob = await buildShareCardBlob(state);
  const file = new File([blob], "HeipaClub-Bracket.jpg", {
    type: blob.type || "image/jpeg",
  });
  return { file, title, text: textBody };
}

/** @deprecated */
async function downloadShareCard(state) {
  const payload = await prepareNativeSharePayload(state);
  await shareOrDownloadBlob(payload.file, "HeipaClub-Bracket.jpg", {
    title: payload.title,
    text: payload.text,
  });
}

function isLikelyMobileShareClient() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS desktop UA
  if (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua)) return true;
  return false;
}

async function blobToJpeg(blob, quality = 0.72) {
  if (blob.type === "image/jpeg" && quality >= 0.85) return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    let w = bitmap.width;
    let h = bitmap.height;
    // Cap long edge so share stays ~hundreds of KB
    const maxEdge = 1280;
    if (Math.max(w, h) > maxEdge) {
      const s = maxEdge / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e4e1da";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const jpeg = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("jpeg failed"))), "image/jpeg", quality);
    });
    return jpeg;
  } finally {
    bitmap.close?.();
  }
}

/**
 * Open the OS share sheet with an image file.
 * Must be called directly from a user gesture on iOS Safari.
 */
async function invokeNativeShare({ file, title = "", text = "" }) {
  if (typeof navigator.share !== "function") {
    throw new Error("Web Share API unavailable");
  }
  const data = { files: [file], title, text };
  if (typeof navigator.canShare === "function" && !navigator.canShare(data)) {
    // Retry files-only — some WebViews reject title/text + files together
    const filesOnly = { files: [file] };
    if (!navigator.canShare(filesOnly)) {
      throw new Error("canShare files unsupported");
    }
    await navigator.share(filesOnly);
    return;
  }
  try {
    await navigator.share(data);
  } catch (e) {
    if (e?.name === "AbortError") return;
    // One more try without title/text
    try {
      await navigator.share({ files: [file] });
    } catch (e2) {
      if (e2?.name === "AbortError") return;
      throw e2;
    }
  }
}

async function shareOrDownloadBlob(blob, fileName, { title = "", text = "" } = {}) {
  try {
    const jpeg = await blobToJpeg(blob).catch(() => blob);
    const type = jpeg.type || "image/jpeg";
    const ext = type.includes("png") ? "png" : "jpg";
    const file = new File([jpeg], `HeipaClub-Bracket.${ext}`, { type });
    await invokeNativeShare({ file, title, text });
    return;
  } catch (e) {
    if (e?.name === "AbortError") return;
    // Mobile: never fake a download click — that triggers Safari's ugly prompt.
    if (isLikelyMobileShareClient()) {
      throw e;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || "HeipaClub-Bracket.png";
  a.click();
  URL.revokeObjectURL(url);
}

function pickButton(side, song, fallback, { artistCup = false } = {}) {
  const labelBadge = song?.labelName
    ? `<span class="pick-label-badge">${esc(song.labelName)}</span>`
    : "";
  const artistLine = artistCup
    ? metaLine(song) || song?.artist || ""
    : song?.rosterArtistName || song?.artist || "";
  const sideLabel = artistCup ? `RAPPER ${side.toUpperCase()}` : `TRACK ${side.toUpperCase()}`;
  const cta = artistCup ? "选这位晋级" : "选这首晋级";
  const preview = artistCup
    ? ""
    : `<button type="button" class="preview-btn" data-preview="${side}">试听</button>`;
  return `
    <div class="pick-wrap">
      <button type="button" class="pick" data-side="${side}">
        ${progressivePickCover(song, fallback)}
        <div class="pick-copy">
          <div class="side">${sideLabel}${labelBadge}</div>
          <h2 class="title">${esc(song.title)}</h2>
          <p class="album">${esc(artistLine)}</p>
          <span class="cta">${cta}</span>
        </div>
      </button>
      ${preview}
    </div>
  `;
}

function renderChamp(state) {
  const c = state.bracket.champion;
  const isArtistCup = state.cupType === "artist-cup";
  const isBeef = state.cupType === "label-beef";
  const isDuel = state.cupType === "duel-king";
  const avatar = state.artistAvatar || "";
  const { runnerUp, semis } = podiumFromBracket(state.bracket);
  const songId = String(c?.neteaseId || c?.id || "").trim();
  let initialWins = Number(state.champSongWins || 0) || 0;
  if (!initialWins && songId) {
    try {
      const cacheKey = isArtistCup
        ? `cn-rap-cup:artist-wins:${songId}`
        : `cn-rap-cup:song-wins:${songId}`;
      initialWins = Number(sessionStorage.getItem(cacheKey) || 0) || 0;
    } catch (_) {}
  }

  void getShareCardModule()
    .then((mod) => mod.warmShareCovers(state))
    .catch(() => {});

  const songTitleHtml = `<span class="champ-social-song">「${esc(c.title)}」</span>`;
  const socialNoun = isArtistCup ? "冠军歌手" : "冠军歌曲";
  const socialHtml =
    initialWins > 0
      ? `有 ${initialWins.toLocaleString("zh-CN")} 人和你一样选择了${songTitleHtml}作为${socialNoun}`
      : `正在统计有多少人和你一样选择了${songTitleHtml}…`;

  const againHomeLabel = isBeef
    ? "换个厂牌"
    : isDuel
      ? "换人对决"
      : isArtistCup
        ? "改分档再抽"
        : "换个歌手";

  app.innerHTML = shell(
    `
    <section class="champ champ-cup">
      <div class="champ-cup-stage">
        <p class="champ-cup-artist"><span class="rapper-name">${esc(
          isBeef
            ? `${state.labels?.[0]?.name || ""} vs ${state.labels?.[1]?.name || ""}`
            : isDuel
              ? `${state.duelArtists?.[0]?.name || ""} vs ${state.duelArtists?.[1]?.name || ""}`
              : state.artistName || ""
        )}</span></p>
        <p class="champ-cup-born">冠军诞生</p>
        <p class="champ-cup-brand brand-wordmark" aria-label="黑怕巅峰对决">
          <span class="brand-heipa">黑怕</span><span class="brand-duel">巅峰对决</span>
        </p>
        <p class="champ-cup-champion-word">C H A M P I O N</p>
        <div class="champ-cup-cover-wrap">
          ${imgTag(coverUrl(c, avatar), {
            alt: c.title,
            className: "champ-cup-cover",
            size: IMAGE_SIZES.champ,
            loading: "eager",
            fetchPriority: "high",
            width: 280,
            height: 280,
            sizes: "(max-width: 640px) 72vw, 280px",
            responsive: true,
          })}
          ${
            isArtistCup
              ? ""
              : `<button type="button" class="champ-cover-play" id="champ-cover-play" aria-label="试听冠军曲">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13l11-6.5L8 5.5z"/></svg>
          </button>`
          }
        </div>
        <h1 class="champ-cup-title">${esc(c.title)}</h1>
        <p class="champ-cup-meta">${esc(metaLine(c))}</p>
      </div>

      <div class="podium-row">
        ${podiumCard("亚军", "RUNNER-UP", runnerUp, avatar)}
        ${podiumCard("四强", "SEMI", semis[0], avatar)}
        ${podiumCard("四强", "SEMI", semis[1], avatar)}
      </div>

      <p class="champ-social-proof" id="champ-social-proof">${socialHtml}</p>

      ${isArtistCup ? "" : `<div id="player-mount" class="player-mount champ-player" hidden></div>`}

      <div class="champ-cup-actions">
        <button type="button" class="primary-btn share-bracket-btn" id="share-bracket-btn">生成专属于你的对阵图</button>
        <div class="champ-cup-secondary">
          <button type="button" class="ghost-btn" id="again-same">再来一场</button>
          <button type="button" class="ghost-btn" id="again-home">${againHomeLabel}</button>
          ${
            isArtistCup
              ? `<a class="ghost-btn" href="#/rank/artists-pk">看歌手PK榜</a>`
              : ""
          }
        </div>
      </div>
    </section>
  `,
    {
      back: "/",
      actions: `<a class="ghost-btn rank-link" href="${
        isArtistCup ? "#/rank/artists-pk" : "#/rank"
      }">${isArtistCup ? "歌手PK榜" : "排行榜"}</a>`,
    }
  );
  bindBack();

  const socialEl = document.getElementById("champ-social-proof");
  const paintSocial = (wins) => {
    const n = Number(wins || 0);
    if (!socialEl || n <= 0) return;
    socialEl.innerHTML = `有 ${n.toLocaleString("zh-CN")} 人和你一样选择了<span class="champ-social-song">「${esc(
      c.title
    )}」</span>作为${socialNoun}`;
  };

  let player = null;
  const openChampPlayer = async () => {
    const mount = document.getElementById("player-mount");
    const playBtn = document.getElementById("champ-cover-play");
    if (!mount) return;
    mount.hidden = false;
    playBtn?.classList.add("is-open");
    if (!player) {
      player = createPlayer(mount);
    }
    await player.load(c, {
      autoplay: true,
      artistName: c.rosterArtistName || state.artistName || "",
      artistAliases: [state.artistSearch, c.rosterArtistName].filter(Boolean),
      mapArtistId: c.rosterArtistId || state.artistId || "",
    });
    const card = document.getElementById("cup-player");
    if (card) card.hidden = false;
  };
  document.getElementById("champ-cover-play")?.addEventListener("click", () => {
    openChampPlayer().catch(() => {});
  });

  // still report wins silently（决冠时已报过则 session 去重跳过）
  {
    const duelMeta = isDuel ? resolveDuelChampArtist(state, c) : null;
    const payload = {
      song: c,
      artistId: isArtistCup
        ? songId
        : isDuel
          ? duelMeta.artistId
          : state.neteaseArtistId,
      artistName: isArtistCup
        ? c.title || c.rosterArtistName || ""
        : isDuel
          ? duelMeta.name
          : state.artistName,
      artistAvatar: isArtistCup
        ? c.cover || c.coverSm || avatar
        : isDuel
          ? duelMeta.avatar
          : avatar,
    };
    if (isArtistCup) {
      payload.cupType = "artist-cup";
    }
    if (isDuel) {
      payload.cupType = "duel-king";
      payload.songArtist = duelMeta.name;
    }
    if (isBeef && state.labels?.length >= 2) {
      const winnerId = c.labelId || "";
      const winnerName = c.labelName || "";
      const loser =
        state.labels.find((l) => l.id && l.id !== winnerId) ||
        state.labels.find((l) => l.name && l.name !== winnerName) ||
        state.labels[1];
      payload.cupType = "label-beef";
      payload.songArtist = c.rosterArtistName || c.artist || "";
      payload.artistName = payload.songArtist;
      payload.winnerLabelId = winnerId;
      payload.winnerLabelName = winnerName;
      payload.loserLabelId = loser?.id || "";
      payload.loserLabelName = loser?.name || "";
    }
    reportChampionWin(payload)
      .then(async (data) => {
        if (data?.songWins != null) {
          paintSocial(data.songWins);
          try {
            const st = loadState() || state;
            st.champSongWins = Number(data.songWins) || 0;
            saveState(st);
          } catch (_) {}
          return;
        }
        if (initialWins > 0) return;
        try {
          if (isArtistCup) {
            const rank = await fetchArtistRank({ limit: 50, q: c.title || "" });
            const hit = (rank.items || []).find(
              (item) =>
                String(item.artistId || "") === songId ||
                String(item.name || "").toLowerCase() === String(c.title || "").toLowerCase()
            );
            if (hit?.wins) paintSocial(hit.wins);
          } else {
            const rank = await fetchSongRank({ limit: 20, q: c.title || "" });
            const hit = (rank.items || []).find(
              (item) =>
                String(item.songId || "") === songId ||
                String(item.title || "").toLowerCase() === String(c.title || "").toLowerCase()
            );
            if (hit?.wins) paintSocial(hit.wins);
          }
        } catch (_) {}
      })
      .catch(() => {});
  }

  const shareOpenBtn = document.getElementById("share-bracket-btn");
  const warmShare = () => {
    void getShareCardModule()
      .then((mod) => mod.warmShareCovers(state))
      .catch(() => {});
  };
  shareOpenBtn?.addEventListener("pointerdown", warmShare, { once: true, passive: true });
  shareOpenBtn?.addEventListener("mouseenter", warmShare, { once: true, passive: true });
  shareOpenBtn?.addEventListener("click", () => {
    trackEvent("share_open");
    if (shareOpenBtn) {
      shareOpenBtn.disabled = true;
      shareOpenBtn.textContent = "正在打开…";
    }
    runAfterNextPaint(() => {
      openShareBracket(state);
      if (shareOpenBtn?.isConnected) {
        shareOpenBtn.disabled = false;
        shareOpenBtn.textContent = "生成专属于你的对阵图";
      }
    });
  });
  document.getElementById("again-same").addEventListener("click", () => {
    clearState();
    if (isBeef) navigate("/label-beef");
    else if (isDuel) navigate("/duel-king");
    else if (isArtistCup) navigate("/artist-pk");
    else navigate(`/artist/${state.artistId}`);
  });
  document.getElementById("again-home").addEventListener("click", () => {
    clearState();
    if (isArtistCup) navigate("/artist-pk");
    else if (isDuel) navigate("/duel-king");
    else navigate("/");
  });

  maybeShowChampDonateTip();
}

async function renderRank(tab = "songs") {
  let region = "cn"; // 中文 | 欧美
  const rankListSkeleton = (rows = 10) =>
    Array.from({ length: rows }, () => `
      <article class="rank-row rank-row-skeleton" aria-hidden="true">
        <div class="rank-num">·</div>
        <div class="rank-cover-skel"></div>
        <div class="rank-meta">
          <div class="rank-skel-line"></div>
          <div class="rank-skel-line short"></div>
        </div>
      </article>
    `).join("");

  app.innerHTML = shell(
    `<section class="rank-page"><p class="loading-line">加载排行榜…</p></section>`,
    { back: "/" }
  );
  bindBack();

  const tabHref = (t) =>
    t === "artists"
      ? "/rank/artists"
      : t === "artists-pk"
        ? "/rank/artists-pk"
        : t === "duel-king"
          ? "/rank/duel-king"
          : t === "labels"
            ? "/rank/labels"
            : t === "hangla"
              ? "/rank/hangla"
              : "/rank";

  const paint = async (active, q = "") => {
    const showRegion =
      active === "songs" ||
      active === "artists" ||
      active === "artists-pk" ||
      active === "duel-king";
    const showSearch = active !== "hangla";
    const isArtistBoard =
      active === "artists" || active === "artists-pk" || active === "duel-king";
    app.innerHTML = shell(
      `
      <section class="rank-page">
        <div class="rank-head">
          <div class="rank-head-title-row">
            <h1>排行榜</h1>
            <div class="rank-total-wins rank-total-wins--accent rank-grand-total" id="rank-grand-total" aria-live="polite">
              <span class="rank-total-wins-label">总参与人数</span>
              <strong>—</strong>
            </div>
          </div>
          <p class="rank-sub" id="rank-sub"></p>
        </div>
        <div class="rank-tabs" role="tablist" aria-label="排行榜类型">
          <button type="button" class="mode-chip ${active === "songs" ? "active" : ""}" data-rank-tab="songs">歌曲</button>
          <button type="button" class="mode-chip ${active === "artists" ? "active" : ""}" data-rank-tab="artists">歌手</button>
          <button type="button" class="mode-chip rank-tab-artist-pk ${active === "artists-pk" ? "active" : ""}" data-rank-tab="artists-pk">歌手PK结果</button>
          <span class="rank-tab-duel-king-wrap">
            <button type="button" class="mode-chip rank-tab-duel-king ${active === "duel-king" ? "active" : ""}" data-rank-tab="duel-king">最强单挑王</button>
            <span class="feature-glow-tip feature-glow-tip--under-tab">8.13 新功能上线啦！！！！</span>
          </span>
          <button type="button" class="mode-chip ${active === "labels" ? "active" : ""}" data-rank-tab="labels">厂牌</button>
          <button type="button" class="mode-chip ${active === "hangla" ? "active" : ""}" data-rank-tab="hangla">夯拉</button>
        </div>
        ${
          showRegion
            ? `<div class="filter-row sort-row rank-region-row" id="rank-region-row" role="group" aria-label="地区榜">
          <button type="button" class="mode-chip ${region === "cn" ? "active" : ""}" data-rank-region="cn">中文</button>
          <button type="button" class="mode-chip ${region === "west" ? "active" : ""}" data-rank-region="west">欧美</button>
        </div>`
            : ""
        }
        <div class="search-row search-row-with-total">
          ${
            showSearch
              ? `<input id="rank-search" type="search" placeholder="${
                  active === "songs"
                    ? "搜索歌曲…"
                    : isArtistBoard
                      ? "搜索歌手…"
                      : "搜索厂牌…"
                }" value="${esc(q)}" autocomplete="off" />`
              : `<p class="rank-hangla-hint">完成「从夯到拉」后计入 · 左栏最夯 · 右栏最拉</p>`
          }
          <div class="rank-total-wins rank-total-wins--accent" id="rank-total-wins" aria-live="polite">
            <span class="rank-total-wins-label">${
              active === "songs" || active === "artists"
                ? "歌曲PK次数"
                : active === "artists-pk"
                  ? "歌手PK次数"
                  : active === "duel-king"
                    ? "单挑王次数"
                    : active === "labels"
                      ? "厂牌对战次数"
                      : "夯拉参与次数"
            }</span>
            <strong>—</strong>
          </div>
          <div class="rank-total-wins" id="rank-song-count" aria-live="polite">
            <span class="rank-total-wins-label">${
              isArtistBoard ? "已入围歌手数" : "已入围歌曲数"
            }</span>
            <strong>—</strong>
          </div>
          <p class="rank-anti-brush-note">
            🔥 战绩已开启防刷保护<br />
            （每人每天最多计入5次有效评选）
          </p>
        </div>
        <div id="rank-list" class="rank-list${active === "hangla" ? " rank-list-hangla" : ""}">${rankListSkeleton()}</div>
      </section>
    `,
      { back: "/" }
    );
    bindBack();

    let timer = null;
    const input = document.getElementById("rank-search");
    const RANK_PAGE = 25;
    /** @type {any[]} */
    let allItems = [];
    let shownCount = 0;
    /** @type {IntersectionObserver | null} */
    let moreObserver = null;

    const formatWinRate = (wins, battles) => {
      const b = Number(battles || 0);
      const w = Number(wins || 0);
      if (b <= 0) return null;
      return `${Math.round((w / b) * 1000) / 10}%`;
    };

    const songArtistLine = (item) => {
      let artist = String(item.artist || "").trim();
      // 旧厂牌混战曾把「A vs B」写入 artist；优先用 artistId 还原真实歌手名
      if (/^.+\s+vs\s+.+$/i.test(artist)) {
        const nid = String(item.artistId || "").trim();
        const local = nid
          ? ARTISTS.find((a) => String(a.neteaseArtistId || "") === nid)
          : null;
        artist = String(local?.name || "").trim();
      }
      return `${artist || "未知歌手"} · 单曲夺冠 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次`;
    };

    const renderHangLaCol = (title, items, kind) => {
      const rows = (items || [])
        .map((item, i) => {
          const rank = i + 1;
          const rankClass = rank <= 3 ? `top${rank}` : "";
          const titleClass = rank <= 3 ? `rank-title top${rank}` : "rank-title";
          const countLabel = kind === "hang" ? "获夯" : "拉完了";
          return `
            <article class="rank-row rank-row-hangla">
              <div class="rank-num ${rankClass}">${rank}</div>
              ${imgTag(item.avatar, {
                alt: item.name,
                className: "rank-cover round",
                size: IMAGE_SIZES.list,
                width: 40,
                height: 40,
              })}
              <div class="rank-meta">
                <div class="${titleClass}">${esc(item.name)}</div>
                <div class="rank-desc">${countLabel} ${Number(item.wins || 0).toLocaleString("zh-CN")} 次</div>
              </div>
            </article>`;
        })
        .join("");
      return `
        <div class="rank-hangla-col rank-hangla-col--${kind}">
          <h2 class="rank-hangla-col-title">${esc(title)}</h2>
          <div class="rank-hangla-col-list">
            ${rows || `<p class="loading-line">暂无数据</p>`}
          </div>
        </div>`;
    };

    const renderRankRow = (item, i, activeTab) => {
      const rank = i + 1;
      const rankClass = rank <= 3 ? `top${rank}` : "";
      const titleClass = rank <= 3 ? `rank-title top${rank}` : "rank-title";
      if (activeTab === "songs") {
        return `
          <article class="rank-row">
            <div class="rank-num ${rankClass}">${rank}</div>
            ${imgTag(item.cover, {
              alt: item.title,
              className: "rank-cover",
              size: IMAGE_SIZES.list,
              width: 52,
              height: 52,
            })}
            <div class="rank-meta">
              <div class="${titleClass}">${esc(item.title)}</div>
              <div class="rank-desc">${esc(songArtistLine(item))}</div>
            </div>
          </article>`;
      }
      if (activeTab === "labels") {
        const rate = formatWinRate(item.wins, item.battles);
        const desc = rate
          ? `${item.city || "厂牌"} · ${item.members} 人 · 胜率 ${rate} · 对战 ${Number(item.battles || 0).toLocaleString("zh-CN")} 场`
          : `${item.city || "厂牌"} · ${item.members} 人 · 暂无对战`;
        return `
          <article class="rank-row rank-row-label">
            <div class="rank-num ${rankClass}">${rank}</div>
            ${imgTag(item.avatar, {
              alt: item.name,
              className: "rank-cover round",
              size: IMAGE_SIZES.list,
              width: 52,
              height: 52,
            })}
            <div class="rank-meta">
              <div class="${titleClass}">${esc(item.name)}</div>
              <div class="rank-desc">${esc(desc)}</div>
            </div>
            <button type="button" class="rank-matchup-btn" data-label-matchup="${esc(
              item.labelId
            )}" data-label-name="${esc(item.name)}">对阵明细</button>
          </article>`;
      }
      if (activeTab === "duel-king") {
        return `
          <article class="rank-row rank-row-duel-king">
            <div class="rank-num ${rankClass}">${rank}</div>
            ${imgTag(item.avatar || item.cover, {
              alt: item.name,
              className: "rank-cover round",
              size: IMAGE_SIZES.list,
              width: 52,
              height: 52,
            })}
            <div class="rank-meta">
              <div class="${titleClass}">${esc(item.name)}</div>
              <div class="rank-desc">单挑王 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次</div>
            </div>
            <button type="button" class="rank-matchup-btn" data-duel-songs="${esc(
              item.artistId
            )}" data-duel-name="${esc(item.name)}">必杀曲</button>
          </article>`;
      }
      return `
        <article class="rank-row">
          <div class="rank-num ${rankClass}">${rank}</div>
          ${imgTag(item.avatar || item.cover, {
            alt: item.name,
            className: "rank-cover round",
            size: IMAGE_SIZES.list,
            width: 52,
            height: 52,
          })}
          <div class="rank-meta">
            <div class="${titleClass}">${esc(item.name)}</div>
            <div class="rank-desc">${
              activeTab === "artists-pk"
                ? `PK夺冠 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次`
                : `单曲夺冠 ${Number(item.wins || 0).toLocaleString("zh-CN")} 次`
            }</div>
          </div>
        </article>`;
    };

    const openDuelKingSongsModal = async (artistId, artistName) => {
      const existing = document.getElementById("duel-songs-modal");
      if (existing) existing.remove();
      const modal = document.createElement("div");
      modal.id = "duel-songs-modal";
      modal.className = "label-matchup-modal";
      modal.innerHTML = `
        <div class="label-matchup-panel" role="dialog" aria-modal="true" aria-labelledby="duel-songs-title">
          <header class="label-matchup-head">
            <h3 id="duel-songs-title">${esc(artistName || "歌手")} · 必杀曲</h3>
            <button type="button" class="label-matchup-close" aria-label="关闭">×</button>
          </header>
          <div class="label-matchup-body"><p class="loading-line">加载中…</p></div>
          <button type="button" class="label-matchup-done">知道了</button>
        </div>
      `;
      document.body.appendChild(modal);
      requestAnimationFrame(() => modal.classList.add("is-on"));
      const close = () => {
        modal.classList.remove("is-on");
        setTimeout(() => modal.remove(), 180);
      };
      modal.querySelector(".label-matchup-close")?.addEventListener("click", close);
      modal.querySelector(".label-matchup-done")?.addEventListener("click", close);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
      const body = modal.querySelector(".label-matchup-body");
      try {
        const data = await fetchDuelKingSongs(artistId);
        const items = data.items || [];
        const wins = Number(data.artist?.wins || 0);
        if (!items.length) {
          body.innerHTML = `<p class="loading-line">暂无必杀曲记录 · 打完单挑王就会出现</p>`;
          return;
        }
        body.innerHTML = `
          <p class="duel-songs-summary">累计加冕单挑王 <strong>${wins.toLocaleString(
            "zh-CN"
          )}</strong> 次</p>
          <ul class="label-champ-list duel-songs-list">
            ${items
              .map(
                (c) => `<li class="label-champ-item">
              ${imgTag(c.cover, {
                alt: c.title || "",
                className: "label-champ-cover",
                size: IMAGE_SIZES.list,
                width: 36,
                height: 36,
              })}
              <div class="label-champ-meta">
                <strong>${esc(c.title || "未知曲目")}</strong>
                <span>必杀夺冠 ${Number(c.wins || 0).toLocaleString("zh-CN")} 次</span>
              </div>
            </li>`
              )
              .join("")}
          </ul>
        `;
      } catch {
        body.innerHTML = `<p class="loading-line">必杀曲加载失败</p>`;
      }
    };

    const openLabelMatchupModal = async (labelId, labelName) => {
      const existing = document.getElementById("label-matchup-modal");
      if (existing) existing.remove();
      const modal = document.createElement("div");
      modal.id = "label-matchup-modal";
      modal.className = "label-matchup-modal";
      modal.innerHTML = `
        <div class="label-matchup-panel" role="dialog" aria-modal="true" aria-labelledby="label-matchup-title">
          <header class="label-matchup-head">
            <h3 id="label-matchup-title">${esc(labelName || "厂牌")} · 对阵明细</h3>
            <button type="button" class="label-matchup-close" aria-label="关闭">×</button>
          </header>
          <div class="label-matchup-body"><p class="loading-line">加载中…</p></div>
          <button type="button" class="label-matchup-done">知道了</button>
        </div>
      `;
      document.body.appendChild(modal);
      requestAnimationFrame(() => modal.classList.add("is-on"));
      const close = () => {
        modal.classList.remove("is-on");
        setTimeout(() => modal.remove(), 180);
      };
      modal.querySelector(".label-matchup-close")?.addEventListener("click", close);
      modal.querySelector(".label-matchup-done")?.addEventListener("click", close);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
      const body = modal.querySelector(".label-matchup-body");
      try {
        const data = await fetchLabelBeefMatchups(labelId);
        const items = data.items || [];
        if (!items.length) {
          body.innerHTML = `<p class="loading-line">暂无对阵记录，去打一场厂牌巅峰混战吧</p>`;
          return;
        }
        body.innerHTML = `
          <ul class="label-matchup-list">
            ${items
              .map((row, idx) => {
                const opp =
                  getLabel(row.opponentId)?.name || row.opponentName || row.opponentId;
                const rate = formatWinRate(row.wins, row.battles);
                const champs = Array.isArray(row.champions) ? row.champions : [];
                return `<li data-matchup-idx="${idx}">
                  <div class="label-matchup-row-top">
                    <div class="label-matchup-row-meta">
                      <strong>vs ${esc(opp)}</strong>
                      <span>${rate ? `胜率 ${esc(rate)}` : "暂无"} · 对战 ${Number(
                        row.battles || 0
                      ).toLocaleString("zh-CN")} 场 · 胜 ${Number(row.wins || 0).toLocaleString(
                        "zh-CN"
                      )} 场</span>
                    </div>
                    <button type="button" class="label-champ-toggle" aria-expanded="false" data-champ-toggle="${idx}">冠军单曲</button>
                  </div>
                  <div class="label-champ-panel" hidden data-champ-panel="${idx}">
                    ${
                      champs.length
                        ? `<ul class="label-champ-list">${champs
                            .map(
                              (c) => `<li>
                          ${imgTag(c.cover, {
                            alt: c.title,
                            className: "label-champ-cover",
                            size: IMAGE_SIZES.list,
                            width: 36,
                            height: 36,
                          })}
                          <div class="label-champ-meta">
                            <strong>${esc(c.title || "未知曲目")}</strong>
                            <span>${esc(c.artist || "未知歌手")} · 夺冠 ${Number(
                              c.wins || 0
                            ).toLocaleString("zh-CN")} 次</span>
                          </div>
                        </li>`
                            )
                            .join("")}</ul>`
                        : `<p class="label-champ-empty">暂无记录，完成混战后会出现</p>`
                    }
                  </div>
                </li>`;
              })
              .join("")}
          </ul>
        `;
        body.querySelectorAll("[data-champ-toggle]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const idx = btn.getAttribute("data-champ-toggle");
            const panel = body.querySelector(`[data-champ-panel="${idx}"]`);
            if (!panel) return;
            const open = panel.hasAttribute("hidden");
            if (open) panel.removeAttribute("hidden");
            else panel.setAttribute("hidden", "");
            btn.setAttribute("aria-expanded", open ? "true" : "false");
            btn.classList.toggle("is-on", open);
          });
        });
      } catch {
        body.innerHTML = `<p class="loading-line">对阵明细加载失败</p>`;
      }
    };

    const bindRankMore = (box) => {
      moreObserver?.disconnect();
      moreObserver = null;
      const sentinel = box.querySelector("#rank-more-sentinel");
      if (!sentinel || shownCount >= allItems.length) {
        sentinel?.remove();
        return;
      }
      moreObserver = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          const next = allItems.slice(shownCount, shownCount + RANK_PAGE);
          if (!next.length) {
            sentinel.remove();
            moreObserver?.disconnect();
            return;
          }
          const html = next.map((item, i) => renderRankRow(item, shownCount + i, active)).join("");
          sentinel.insertAdjacentHTML("beforebegin", html);
          shownCount += next.length;
          if (active === "labels") {
            box.querySelectorAll("[data-label-matchup]").forEach((btn) => {
              if (btn.dataset.bound === "1") return;
              btn.dataset.bound = "1";
              btn.addEventListener("click", (e) => {
                e.stopPropagation();
                openLabelMatchupModal(btn.dataset.labelMatchup, btn.dataset.labelName);
              });
            });
          }
          if (active === "duel-king") {
            box.querySelectorAll("[data-duel-songs]").forEach((btn) => {
              if (btn.dataset.bound === "1") return;
              btn.dataset.bound = "1";
              btn.addEventListener("click", (e) => {
                e.stopPropagation();
                openDuelKingSongsModal(btn.dataset.duelSongs, btn.dataset.duelName);
              });
            });
          }
          if (shownCount >= allItems.length) {
            sentinel.remove();
            moreObserver?.disconnect();
          }
        },
        { root: null, rootMargin: "200px 0px", threshold: 0 }
      );
      moreObserver.observe(sentinel);
    };

    const formatStat = (n) => {
      const value = Number(n);
      return Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
    };

    const modePlaysLabel = (tab) => {
      if (tab === "songs" || tab === "artists") return "歌曲PK次数";
      if (tab === "artists-pk") return "歌手PK次数";
      if (tab === "duel-king") return "单挑王次数";
      if (tab === "labels") return "厂牌对战次数";
      if (tab === "hangla") return "夯拉参与次数";
      return "参与次数";
    };

    const modePlaysFromParticipation = (tab, p) => {
      if (!p) return null;
      if (tab === "songs" || tab === "artists") return p.songPk;
      if (tab === "artists-pk") return p.artistPk;
      if (tab === "duel-king") return null;
      if (tab === "labels") return p.label;
      if (tab === "hangla") return p.hangla;
      return p.total;
    };

    const updateRankStatsUi = ({
      grandTotal,
      modePlays,
      modeLabel,
      songCount,
      countLabel,
    } = {}) => {
      const grandEl = document.getElementById("rank-grand-total");
      if (grandEl && grandTotal != null) {
        grandEl.innerHTML = `<span class="rank-total-wins-label">总参与人数</span><strong>${formatStat(
          grandTotal
        )}</strong>`;
      }
      const winsEl = document.getElementById("rank-total-wins");
      if (winsEl && modePlays != null) {
        winsEl.innerHTML = `<span class="rank-total-wins-label">${
          modeLabel || modePlaysLabel(active)
        }</span><strong>${formatStat(modePlays)}</strong>`;
      }
      const songsEl = document.getElementById("rank-song-count");
      if (songsEl && songCount != null) {
        songsEl.innerHTML = `<span class="rank-total-wins-label">${
          countLabel || "已入围歌曲数"
        }</span><strong>${formatStat(songCount)}</strong>`;
      }
    };

    const loadList = async (query) => {
      const box = document.getElementById("rank-list");
      if (!box) return;
      moreObserver?.disconnect();
      moreObserver = null;
      shownCount = 0;
      allItems = [];
      box.innerHTML = rankListSkeleton();
      try {
        let items = [];
        let updatedAt = null;
        let participation = null;
        let songCount = null;
        let stale = false;
        const applySub = (base) => {
          const sub = document.getElementById("rank-sub");
          if (!sub) return;
          sub.textContent = stale
            ? `${base} · 数据可能延迟，稍后再刷新`
            : base;
        };
        // Pull a large board once; UI reveals it in pages of RANK_PAGE on scroll.
        // Always request without server `q` so KV/local cache can hit; filter locally.
        if (active === "hangla") {
          const data = await fetchHangLaRank({ limit: 100 });
          stale = Boolean(data._stale);
          updatedAt = data.updatedAt;
          participation = data.participation || null;
          songCount = data.songCount;
          updateRankStatsUi({
            grandTotal: participation?.total,
            modePlays: modePlaysFromParticipation(active, participation),
            songCount,
          });
          applySub(
            updatedAt ? `夯拉榜 · ${String(updatedAt).slice(0, 10)}` : "夯拉榜 · 约每 5 分钟刷新"
          );
          const hang = data.hang || [];
          const lale = data.lale || [];
          if (!hang.length && !lale.length) {
            box.innerHTML = `<p class="loading-line">暂无数据，去玩一局「从夯到拉」吧</p>`;
            return;
          }
          box.classList.add("rank-list-hangla");
          box.innerHTML = `
            <div class="rank-hangla-board">
              ${renderHangLaCol("最夯榜", hang, "hang")}
              ${renderHangLaCol("最拉榜", lale, "lale")}
            </div>`;
          return;
        }
        if (active === "labels") {
          const data = await fetchLabelBeefRank({ limit: 500, q: "" });
          stale = Boolean(data._stale);
          updatedAt = data.updatedAt;
          participation = data.participation || null;
          songCount = data.songCount;
          items = filterLabelRank(mergeLabelBeefRank(data.items || []), query);
        } else if (active === "songs") {
          const data = await fetchSongRank({ limit: 150, q: "" });
          stale = Boolean(data._stale);
          updatedAt = data.updatedAt;
          participation = data.participation || null;
          songCount = data.songCount;
          items = filterRankItemsByQuery(
            filterRankItemsByRegion(data.items || [], region, "songs"),
            query,
            "songs"
          );
        } else if (active === "artists-pk") {
          const data = await fetchArtistPkRank({ limit: 150, q: "" });
          stale = Boolean(data._stale);
          updatedAt = data.updatedAt;
          participation = data.participation || null;
          songCount = data.artistCount ?? data.songCount;
          items = filterRankItemsByQuery(
            filterRankItemsByRegion(data.items || [], region, "artists"),
            query,
            "artists"
          );
        } else if (active === "duel-king") {
          const data = await fetchDuelKingRank({ limit: 150, q: "" });
          stale = Boolean(data._stale);
          updatedAt = data.updatedAt;
          participation = data.participation || null;
          songCount = data.artistCount ?? data.songCount;
          items = filterRankItemsByQuery(
            filterRankItemsByRegion(data.items || [], region, "artists"),
            query,
            "artists"
          );
          updateRankStatsUi({
            grandTotal: participation?.total,
            modePlays: data.totalWins ?? 0,
            modeLabel: "单挑王次数",
            songCount,
            countLabel: "已入围歌手数",
          });
        } else {
          const data = await fetchArtistRank({ limit: 150, q: "" });
          stale = Boolean(data._stale);
          updatedAt = data.updatedAt;
          participation = data.participation || null;
          songCount = data.artistCount ?? data.songCount;
          items = filterRankItemsByQuery(
            filterRankItemsByRegion(data.items || [], region, "artists"),
            query,
            "artists"
          );
        }

        if (active !== "duel-king" && (!participation || songCount == null)) {
          try {
            const meta = await fetchRankMeta();
            if (!participation) participation = meta.participation || null;
            if (songCount == null) {
              songCount =
                active === "artists" || active === "artists-pk"
                  ? meta.artistCount ?? meta.songCount
                  : meta.songCount;
            }
            if (meta._stale) stale = true;
          } catch {
            /* keep list even if meta fails */
          }
        }
        if (active !== "duel-king") {
          updateRankStatsUi({
            grandTotal: participation?.total,
            modePlays: modePlaysFromParticipation(active, participation),
            songCount,
            countLabel:
              active === "artists" || active === "artists-pk"
                ? "已入围歌手数"
                : "已入围歌曲数",
          });
        }

        if (active === "songs") {
          applySub("冠军单曲排行 · 约每 5 分钟刷新");
        } else if (active === "artists") {
          const board = `${region === "west" ? "欧美" : "中文"}歌手榜 · 按单曲夺冠次数`;
          applySub(
            updatedAt ? `${board} · ${String(updatedAt).slice(0, 10)}` : `${board} · 约每 5 分钟刷新`
          );
        } else if (active === "artists-pk") {
          const board = `${region === "west" ? "欧美" : "中文"}歌手PK结果 · 按大比拼夺冠次数`;
          applySub(
            updatedAt ? `${board} · ${String(updatedAt).slice(0, 10)}` : `${board} · 约每 5 分钟刷新`
          );
        } else if (active === "duel-king") {
          const board = `${region === "west" ? "欧美" : "中文"}最强单挑王 · 按单挑夺冠次数`;
          applySub(
            updatedAt ? `${board} · ${String(updatedAt).slice(0, 10)}` : `${board} · 约每 5 分钟刷新`
          );
        } else {
          const board = "厂牌榜";
          applySub(
            updatedAt ? `${board} · ${String(updatedAt).slice(0, 10)}` : `${board} · 约每 5 分钟刷新`
          );
        }

        if (!items.length) {
          box.innerHTML = `<p class="loading-line">${
            active === "artists-pk"
              ? "暂无歌手PK结果，去打一场「歌手大比拼」吧"
              : active === "duel-king"
                ? "暂无单挑王，去打一场「谁是单挑王」吧"
                : active === "artists"
                  ? "暂无歌手数据，去打一场单曲对决吧"
                  : query
                    ? "没有匹配的结果"
                    : "暂无数据"
          }</p>`;
          return;
        }

        allItems = items;
        const first = allItems.slice(0, RANK_PAGE);
        shownCount = first.length;
        const more =
          shownCount < allItems.length
            ? `<div id="rank-more-sentinel" class="rank-more-sentinel" aria-hidden="true"></div>`
            : "";
        box.classList.remove("rank-list-hangla");
        box.innerHTML =
          first.map((item, i) => renderRankRow(item, i, active)).join("") + more;
        bindRankMore(box);
        if (active === "labels") {
          box.querySelectorAll("[data-label-matchup]").forEach((btn) => {
            btn.dataset.bound = "1";
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              openLabelMatchupModal(btn.dataset.labelMatchup, btn.dataset.labelName);
            });
          });
        }
        if (active === "duel-king") {
          box.querySelectorAll("[data-duel-songs]").forEach((btn) => {
            btn.dataset.bound = "1";
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              openDuelKingSongsModal(btn.dataset.duelSongs, btn.dataset.duelName);
            });
          });
        }
      } catch (e) {
        showLoadBanner();
        box.innerHTML = `
          <p class="loading-line">排行榜加载失败</p>
          <p class="rank-retry-hint">访问高峰时可能稍慢，请重试。若曾成功打开过，刷新后会优先显示本地缓存。</p>
          <button type="button" class="ghost-btn" id="rank-retry-btn">重新加载</button>`;
        document.getElementById("rank-retry-btn")?.addEventListener("click", () => {
          loadList(query);
        });
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
