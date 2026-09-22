-- ============================================================
-- Migration 004: metadata enrichment + reading log
-- ============================================================
-- Applied migrations are checksummed by sqlx — never edit this file once it
-- has shipped. Add a 005 instead.

-- New metadata columns on novels
ALTER TABLE novels ADD COLUMN author TEXT;
ALTER TABLE novels ADD COLUMN tags TEXT;              -- JSON array of strings
ALTER TABLE novels ADD COLUMN description TEXT;
ALTER TABLE novels ADD COLUMN tag_source TEXT;        -- 'nu' | 'royalroad' | 'scribblehub' | 'novelfire' | 'manual' | NULL
ALTER TABLE novels ADD COLUMN tag_fetched_at INTEGER; -- unix epoch

-- Persistent reading history. Append-only: rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS reading_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id  INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  action    TEXT    NOT NULL,   -- 'started' | 'progressed' | 'completed' | 'dropped' | 'paused'
  chapter   INTEGER,            -- chapter number at the time of the action, when known
  timestamp INTEGER NOT NULL    -- unix epoch
);

CREATE INDEX IF NOT EXISTS idx_reading_log_novel_time ON reading_log(novel_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_reading_log_action     ON reading_log(action);
CREATE INDEX IF NOT EXISTS idx_reading_log_timestamp  ON reading_log(timestamp);

-- Canonical tag vocabulary cache (populated from NovelUpdates once)
CREATE TABLE IF NOT EXISTS tag_vocabulary (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  category   TEXT,              -- optional: 'genre' | 'theme' | 'content' etc.
  fetched_at INTEGER NOT NULL
);

-- Seed: novels that already exist have no history, so record their current status
-- once, dated from their last known progress/update. Planned novels never started.
-- Best effort only — it cannot recover true order or true timestamps.
INSERT INTO reading_log (novel_id, action, chapter, timestamp)
SELECT n.id,
       CASE n.status
         WHEN 'reading'   THEN 'started'
         WHEN 'completed' THEN 'completed'
         WHEN 'dropped'   THEN 'dropped'
         WHEN 'paused'    THEN 'paused'
       END,
       CAST(p.chapter_sort AS INTEGER),
       CAST(strftime('%s', COALESCE(p.updated_at, n.updated_at)) AS INTEGER)
FROM novels n
LEFT JOIN progress p ON p.novel_id = n.id
WHERE n.status IN ('reading', 'completed', 'dropped', 'paused');
