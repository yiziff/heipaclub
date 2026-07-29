/**
 * Cloudflare Worker for heipaclub:
 *   /api/rank/*     → D1 anonymous rankings
 *   /api/netease/*  → proxy to self-hosted api-enhanced (NETEASE_API_ORIGIN)
 *   /api/img        → CORS-safe cover image proxy (html-to-image export)
 *
 * Static assets / SPA are handled by Wrangler assets config.
 */

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

/**
 * 防刷：
 * - 每浏览器 Cookie 每天最多 DAILY_VOTE_LIMIT 次（主限额）
 * - 每公网 IP 每天最多 DAILY_IP_LIMIT 次（清 Cookie / 多浏览器兜底）
 *
 * 不要把 IP/UA 混进 Cookie 身份哈希——手机切 4G/WiFi 会换出口，限额会失效。
 */
const DAILY_VOTE_LIMIT = 5;
const DAILY_IP_LIMIT = 15;
const VOTER_COOKIE = "cup_voter_id";
let quotaSchemaReady = false;

function clampStr(s, n) {
  return String(s || "").trim().slice(0, n);
}

function parseCookies(cookieHeader) {
  const jar = {};
  const raw = String(cookieHeader || "");
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    jar[k] = decodeURIComponent(rest.join("=") || "");
  }
  return jar;
}

function cookieHeader(name, value, { maxAge = 60 * 60 * 24 * 365, path = "/", sameSite = "Lax" } = {}) {
  const chunks = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    `SameSite=${sameSite}`,
    "HttpOnly",
    "Secure",
  ];
  return chunks.join("; ");
}

function dayKeyUTC8(d = new Date()) {
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function sha256Hex(input) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(input || ""))).then((buf) => {
    const arr = Array.from(new Uint8Array(buf));
    return arr.map((x) => x.toString(16).padStart(2, "0")).join("");
  });
}

function clientIp(request) {
  return (
    clampStr(request.headers.get("CF-Connecting-IP"), 80) ||
    clampStr(request.headers.get("X-Forwarded-For")?.split(",")[0], 80) ||
    "ip:unknown"
  );
}

async function ensureQuotaSchema(env) {
  if (quotaSchemaReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS vote_quota_daily (
      voter_key TEXT NOT NULL,
      quota_date TEXT NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (voter_key, quota_date)
    )`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_vote_quota_date ON vote_quota_daily (quota_date, used_count DESC)`
  ).run();
  quotaSchemaReady = true;
}

async function resolveVoterIdentity(request) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const existing = clampStr(cookies[VOTER_COOKIE], 100);
  const token = existing || crypto.randomUUID();
  const cookieKey = `c:${await sha256Hex(`v1:${token}`)}`;
  const ipKey = `ip:${await sha256Hex(`v1:${clientIp(request)}`)}`;
  return {
    cookieKey,
    ipKey,
    setCookie: existing ? "" : cookieHeader(VOTER_COOKIE, token),
  };
}

async function getQuotaUsed(env, voterKey, day) {
  const row = await env.DB.prepare(
    "SELECT used_count AS usedCount FROM vote_quota_daily WHERE voter_key = ? AND quota_date = ?"
  )
    .bind(voterKey, day)
    .first();
  return Number(row?.usedCount || 0);
}

