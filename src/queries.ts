import { getDb } from "./db";
import type Database from "@tauri-apps/plugin-sql";
import type { Status } from "./formComponents";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";

export interface NovelRow {
  id: number;
  canonical_title: string;
  status: Status;
  notes: string;
  cover_url: string;
  author: string | null;
  tags: string[];
  current_chapter_raw: string | null;
  chapter_sort: number | null;
  updated_at: string;
  aliases: string[];
  last_seen_url: string | null;
}

// tags are stored as a JSON array of strings; a bad value must not crash a view
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// ── Tag vocabulary (NovelUpdates' canonical tag list) ─────────────────────────
export async function getTagVocabulary(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ name: string }[]>(
    `SELECT name FROM tag_vocabulary ORDER BY name COLLATE NOCASE`
  );
  return rows.map((r) => r.name);
}

// ── Reading log ───────────────────────────────────────────────────────────────
// Append-only history of reading activity (plan §3.3). Entries are never
// updated or deleted — the novel's own row carries its current state.
const STATUS_ACTIONS: Record<string, string> = {
  reading: "started",
  completed: "completed",
  dropped: "dropped",
  paused: "paused",
};

async function logReading(
  db: Database,
  novelId: number,
  action: string,
  chapter: number | null
): Promise<void> {
  await db.execute(
    `INSERT INTO reading_log (novel_id, action, chapter, timestamp)
     VALUES ($1, $2, $3, strftime('%s','now'))`,
    [novelId, action, chapter]
  );
}

// What the novel looked like before a write, so the log only records real
// changes and a repeated save stays a no-op.
async function novelBefore(
  db: Database,
  novelId: number
): Promise<{
  status: string | null;
  chapter_raw: string | null;
  tags: string | null;
  tag_source: string | null;
}> {
  const rows = await db.select<{
    status: string;
    chapter_raw: string | null;
    tags: string | null;
    tag_source: string | null;
  }[]>(
    `SELECT n.status, n.tags, n.tag_source, p.chapter_raw
     FROM novels n
     LEFT JOIN progress p ON p.novel_id = n.id
     WHERE n.id = $1`,
    [novelId]
  );
  return {
    status: rows[0]?.status ?? null,
    chapter_raw: rows[0]?.chapter_raw ?? null,
    tags: rows[0]?.tags ?? null,
    tag_source: rows[0]?.tag_source ?? null,
  };
}

