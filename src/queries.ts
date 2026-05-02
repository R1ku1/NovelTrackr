import { getDb } from "./db";
import type { Status } from "./formComponents";

export interface NovelRow {
  id: number;
  canonical_title: string;
  status: Status;
  notes: string;
  cover_url: string;
  current_chapter_raw: string | null;
  chapter_sort: number | null;
  updated_at: string;
  aliases: string[];
}

// ── Fetch all novels with their current progress and aliases ──────────────────
export async function getAllNovels(): Promise<NovelRow[]> {
  const db = await getDb();

  const novels = await db.select<any[]>(`
    SELECT
      n.id, n.canonical_title, n.status, n.notes, n.cover_url,
      p.chapter_raw as current_chapter_raw,
      p.chapter_sort,
      COALESCE(p.updated_at, n.updated_at) as updated_at
    FROM novels n
    LEFT JOIN progress p ON p.novel_id = n.id
    ORDER BY COALESCE(p.updated_at, n.updated_at) DESC
  `);

  // Fetch aliases separately and attach
  const aliases = await db.select<{ novel_id: number; alias: string }[]>(
    `SELECT novel_id, alias FROM aliases`
  );

  return novels.map((n) => ({
    ...n,
    aliases: aliases.filter((a) => a.novel_id === n.id).map((a) => a.alias),
  }));
}

// ── Add a novel ───────────────────────────────────────────────────────────────
export async function addNovel(data: {
  canonical_title: string;
  status: string;
  notes: string;
  cover_url: string;
  current_chapter_raw: string;
  aliases: string[];
}): Promise<number> {
  const db = await getDb();

  const result = await db.execute(
    `INSERT INTO novels (canonical_title, status, notes, cover_url)
     VALUES ($1, $2, $3, $4)`,
    [data.canonical_title, data.status, data.notes, data.cover_url]
  );

  const novelId = result.lastInsertId;
  if (novelId === undefined) throw new Error("Insert failed — no ID returned");

  // Insert progress row if chapter provided
  if (data.current_chapter_raw.trim()) {
    const chapterSort = parseChapterSort(data.current_chapter_raw);
    await db.execute(
      `INSERT INTO progress (novel_id, chapter_raw, chapter_sort)
       VALUES ($1, $2, $3)`,
      [novelId, data.current_chapter_raw, chapterSort]
    );
  }

  // Insert aliases
  for (const alias of data.aliases) {
    await db.execute(
      `INSERT INTO aliases (novel_id, alias) VALUES ($1, $2)`,
      [novelId, alias]
    );
  }

  return novelId;
}

// ── Update a novel ────────────────────────────────────────────────────────────
export async function updateNovel(data: {
  id: number;
  canonical_title: string;
  status: string;
  notes: string;
  cover_url: string;
  current_chapter_raw: string;
  aliases: string[];
}): Promise<void> {
  const db = await getDb();

  await db.execute(
    `UPDATE novels
     SET canonical_title=$1, status=$2, notes=$3, cover_url=$4,
         updated_at=datetime('now')
     WHERE id=$5`,
    [data.canonical_title, data.status, data.notes, data.cover_url, data.id]
  );

  // Upsert progress
  if (data.current_chapter_raw.trim()) {
    const chapterSort = parseChapterSort(data.current_chapter_raw);
    await db.execute(
      `INSERT INTO progress (novel_id, chapter_raw, chapter_sort, updated_at)
       VALUES ($1, $2, $3, datetime('now'))
       ON CONFLICT(novel_id) DO UPDATE SET
         chapter_raw=excluded.chapter_raw,
         chapter_sort=excluded.chapter_sort,
         updated_at=excluded.updated_at`,
      [data.id, data.current_chapter_raw, chapterSort]
    );
  }

  // Replace aliases — delete all then reinsert
  await db.execute(`DELETE FROM aliases WHERE novel_id=$1`, [data.id]);
  for (const alias of data.aliases) {
    await db.execute(
      `INSERT INTO aliases (novel_id, alias) VALUES ($1, $2)`,
      [data.id, alias]
    );
  }
}

// ── Update progress only (quick update) ──────────────────────────────────────
export async function updateProgress(
  novelId: number,
  chapterRaw: string
): Promise<void> {
  const db = await getDb();
  const chapterSort = parseChapterSort(chapterRaw);

  await db.execute(
    `INSERT INTO progress (novel_id, chapter_raw, chapter_sort, updated_at)
     VALUES ($1, $2, $3, datetime('now'))
     ON CONFLICT(novel_id) DO UPDATE SET
       chapter_raw=excluded.chapter_raw,
       chapter_sort=excluded.chapter_sort,
       updated_at=excluded.updated_at`,
    [novelId, chapterRaw, chapterSort]
  );
}

// ── Delete a novel ────────────────────────────────────────────────────────────
export async function deleteNovel(id: number): Promise<void> {
  const db = await getDb();
  // ON DELETE CASCADE handles progress, aliases, sources, site_mappings
  await db.execute(`DELETE FROM novels WHERE id=$1`, [id]);
}

// ── Chapter sort extraction (mirrors frontend logic) ─────────────────────────
function parseChapterSort(raw: string): number | null {
  const chapterMatch = raw.match(/chapter\s*(\d+\.?\d*)/i);
  if (chapterMatch) return parseFloat(chapterMatch[1]);
  const episodeMatch = raw.match(/episode\s*(\d+)/i);
  if (episodeMatch) return parseFloat(episodeMatch[1]);
  const bareMatch = raw.match(/^\s*(\d+\.?\d*)\s*$/);
  if (bareMatch) return parseFloat(bareMatch[1]);
  return null;
}