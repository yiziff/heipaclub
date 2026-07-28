/**
 * Hybrid player: iTunes previewUrl first, NetEase api-enhanced fallback.
 */

import { neteaseSongPage, songPlayUrl } from "./netease.js";
import { resolvePlaySource } from "./itunes.js";

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sourceLabel(song) {
  if (song?.playSource === "itunes" || song?.previewUrl) return "Apple 试听 · 约 30 秒";
  return "网易云播放";
}

export function createPlayer(root) {
  root.innerHTML = `
    <div class="player-card" id="cup-player" hidden>
      <div class="player-card-top">
        <div class="cover-thumb empty" id="cup-cover" aria-hidden="true"></div>
        <div class="player-meta-text">
          <div class="song-title" id="cup-title">选一首歌试听</div>
          <div class="song-sub" id="cup-sub">iTunes 优先 · 网易云兜底</div>
        </div>
      </div>
      <audio id="cup-audio" preload="metadata"></audio>
      <div class="scrubber">
        <span class="t" id="cup-cur">0:00</span>
        <input type="range" id="cup-seek" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
        <span class="t" id="cup-dur">0:00</span>
      </div>
      <div class="player-actions">
        <button type="button" id="cup-play">播放</button>
        <a class="ghost-link" id="cup-open" href="#" target="_blank" rel="noopener">外链打开</a>
      </div>
      <p class="player-hint" id="cup-hint"></p>
    </div>
  `;

  const card = root.querySelector("#cup-player");
  const audio = root.querySelector("#cup-audio");
  const cover = root.querySelector("#cup-cover");
  const title = root.querySelector("#cup-title");
  const sub = root.querySelector("#cup-sub");
  const cur = root.querySelector("#cup-cur");
  const dur = root.querySelector("#cup-dur");
  const seek = root.querySelector("#cup-seek");
  const playBtn = root.querySelector("#cup-play");
  const openLink = root.querySelector("#cup-open");
  const hint = root.querySelector("#cup-hint");

  let current = null;
  let seeking = false;
  /** Bump to cancel in-flight load()/play() after stop or newer load. */
  let loadSeq = 0;

  function hardStopAudio() {
    audio.pause();
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch {
      /* ignore */
    }
  }

  function setPlayingUi(on) {
    card.classList.toggle("is-playing", on);
    playBtn.textContent = on ? "暂停" : "播放";
  }

  function paintMeta(song) {
    title.textContent = song.title || "未知曲目";
    const meta = [song.artist, song.album || song.collection].filter(Boolean).join(" · ");
    sub.textContent = [meta, sourceLabel(song)].filter(Boolean).join(" · ") || sourceLabel(song);
    if (song.cover) {
      cover.style.backgroundImage = `url("${song.cover}")`;
      cover.classList.remove("empty");
    } else {
      cover.style.backgroundImage = "";
      cover.classList.add("empty");
    }

    const useItunes = song.playSource === "itunes" || Boolean(song.previewUrl);
    if (useItunes && song.trackViewUrl) {
      openLink.href = song.trackViewUrl;
      openLink.textContent = "在 Apple Music 打开";
      openLink.hidden = false;
    } else if (song.neteaseId) {
      openLink.href = neteaseSongPage(song.neteaseId);
      openLink.textContent = "在网易云打开";
      openLink.hidden = false;
    } else {
      openLink.hidden = true;
    }
  }

  async function resolveUrl(song) {
    const preferItunes =
      song?.playSource === "itunes" ||
      (Boolean(song?.previewUrl) && song?.playSource !== "netease");
    if (preferItunes && song.previewUrl) {
      return { url: song.previewUrl, via: "itunes", song };
    }
    if (song?.neteaseId) {
      const url = await songPlayUrl(song.neteaseId);
      if (url) return { url, via: "netease", song };
    }
    if (song?.previewUrl) {
      return { url: song.previewUrl, via: "itunes", song };
    }
    return { url: null, via: null, song };
  }

  async function load(song, { autoplay = true, artistName = "", artistAliases = [] } = {}) {
    const seq = ++loadSeq;
    current = song;
    card.hidden = false;
    paintMeta(song);
    hint.textContent = "拉取播放地址中…";
    setPlayingUi(false);
    hardStopAudio();

    let working = song;
    let { url, via } = await resolveUrl(working);
    if (seq !== loadSeq) return;

    // NetEase often returns null (no cookie / no right) — retry iTunes match
    if (!url) {
      try {
        working = await resolvePlaySource(working, artistName || working.artist || "", {
          artistAliases,
          bypassCache: working.playSource === "netease",
        });
        if (seq !== loadSeq) return;
        current = working;
        paintMeta(working);
        ({ url, via } = await resolveUrl(working));
        if (seq !== loadSeq) return;
      } catch {
        /* keep failed */
      }
    }

    if (seq !== loadSeq) return;

    if (!url) {
      if (!working?.neteaseId && !working?.previewUrl) {
        hint.textContent = "没有可用的试听源。";
      } else {
        hint.textContent =
          "暂时拿不到播放链（网易云无版权或需登录；iTunes 未匹配），可点外链打开。";
      }
      return;
    }

    if (via === "itunes") {
      current = { ...working, playSource: "itunes", previewUrl: url };
      paintMeta(current);
      hint.textContent = "Apple 官方试听（约 30 秒）";
    } else {
      current = { ...working, playSource: "netease" };
      paintMeta(current);
      hint.textContent = "";
    }

    audio.src = url;
    if (autoplay) {
      try {
        if (seq !== loadSeq) return;
        await audio.play();
        if (seq !== loadSeq) {
          hardStopAudio();
          setPlayingUi(false);
          return;
        }
        setPlayingUi(true);
        if (via === "itunes") hint.textContent = "Apple 官方试听（约 30 秒）";
        else hint.textContent = "";
      } catch {
        if (seq !== loadSeq) return;
        hint.textContent = "浏览器拦截了自动播放，点「播放」即可。";
        setPlayingUi(false);
      }
    }
  }

  playBtn.addEventListener("click", async () => {
    if (!audio.src) {
      if (current) await load(current, { autoplay: true });
      return;
    }
    if (audio.paused) {
      try {
        await audio.play();
        setPlayingUi(true);
      } catch {
        hint.textContent = "播放失败，试试外链打开。";
      }
    } else {
      audio.pause();
      setPlayingUi(false);
    }
  });

  audio.addEventListener("timeupdate", () => {
    if (seeking) return;
    const d = audio.duration || 0;
    cur.textContent = fmt(audio.currentTime);
    dur.textContent = fmt(d);
    if (d > 0) seek.value = String(Math.round((audio.currentTime / d) * 1000));
  });

  audio.addEventListener("ended", () => setPlayingUi(false));
  audio.addEventListener("pause", () => setPlayingUi(false));
  audio.addEventListener("play", () => setPlayingUi(true));

  seek.addEventListener("pointerdown", () => {
    seeking = true;
  });
  seek.addEventListener("pointerup", () => {
    seeking = false;
    const d = audio.duration || 0;
    if (d > 0) audio.currentTime = (Number(seek.value) / 1000) * d;
  });
  seek.addEventListener("input", () => {
    const d = audio.duration || 0;
    if (d > 0) cur.textContent = fmt((Number(seek.value) / 1000) * d);
  });

  return {
    el: card,
    load,
    stop() {
      loadSeq += 1;
      hardStopAudio();
      setPlayingUi(false);
      hint.textContent = "";
    },
  };
}

/** Pause/clear every <audio> on the page (orphaned nodes after route swaps). */
export function stopAllPageAudio() {
  document.querySelectorAll("audio").forEach((a) => {
    try {
      a.pause();
      a.removeAttribute("src");
      a.load();
    } catch {
      /* ignore */
    }
  });
}