/** 原子尝试消耗 1 次日配额 */
async function consumeDailyQuota(env, voterKey, day, nowIso, limit) {
  await ensureQuotaSchema(env);

  const updated = await env.DB.prepare(
    `UPDATE vote_quota_daily
     SET used_count = used_count + 1, updated_at = ?
     WHERE voter_key = ? AND quota_date = ? AND used_count < ?`
  )
    .bind(nowIso, voterKey, day, limit)
    .run();

  if ((updated?.meta?.changes || 0) >= 1) {
    const used = await getQuotaUsed(env, voterKey, day);
    return { counted: true, used, remaining: Math.max(0, limit - used) };
  }

  const existingUsed = await getQuotaUsed(env, voterKey, day);
  if (existingUsed > 0) {
    return { counted: false, used: existingUsed, remaining: 0 };
  }

  try {
    await env.DB.prepare(
      `INSERT INTO vote_quota_daily (voter_key, quota_date, used_count, updated_at)
       VALUES (?, ?, 1, ?)`
    )
      .bind(voterKey, day, nowIso)
      .run();
    return { counted: true, used: 1, remaining: limit - 1 };
  } catch {
    const retry = await env.DB.prepare(
      `UPDATE vote_quota_daily
       SET used_count = used_count + 1, updated_at = ?
       WHERE voter_key = ? AND quota_date = ? AND used_count < ?`
    )
      .bind(nowIso, voterKey, day, limit)
      .run();
    if ((retry?.meta?.changes || 0) >= 1) {
      const used = await getQuotaUsed(env, voterKey, day);
      return { counted: true, used, remaining: Math.max(0, limit - used) };
    }
    const used = await getQuotaUsed(env, voterKey, day);
    return { counted: false, used: used || limit, remaining: 0 };
  }
}

/** Cookie + IP 双限额；任一侧满则不计票 */
async function consumeVoteQuotas(env, cookieKey, ipKey, day, nowIso) {
  await ensureQuotaSchema(env);
  const cookieUsed = await getQuotaUsed(env, cookieKey, day);
  const ipUsed = await getQuotaUsed(env, ipKey, day);

  if (cookieUsed >= DAILY_VOTE_LIMIT) {
    return {
      counted: false,
      reason: "daily_quota_exceeded",
      used: cookieUsed,
      remaining: 0,
      ipUsed,
    };
  }
  if (ipUsed >= DAILY_IP_LIMIT) {
    return {
      counted: false,
      reason: "ip_quota_exceeded",
      used: cookieUsed,
      remaining: 0,
      ipUsed,
    };
  }

  const cookie = await consumeDailyQuota(env, cookieKey, day, nowIso, DAILY_VOTE_LIMIT);
  if (!cookie.counted) {
    return {
      counted: false,
      reason: "daily_quota_exceeded",
      used: cookie.used,
      remaining: 0,
      ipUsed,
    };
  }

  const ip = await consumeDailyQuota(env, ipKey, day, nowIso, DAILY_IP_LIMIT);
  if (!ip.counted) {
    await env.DB.prepare(
      `UPDATE vote_quota_daily
       SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END, updated_at = ?
       WHERE voter_key = ? AND quota_date = ?`
    )
      .bind(nowIso, cookieKey, day)
      .run();
    return {
      counted: false,
      reason: "ip_quota_exceeded",
      used: Math.max(0, cookie.used - 1),
      remaining: 0,
      ipUsed: ip.used,
    };
  }

  return {
    counted: true,
    reason: null,
    used: cookie.used,
    remaining: cookie.remaining,
    ipUsed: ip.used,
  };
}

