/**
 * Compact NetEase player card (same idea as song-vocab-agent learn player).
 */

import { neteaseSongPage, songPlayUrl } from "./netease.js";

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function createPlayer(root) {
  root.innerHTML = `
    <div class="player-card" id="cup-player" hidden>
      <div class="player-card-top">
        <div class="cover-thumb empty" id="cup-cover" aria-hidden="true"></div>
        <div class="player-meta-text">
          <div class="song-title" id="cup-title">选一首歌试听</div>
          <div class="song-sub" id="cup-sub">网易云直通播放</div>
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
        <a class="ghost-link" id="cup-open" href="#" target="_blank" rel="noopener">在网易云打开</a>
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

  function setPlayingUi(on) {
    card.classList.toggle("is-playing", on);
    playBtn.textContent = on ? "暂停" : "播放";
  }

  function paintMeta(song) {
    title.textContent = song.title || "未知曲目";
    sub.textContent =
      [song.artist, song.album || song.collection].filter(Boolean).join(" · ") || "网易云";
    if (song.cover) {
      cover.style.backgroundImage = `url("${song.cover}")`;
      cover.classList.remove("empty");
    } else {
      cover.style.backgroundImage = "";
      cover.classList.add("empty");
    }
    if (song.neteaseId) {
      openLink.href = neteaseSongPage(song.neteaseId);
      openLink.hidden = false;
    } else {
      openLink.hidden = true;
    }
  }

  async function load(song, { autoplay = true } = {}) {
    current = song;
    card.hidden = false;
    paintMeta(song);
    hint.textContent = "拉取播放地址中…";
    setPlayingUi(false);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();

    if (!song?.neteaseId) {
      hint.textContent = "这首歌没有网易云 id，无法直通播放。";
      return;
    }

    const url = await songPlayUrl(song.neteaseId);
    if (!url) {
      hint.textContent = "暂时拿不到播放链（可能需登录 cookie / 无版权），可点「在网易云打开」。";
      return;
    }

    audio.src = url;
    hint.textContent = "";
    if (autoplay) {
      try {
        await audio.play();
        setPlayingUi(true);
      } catch {
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
        hint.textContent = "播放失败，试试「在网易云打开」。";
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
      audio.pause();
      setPlayingUi(false);
    },
  };
}
