-- ============================================================
-- Migration 006: latest chapter, best effort
-- ============================================================
-- Applied migrations are checksummed by sqlx — never edit this file once it has
-- shipped. Add a 007 instead.

-- The highest chapter number the extension has actually seen on a page. Nullable
-- and often NULL: nothing here is ever guessed, and a novel nobody has browsed
-- lately simply has no value. Fractional because sites release 10.5s.
ALTER TABLE novels ADD COLUMN latest_chapter REAL;

-- How much that number is worth:
--   'exact'       read off a chapter menu or a table of contents
--   'lower_bound' a partial list, so the real latest is at least this
--   'caught_up'   no way forward from the chapter being read
ALTER TABLE novels ADD COLUMN latest_chapter_confidence TEXT;

-- Unix epoch, the same clock as reading_log.timestamp. NULL means never observed.
ALTER TABLE novels ADD COLUMN latest_chapter_seen_at INTEGER;

-- The chapter count of an actual table of contents. Kept apart from
-- latest_chapter because the two come from different evidence and can disagree
-- (a ToC page can be paginated).
ALTER TABLE novels ADD COLUMN total_chapters REAL;
ALTER TABLE novels ADD COLUMN total_chapters_seen_at INTEGER;