async function handleRank(request, env, path, url) {
  if (request.method === "GET" && path.endsWith("/api/rank/meta")) {
    const songCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM song_wins").first();
    const artistCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM artist_wins").first();
    const latest = await env.DB.prepare("SELECT MAX(updated_at) AS t FROM song_wins").first();
    return json({
      updatedAt: latest?.t || null,
      songCount: songCount?.c || 0,
      artistCount: artistCount?.c || 0,
    });
  }

  if (request.method === "GET" && path.endsWith("/api/rank/songs")) {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 150)));
    const q = clampStr(url.searchParams.get("q"), 80).toLowerCase();
    let rows;
    if (q) {
      rows = await env.DB.prepare(
        `SELECT song_id AS songId, title, artist, cover, artist_id AS artistId, wins, updated_at AS updatedAt
         FROM song_wins
         WHERE lower(title) LIKE ? OR lower(artist) LIKE ?
         ORDER BY wins DESC, title ASC LIMIT ?`
      )
        .bind(`%${q}%`, `%${q}%`, limit)
        .all();
    } else {
      rows = await env.DB.prepare(
        `SELECT song_id AS songId, title, artist, cover, artist_id AS artistId, wins, updated_at AS updatedAt
         FROM song_wins ORDER BY wins DESC, title ASC LIMIT ?`
      )
        .bind(limit)
        .all();
    }
    const latest = rows.results?.[0]?.updatedAt || null;
    return json({ updatedAt: latest, items: rows.results || [] });
  }

  if (request.method === "GET" && path.endsWith("/api/rank/artists")) {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
    const q = clampStr(url.searchParams.get("q"), 80).toLowerCase();
    let rows;
    if (q) {
      rows = await env.DB.prepare(
        `SELECT artist_id AS artistId, name, avatar, wins, updated_at AS updatedAt
         FROM artist_wins WHERE lower(name) LIKE ?
         ORDER BY wins DESC, name ASC LIMIT ?`
      )
        .bind(`%${q}%`, limit)
        .all();
    } else {
      rows = await env.DB.prepare(
        `SELECT artist_id AS artistId, name, avatar, wins, updated_at AS updatedAt
         FROM artist_wins ORDER BY wins DESC, name ASC LIMIT ?`
      )
        .bind(limit)
        .all();
    }
    return json({ updatedAt: rows.results?.[0]?.updatedAt || null, items: rows.results || [] });
  }

  if (request.method === "POST" && path.endsWith("/api/rank/win")) {
    const body = await request.json().catch(() => ({}));
    const songId = clampStr(body.songId, 32);
    const artistId = clampStr(body.artistId, 32);
    const title = clampStr(body.title, 120);
    const artist = clampStr(body.artistName || body.artist, 120);
    const cover = clampStr(body.cover, 500);
    const avatar = clampStr(body.avatar, 500);
    const now = new Date().toISOString();

    if (!/^\d+$/.test(songId) || !title) {
      return json({ ok: false, error: "invalid song" }, 400);
    }

    const day = dayKeyUTC8(new Date());
    const { cookieKey, ipKey, setCookie } = await resolveVoterIdentity(request);
    const quota = await consumeVoteQuotas(env, cookieKey, ipKey, day, now);
    if (!quota.counted) {
      const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
      if (setCookie) headers["Set-Cookie"] = setCookie;
      return new Response(
        JSON.stringify({
          ok: true,
          counted: false,
          reason: quota.reason || "daily_quota_exceeded",
          dailyLimit: DAILY_VOTE_LIMIT,
          ipDailyLimit: DAILY_IP_LIMIT,
          usedToday: quota.used,
          remainingToday: quota.remaining,
        }),
        { status: 200, headers }
      );
    }

    await env.DB.prepare(
      `INSERT INTO song_wins (song_id, title, artist, cover, artist_id, wins, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(song_id) DO UPDATE SET
         title = excluded.title,
         artist = excluded.artist,
         cover = CASE WHEN excluded.cover != '' THEN excluded.cover ELSE song_wins.cover END,
         artist_id = CASE WHEN excluded.artist_id != '' THEN excluded.artist_id ELSE song_wins.artist_id END,
         wins = song_wins.wins + 1,
         updated_at = excluded.updated_at`
    )
      .bind(songId, title, artist, cover, artistId || "", now)
      .run();

    let artistWins = null;
    if (artistId && /^\d+$/.test(artistId)) {
      await env.DB.prepare(
        `INSERT INTO artist_wins (artist_id, name, avatar, wins, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(artist_id) DO UPDATE SET
           name = excluded.name,
           avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE artist_wins.avatar END,
           wins = artist_wins.wins + 1,
           updated_at = excluded.updated_at`
      )
        .bind(artistId, artist || "未知歌手", avatar || cover, now)
        .run();
      const row = await env.DB.prepare("SELECT wins FROM artist_wins WHERE artist_id = ?")
        .bind(artistId)
        .first();
      artistWins = row?.wins ?? null;
    }

    const song = await env.DB.prepare("SELECT wins FROM song_wins WHERE song_id = ?")
      .bind(songId)
      .first();

    const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
    if (setCookie) headers["Set-Cookie"] = setCookie;
    return new Response(
      JSON.stringify({
        ok: true,
        counted: true,
        dailyLimit: DAILY_VOTE_LIMIT,
        ipDailyLimit: DAILY_IP_LIMIT,
        usedToday: quota.used,
        remainingToday: quota.remaining,
        songWins: song?.wins || 1,
        artistWins,
      }),
      { status: 200, headers }
    );
  }

  return json({ error: "not found" }, 404);
}

