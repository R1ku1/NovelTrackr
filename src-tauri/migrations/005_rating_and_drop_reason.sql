-- ============================================================
-- Migration 005: rating + drop reason
-- ============================================================
-- Applied migrations are checksummed by sqlx — never edit this file once it has
-- shipped. Add a 006 instead.

-- How much the novel was liked, 1–5. NULL means never rated.
ALTER TABLE novels ADD COLUMN rating INTEGER;

-- Why it was dropped. A fixed set of reasons rather than free text, so the stats
-- can group them; anything longer belongs in Notes.
ALTER TABLE novels ADD COLUMN drop_reason TEXT;
