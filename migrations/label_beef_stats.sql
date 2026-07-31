-- Label beef win-rate tables (run against production D1)
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

CREATE INDEX IF NOT EXISTS idx_label_beef_stats ON label_beef_stats (wins DESC, battles DESC);
CREATE INDEX IF NOT EXISTS idx_label_beef_matchups ON label_beef_matchups (label_id, battles DESC);