/** 冷门歌手热门包 TTL：24 小时 */
const ARTIST_TOP_TTL_SEC = 60 * 60 * 24;

async function proxyNetease(request, env, url) {
  const origin = String(env.NETEASE_API_ORIGIN || "").replace(/\/+$/, "");
  if (!origin) {
    return json(
      {
        error: "NETEASE_API_ORIGIN not configured",
        hint: "Deploy api-enhanced somewhere, then set wrangler var / secret NETEASE_API_ORIGIN",
      },
      503
    );
  }

  const stripped = url.pathname.replace(/^\/api\/netease/, "") || "/";
  const target = new URL(stripped + url.search, origin + "/");

  // 冷门歌手热门榜：透传路径上的 KV 记忆（24h），避免反复打源站
  const topSongId = artistTopSongIdFromPath(stripped, url);
  if (request.method === "GET" && topSongId && env.ARTIST_TOP) {
    const cacheKey = `raw:top:v1:${topSongId}`;
    try {
      const hit = await env.ARTIST_TOP.get(cacheKey);
      if (hit) {
        return new Response(hit, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Artist-Top-Cache": "HIT",
            "Cache-Control": "public, max-age=60",
            ...cors,
          },
        });
      }
    } catch {
      /* ignore cache read errors */
    }
  }

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("content-length");

  const init = {
    method: request.method,
    headers,
    redirect: "follow",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  const upstream = await fetch(target.toString(), init);

  if (
    request.method === "GET" &&
    topSongId &&
    env.ARTIST_TOP &&
    upstream.ok
  ) {
    try {
      const text = await upstream.text();
      const cacheKey = `raw:top:v1:${topSongId}`;
      await env.ARTIST_TOP.put(cacheKey, text, {
        expirationTtl: ARTIST_TOP_TTL_SEC,
      });
      return new Response(text, {
        status: 200,
        headers: {
          "Content-Type":
            upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
          "X-Artist-Top-Cache": "MISS",
          "Cache-Control": "public, max-age=60",
          ...cors,
        },
      });
    } catch {
      /* fall through — body already consumed; re-fetch unlikely needed */
    }
  }

  const out = new Headers(upstream.headers);
  out.set("Access-Control-Allow-Origin", "*");
  out.set("X-Artist-Top-Cache", "BYPASS");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

function artistTopSongIdFromPath(stripped, url) {
  const p = String(stripped || "").replace(/\/+$/, "");
  if (p !== "/artist/top/song" && p !== "artist/top/song") return "";
  const id = String(url.searchParams.get("id") || "").trim();
  return /^\d+$/.test(id) ? id : "";
}

function sanitizeCachedSong(s) {
  return {
    id: clampStr(s?.id || s?.neteaseId, 32),
    neteaseId: clampStr(s?.neteaseId || s?.id, 32),
    title: clampStr(s?.title, 120),
    artist: clampStr(s?.artist, 120),
    album: clampStr(s?.album || s?.collection, 120),
    collection: clampStr(s?.collection || s?.album, 120),
    cover: clampStr(s?.cover, 500),
    coverSm: clampStr(s?.coverSm || s?.cover, 500),
    duration_ms: Number.isFinite(Number(s?.duration_ms)) ? Number(s.duration_ms) : null,
    year: clampStr(s?.year, 8),
    publishTime: Number.isFinite(Number(s?.publishTime)) ? Number(s.publishTime) : null,
  };
}

async function handleArtistTopCache(request, env, path, url) {
  if (!env.ARTIST_TOP) {
    return json({ error: "KV binding ARTIST_TOP missing" }, 503);
  }

  if (request.method === "GET") {
    const id = clampStr(url.searchParams.get("id"), 32);
    if (!/^\d+$/.test(id)) return json({ ok: false, error: "bad id" }, 400);
    const pack = await env.ARTIST_TOP.get(`pack:v1:${id}`, "json");
    if (!pack?.songs?.length) {
      return json({ ok: false, hit: false }, 404);
    }
    return json({
      ok: true,
      hit: true,
      ttlSec: ARTIST_TOP_TTL_SEC,
      ...pack,
    });
  }

  if (request.method === "PUT" || request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const id = clampStr(body.neteaseArtistId || body.id, 32);
    const songsIn = Array.isArray(body.songs) ? body.songs : [];
    if (!/^\d+$/.test(id) || !songsIn.length) {
      return json({ ok: false, error: "invalid pack" }, 400);
    }
    const songs = songsIn
      .slice(0, 100)
      .map(sanitizeCachedSong)
      .filter((s) => /^\d+$/.test(s.id) && s.title);
    if (!songs.length) return json({ ok: false, error: "no songs" }, 400);

    const pack = {
      neteaseArtistId: id,
      name: clampStr(body.name, 120),
      avatar: clampStr(body.avatar, 500),
      songs,
      cachedAt: new Date().toISOString(),
    };
    await env.ARTIST_TOP.put(`pack:v1:${id}`, JSON.stringify(pack), {
      expirationTtl: ARTIST_TOP_TTL_SEC,
    });
    return json({ ok: true, ttlSec: ARTIST_TOP_TTL_SEC, songCount: songs.length });
  }

  return json({ error: "method not allowed" }, 405);
}

function isAllowedCoverHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return (
    h === "music.126.net" ||
    h.endsWith(".music.126.net") ||
    h.endsWith(".126.net") ||
    h === "mzstatic.com" ||
    h.endsWith(".mzstatic.com") ||
    h === "y.gtimg.cn" ||
    h.endsWith(".gtimg.cn")
  );
}

