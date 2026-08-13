-- 谁是单挑王：歌手夺冠次数 + 必杀曲（加冕冠军曲）次数
CREATE TABLE IF NOT EXISTS duel_king_wins (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS duel_king_songs (
  artist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (artist_id, song_id)
);

CREATE INDEX IF NOT EXISTS idx_duel_king_wins ON duel_king_wins (wins DESC);
CREATE INDEX IF NOT EXISTS idx_duel_king_songs ON duel_king_songs (artist_id, wins DESC);