// ── Fetch all novels with their current progress and aliases ──────────────────
export async function getAllNovels(): Promise<NovelRow[]> {
  const db = await getDb();

  const novels = await db.select<any[]>(`
    SELECT
      n.id, n.canonical_title, n.status, n.notes, n.cover_url, n.author, n.tags,
      p.chapter_raw as current_chapter_raw,
      p.chapter_sort,
      COALESCE(p.updated_at, n.updated_at) as updated_at,
      (SELECT last_seen_url FROM sources 
      WHERE novel_id = n.id AND is_preferred = 1 
      LIMIT 1) as last_seen_url
    FROM novels n
    LEFT JOIN progress p ON p.novel_id = n.id
    ORDER BY COALESCE(p.updated_at, n.updated_at) DESC
  `);

  // Fetch aliases separately and attach
  const aliases = await db.select<{ novel_id: number; alias: string }[]>(
    `SELECT novel_id, alias FROM aliases`
  );

  // Group once — filtering per novel inside the map is O(novels × aliases)
  const aliasesByNovel = new Map<number, string[]>();
  for (const a of aliases) {
    const list = aliasesByNovel.get(a.novel_id);
    if (list) list.push(a.alias);
    else aliasesByNovel.set(a.novel_id, [a.alias]);
  }

  return novels.map((n) => ({
    ...n,
    tags: parseTags(n.tags),
    aliases: aliasesByNovel.get(n.id) ?? [],
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
  const chapterRaw = data.current_chapter_raw.trim();
  const chapterSort = chapterRaw ? parseChapterSort(chapterRaw) : null;

  if (chapterRaw) {
    await db.execute(
      `INSERT INTO progress (novel_id, chapter_raw, chapter_sort)
       VALUES ($1, $2, $3)`,
      [novelId, chapterRaw, chapterSort]
    );
  }

  // A novel added part-way in already has a status worth recording. 'planned'
  // has no action — it never started.
  const action = STATUS_ACTIONS[data.status];
  if (action) await logReading(db, novelId, action, chapterSort);

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
  author: string;
  tags: string[];
  current_chapter_raw: string;
  last_seen_url: string;
  aliases: string[];
}): Promise<void> {
  const db = await getDb();
  const before = await novelBefore(db, data.id);
  const chapterRaw = data.current_chapter_raw.trim();
  const chapterSort = chapterRaw ? parseChapterSort(chapterRaw) : null;

  // No tags is stored as NULL, so a later page visit can still fill them
  const tags = data.tags.length ? JSON.stringify(data.tags) : null;
  // Edited here → the user owns them; untouched → keep the source that captured
  // them (e.g. the site the extension read them from)
  const tagSource = tags === before.tags ? before.tag_source : tags ? "manual" : null;

  await db.execute(
    `UPDATE novels
     SET canonical_title=$1, status=$2, notes=$3, cover_url=$4, author=$5,
         tags=$6, tag_source=$7, updated_at=datetime('now')
     WHERE id=$8`,
    [
      data.canonical_title,
      data.status,
      data.notes,
      data.cover_url,
      // Blank means "no author", not an empty string
      data.author.trim() || null,
      tags,
      tagSource,
      data.id,
    ]
  );

  // Status only makes history when it actually moved (plan §3.3)
  const action = STATUS_ACTIONS[data.status];
  if (action && before.status !== data.status) {
    await logReading(db, data.id, action, chapterSort);
  }

  // Upsert progress — an empty field means "no progress", so drop the row
  if (chapterRaw) {
    await db.execute(
      `INSERT INTO progress (novel_id, chapter_raw, chapter_sort, updated_at)
       VALUES ($1, $2, $3, datetime('now'))
       ON CONFLICT(novel_id) DO UPDATE SET
         chapter_raw=excluded.chapter_raw,
         chapter_sort=excluded.chapter_sort,
         updated_at=excluded.updated_at`,
      [data.id, chapterRaw, chapterSort]
    );

    // Re-saving the same chapter is not progress
    if (before.chapter_raw !== chapterRaw) {
      await logReading(db, data.id, "progressed", chapterSort);
    }
  } else {
    await db.execute(`DELETE FROM progress WHERE novel_id=$1`, [data.id]);
  }
  // Save source URL if provided
  if (data.last_seen_url.trim()) {
    const domain = (() => {
      try { return new URL(data.last_seen_url).hostname.replace("www.", ""); }
      catch { return ""; }
    })();

    if (domain) {
      // Only one preferred source per novel — the list view reads with LIMIT 1
      await db.execute(
        `UPDATE sources SET is_preferred=0 WHERE novel_id=$1`,
        [data.id]
      );
      await db.execute(
        `INSERT INTO sources (novel_id, domain, url_pattern, last_seen_url, last_seen_at, is_preferred)
         VALUES ($1, $2, $2, $3, datetime('now'), 1)
         ON CONFLICT(novel_id, domain) DO UPDATE SET
           last_seen_url=excluded.last_seen_url,
           last_seen_at=excluded.last_seen_at,
           is_preferred=1`,
        [data.id, domain, data.last_seen_url]
      );
    }
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
  const before = await novelBefore(db, novelId);

  await db.execute(
    `INSERT INTO progress (novel_id, chapter_raw, chapter_sort, updated_at)
     VALUES ($1, $2, $3, datetime('now'))
     ON CONFLICT(novel_id) DO UPDATE SET
       chapter_raw=excluded.chapter_raw,
       chapter_sort=excluded.chapter_sort,
       updated_at=excluded.updated_at`,
    [novelId, chapterRaw, chapterSort]
  );

  // Re-opening the quick update and confirming the same chapter is not progress
  if (chapterRaw.trim() && before.chapter_raw !== chapterRaw.trim()) {
    await logReading(db, novelId, "progressed", chapterSort);
  }
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

// ── Exporting Library contents ─────────────────────────
// Everything the app knows, in one file. Every table is read with `SELECT *`, so
// a migration that adds a column is carried automatically — the restore on the
// Rust side has to be taught the new column name too (see backup.rs).
export async function exportLibrary(): Promise<string> {
  const db = await getDb();

  const novels = await db.select<any[]>(`SELECT * FROM novels`);
  const progress = await db.select<any[]>(`SELECT * FROM progress`);
  const aliases = await db.select<any[]>(`SELECT * FROM aliases`);
  const sources = await db.select<any[]>(`SELECT * FROM sources`);
  const siteMappings = await db.select<any[]>(`SELECT * FROM site_mappings`);
  const readingLog = await db.select<any[]>(`SELECT * FROM reading_log`);
  const tagVocabulary = await db.select<any[]>(`SELECT * FROM tag_vocabulary`);

  const data = {
    exported_at: new Date().toISOString(),
    version: 4,
    novels,
    progress,
    aliases,
    sources,
    site_mappings: siteMappings,
    reading_log: readingLog,
    tag_vocabulary: tagVocabulary,
  };

  return JSON.stringify(data, null, 2);
}


export async function exportToFile(): Promise<boolean> {
  const json = await exportLibrary();
  
  const path = await save({
    defaultPath: `noveltrackr-backup-${new Date().toISOString().slice(0,10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });

  if (!path) return false; // user cancelled

  await invoke("save_export", { path, content: json });
  return true;
}

// ── Restoring a backup ────────────────────────────────────────────────────────
export interface RestoreReport {
  novels: number;
  progress: number;
  aliases: number;
  sources: number;
  site_mappings: number;
  reading_log: number;
  tag_vocabulary: number;
}

// Replaces the library with a backup file. The command snapshots what is about
// to be overwritten before it writes, so the wrong file is recoverable from the
// app's backups folder. Returns null when the user cancels the file picker.
export async function importFromFile(): Promise<RestoreReport | null> {
  const picked = await open({
    multiple: false,
    filters: [{ name: "Noveltrackr backup", extensions: ["json"] }],
  });

  if (typeof picked !== "string") return null;

  return invoke<RestoreReport>("import_library", { path: picked });
}