async function proxyCoverImage(url) {
  const raw = url.searchParams.get("u") || "";
  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: "bad url" }, 400);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return json({ error: "bad protocol" }, 400);
  }
  if (!isAllowedCoverHost(target.hostname)) {
    return json({ error: "host not allowed" }, 403);
  }

  const upstream = await fetch(target.toString(), {
    headers: {
      Referer: "https://music.163.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  });

  if (!upstream.ok) {
    return new Response(null, {
      status: upstream.status,
      headers: { ...cors, "Cache-Control": "no-store" },
    });
  }

  const ctype = upstream.headers.get("Content-Type") || "image/jpeg";
  if (!ctype.startsWith("image/") && ctype !== "application/octet-stream") {
    return json({ error: "not an image" }, 415);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": ctype.startsWith("image/") ? ctype : "image/jpeg",
      "Cache-Control": "public, max-age=86400, immutable",
      ...cors,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/api/img" || path.startsWith("/api/img/")) {
        return await proxyCoverImage(url);
      }

      if (path === "/api/artist-top" || path.startsWith("/api/artist-top/")) {
        return await handleArtistTopCache(request, env, path, url);
      }

      if (path.startsWith("/api/rank")) {
        if (!env.DB) {
          return json({ error: "D1 binding DB missing" }, 503);
        }
        return await handleRank(request, env, path, url);
      }

      if (path.startsWith("/api/netease")) {
        return await proxyNetease(request, env, url);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e.message || "server error" }, 500);
    }
  },
};
