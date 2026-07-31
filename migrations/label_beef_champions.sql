-- Champion songs per label-vs-label beef matchup (winner perspective)
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

CREATE INDEX IF NOT EXISTS idx_label_beef_champions
  ON label_beef_champions (label_id, opponent_id, wins DESC);
