/**
 * Cloudflare Worker — anonymous rank API for 黑怕巅峰对决
 *
 * Routes (also served under site /api/rank/* via route config):
 *   GET  /api/rank/songs?limit=150&q=
 *   GET  /api/rank/artists?limit=100&q=
 *   GET  /api/rank/meta
 *   POST /api/rank/win
 *
 * Bindings: DB (D1)
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

function clampStr(s, n) {
  return String(s || "").trim().slice(0, n);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && path.endsWith("/api/rank/meta")) {
        const songCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM song_wins").first();
        const artistCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM artist_wins").first();
        const latest = await env.DB.prepare(
          "SELECT MAX(updated_at) AS t FROM song_wins"
        ).first();
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
        // Prefer cup host artist (artistName) over NetEase collab string
        const artist = clampStr(body.artistName || body.artist, 120);
        const cover = clampStr(body.cover, 500);
        const avatar = clampStr(body.avatar, 500);
        const now = new Date().toISOString();

        if (!/^\d+$/.test(songId) || !title) {
          return json({ ok: false, error: "invalid song" }, 400);
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
          const row = await env.DB.prepare(
            "SELECT wins FROM artist_wins WHERE artist_id = ?"
          )
            .bind(artistId)
            .first();
          artistWins = row?.wins ?? null;
        }

        const song = await env.DB.prepare(
          "SELECT wins FROM song_wins WHERE song_id = ?"
        )
          .bind(songId)
          .first();

        return json({ ok: true, songWins: song?.wins || 1, artistWins });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e.message || "server error" }, 500);
    }
  },
};
