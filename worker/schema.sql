-- D1 schema for anonymous cup rankings
CREATE TABLE IF NOT EXISTS song_wins (
  song_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  artist_id TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artist_wins (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_song_wins ON song_wins (wins DESC);
CREATE INDEX IF NOT EXISTS idx_artist_wins ON artist_wins (wins DESC);
