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

CREATE TABLE IF NOT EXISTS vote_quota_daily (
  voter_key TEXT NOT NULL,
  quota_date TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (voter_key, quota_date)
);

CREATE TABLE IF NOT EXISTS analytics_events_daily (
  event_date TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_date, event_name)
);

CREATE TABLE IF NOT EXISTS analytics_event_uniques (
  event_date TEXT NOT NULL,
  event_name TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_date, event_name, visitor_key)
);

CREATE INDEX IF NOT EXISTS idx_song_wins ON song_wins (wins DESC);
CREATE INDEX IF NOT EXISTS idx_artist_wins ON artist_wins (wins DESC);
CREATE INDEX IF NOT EXISTS idx_vote_quota_date ON vote_quota_daily (quota_date, used_count DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_date ON analytics_events_daily (event_date DESC, event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_uniques_date ON analytics_event_uniques (event_date DESC);

-- Label beef (厂牌巅峰混战): one finished cup = 1 battle for both; champion gets 1 win.
CREATE TABLE IF NOT EXISTS label_beef_stats (
  label_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  battles INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS label_beef_matchups (
  label_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  battles INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (label_id, opponent_id)
);

CREATE TABLE IF NOT EXISTS label_beef_champions (
  label_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (label_id, opponent_id, song_id)
);

CREATE INDEX IF NOT EXISTS idx_label_beef_stats ON label_beef_stats (wins DESC, battles DESC);
CREATE INDEX IF NOT EXISTS idx_label_beef_matchups ON label_beef_matchups (label_id, battles DESC);
CREATE INDEX IF NOT EXISTS idx_label_beef_champions
  ON label_beef_champions (label_id, opponent_id, wins DESC);

-- 「从夯到拉」：获得「夯」/「拉完了」次数
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
