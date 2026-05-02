CREATE TABLE IF NOT EXISTS novels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_title TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'reading',
  notes       TEXT NOT NULL DEFAULT '',
  cover_url   TEXT NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS aliases (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id  INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  alias     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id         INTEGER NOT NULL UNIQUE REFERENCES novels(id) ON DELETE CASCADE,
  chapter_raw      TEXT NOT NULL DEFAULT '',
  chapter_sort     REAL,
  updated_at       DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  novel_id      INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  domain        TEXT NOT NULL,
  url_pattern   TEXT NOT NULL DEFAULT '',
  is_preferred  INTEGER NOT NULL DEFAULT 0,
  last_seen_url TEXT NOT NULL DEFAULT '',
  last_seen_at  DATETIME
);

CREATE TABLE IF NOT EXISTS site_mappings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  domain         TEXT NOT NULL,
  detected_title TEXT NOT NULL,
  novel_id       INTEGER NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  confirmed_at   DATETIME NOT NULL DEFAULT (datetime('now')),
  UNIQUE(domain, detected_title)
);