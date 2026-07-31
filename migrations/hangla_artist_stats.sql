-- Hang-La tier counts (夯 / 拉完了) per roster artist
CREATE TABLE IF NOT EXISTS hangla_artist_stats (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  hang_wins INTEGER NOT NULL DEFAULT 0,
  lale_wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hangla_hang ON hangla_artist_stats (hang_wins DESC, name ASC);
CREATE INDEX IF NOT EXISTS idx_hangla_lale ON hangla_artist_stats (lale_wins DESC, name ASC);
