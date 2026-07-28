/**
 * Cloudflare Worker for heipaclub:
 *   /api/rank/*     → D1 anonymous rankings
 *   /api/netease/*  → proxy to self-hosted api-enhanced (NETEASE_API_ORIGIN)
 *
 * Static assets / SPA are handled by Wrangler assets config.
 */

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

const DAILY_VOTE_LIMIT = 5;
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

async function resolveVoterKey(request) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const existing = clampStr(cookies[VOTER_COOKIE], 100);
  const token = existing || crypto.randomUUID();
  const ip = clampStr(request.headers.get("CF-Connecting-IP"), 80) || "ip:unknown";
  const ua = clampStr(request.headers.get("User-Agent"), 200) || "ua:unknown";
  const voterKey = await sha256Hex(`${token}|${ip}|${ua.slice(0, 80)}`);
  return {
    voterKey,
    setCookie: existing ? "" : cookieHeader(VOTER_COOKIE, token),
  };
}

async function consumeDailyQuota(env, voterKey, day, nowIso) {
  await ensureQuotaSchema(env);

  const updated = await env.DB.prepare(
    `UPDATE vote_quota_daily
     SET used_count = used_count + 1, updated_at = ?
     WHERE voter_key = ? AND quota_date = ? AND used_count < ?`
  )
    .bind(nowIso, voterKey, day, DAILY_VOTE_LIMIT)
    .run();

  if ((updated?.meta?.changes || 0) === 1) {
    const row = await env.DB.prepare(
      "SELECT used_count AS usedCount FROM vote_quota_daily WHERE voter_key = ? AND quota_date = ?"
    )
      .bind(voterKey, day)
      .first();
    const used = Number(row?.usedCount || 0);
    return { counted: true, used, remaining: Math.max(0, DAILY_VOTE_LIMIT - used) };
  }

  const existing = await env.DB.prepare(
    "SELECT used_count AS usedCount FROM vote_quota_daily WHERE voter_key = ? AND quota_date = ?"
  )
    .bind(voterKey, day)
    .first();

  if (!existing) {
    try {
      await env.DB.prepare(
        `INSERT INTO vote_quota_daily (voter_key, quota_date, used_count, updated_at)
         VALUES (?, ?, 1, ?)`
      )
        .bind(voterKey, day, nowIso)
        .run();
      return { counted: true, used: 1, remaining: DAILY_VOTE_LIMIT - 1 };
    } catch {
      // concurrent insert; fallthrough to read back
    }
  }

  const after = await env.DB.prepare(
    "SELECT used_count AS usedCount FROM vote_quota_daily WHERE voter_key = ? AND quota_date = ?"
  )
    .bind(voterKey, day)
    .first();
  const used = Number(after?.usedCount || existing?.usedCount || DAILY_VOTE_LIMIT);
  return { counted: used < DAILY_VOTE_LIMIT ? true : false, used, remaining: Math.max(0, DAILY_VOTE_LIMIT - used) };
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
    const { voterKey, setCookie } = await resolveVoterKey(request);
    const quota = await consumeDailyQuota(env, voterKey, day, now);
    if (!quota.counted) {
      const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
      if (setCookie) headers["Set-Cookie"] = setCookie;
      return new Response(
        JSON.stringify({
          ok: true,
          counted: false,
          reason: "daily_quota_exceeded",
          dailyLimit: DAILY_VOTE_LIMIT,
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
  const out = new Headers(upstream.headers);
  out.set("Access-Control-Allow-Origin", "*");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
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
