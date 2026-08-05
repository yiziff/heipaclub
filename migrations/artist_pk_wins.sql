-- 歌手大比拼（artist-cup）专属夺冠榜，与歌曲夺冠归属的 artist_wins 分离
CREATE TABLE IF NOT EXISTS artist_pk_wins (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artist_pk_wins ON artist_pk_wins (wins DESC);
