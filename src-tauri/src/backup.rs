//! Backups, both directions: restoring a JSON export, and the copies the app
//! takes of its own database.
//!
//! The reading log only earns its name if it survives mistakes, so there are two
//! ways back: an explicit restore of an export file, and snapshots written
//! automatically — one per day on startup, plus one immediately before a restore
//! replaces the library.
//!
//! A restore is all-or-nothing. It runs in a single transaction, so a file that
//! isn't one of ours leaves the database exactly as it was rather than half
//! swallowed.

use std::path::{Path, PathBuf};

use rusqlite::{params_from_iter, Transaction};
use serde::Serialize;

use crate::server::open_db;

/// The export shape this build writes, and the newest one it will read back
pub const EXPORT_VERSION: i64 = 6;

/// Daily snapshots kept next to the database
pub const KEEP_DAILY: usize = 7;

/// Pre-restore snapshots kept — enough to walk back a few mistaken restores
pub const KEEP_PRE_RESTORE: usize = 5;

/// Every table an export carries, in the order a restore inserts them: parents
/// before the rows that reference them.
pub const TABLES: [&str; 7] = [
    "novels",
    "progress",
    "aliases",
    "sources",
    "site_mappings",
    "reading_log",
    "tag_vocabulary",
];

// Column names as the schema declares them, in order. A restore writes these
// lists explicitly, so a column added by a migration has to be added here too —
// `every_exported_column_is_restored` fails until it is.
const NOVEL_COLUMNS: [&str; 19] = [
    "id",
    "canonical_title",
    "status",
    "notes",
    "cover_url",
    "created_at",
    "updated_at",
    "author",
    "tags",
    "description",
    "tag_source",
    "tag_fetched_at",
    "rating",
    "drop_reason",
    "latest_chapter",
    "latest_chapter_confidence",
    "latest_chapter_seen_at",
    "total_chapters",
    "total_chapters_seen_at",
];
const PROGRESS_COLUMNS: [&str; 5] = ["id", "novel_id", "chapter_raw", "chapter_sort", "updated_at"];
const ALIAS_COLUMNS: [&str; 3] = ["id", "novel_id", "alias"];
const SOURCE_COLUMNS: [&str; 7] = [
    "id",
    "novel_id",
    "domain",
    "url_pattern",
    "is_preferred",
    "last_seen_url",
    "last_seen_at",
];
const MAPPING_COLUMNS: [&str; 5] = ["id", "domain", "detected_title", "novel_id", "confirmed_at"];
const LOG_COLUMNS: [&str; 5] = ["id", "novel_id", "action", "chapter", "timestamp"];
const VOCABULARY_COLUMNS: [&str; 4] = ["id", "name", "category", "fetched_at"];

/// What a restore actually wrote, so the app can say so instead of guessing
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct RestoreReport {
    pub novels: i64,
    pub progress: i64,
    pub aliases: i64,
    pub sources: i64,
    pub site_mappings: i64,
    pub reading_log: i64,
    pub tag_vocabulary: i64,
}

// ── Restoring ────────────────────────────────────────────────────────────────

/// Replaces the library with the contents of an export.
pub fn restore(db_path: &str, json: &str) -> Result<RestoreReport, String> {
    let doc: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("not a Noveltrackr backup: {e}"))?;

    let version = doc
        .get("version")
        .and_then(serde_json::Value::as_i64)
        .ok_or("this file is not a Noveltrackr export — it has no version")?;

    if version > EXPORT_VERSION {
        return Err(format!(
            "that backup came from a newer version of the app ({version}) — update first, \
             it may hold fields this build would drop"
        ));
    }

    let rows = |key: &str| -> Vec<serde_json::Value> {
        doc.get(key)
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
    };

    let mut conn = open_db(db_path)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // Replace, never merge: the ids in the file are the ids the app wrote, and
    // merging would hang a stranger's history off a row that already exists.
    for table in TABLES.iter().rev() {
        tx.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| format!("could not clear {table}: {e}"))?;
    }

    let report = RestoreReport {
        novels: insert_rows(&tx, "novels", &NOVEL_COLUMNS, &rows("novels"), &["id", "canonical_title"], false)?,
        progress: insert_rows(&tx, "progress", &PROGRESS_COLUMNS, &rows("progress"), &["novel_id"], true)?,
        aliases: insert_rows(&tx, "aliases", &ALIAS_COLUMNS, &rows("aliases"), &["novel_id", "alias"], false)?,
        sources: insert_rows(&tx, "sources", &SOURCE_COLUMNS, &rows("sources"), &["novel_id", "domain"], true)?,
        site_mappings: insert_rows(&tx, "site_mappings", &MAPPING_COLUMNS, &rows("site_mappings"), &["domain", "detected_title", "novel_id"], true)?,
        reading_log: insert_rows(&tx, "reading_log", &LOG_COLUMNS, &rows("reading_log"), &["novel_id", "action", "timestamp"], false)?,
        tag_vocabulary: insert_rows(&tx, "tag_vocabulary", &VOCABULARY_COLUMNS, &rows("tag_vocabulary"), &["name"], true)?,
    };

    // A file that claims to hold novels but yields none of them would leave an
    // empty library behind. Refuse it rather than obey it.
    let declared = rows("novels").iter().filter(|row| row.is_object()).count() as i64;
    if declared > 0 && report.novels == 0 {
        return Err(format!(
            "the backup lists {declared} novels but none could be read — nothing was restored"
        ));
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(report)
}

/// Inserts `rows` into `table`, skipping anything that isn't an object or is
/// missing one of `required`. `replace` is for tables whose unique keys a
/// hand-edited file could duplicate — last one in the file wins.
fn insert_rows(
    tx: &Transaction,
    table: &str,
    columns: &[&str],
    rows: &[serde_json::Value],
    required: &[&str],
    replace: bool,
) -> Result<i64, String> {
    let placeholders: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "INSERT {}INTO {} ({}) VALUES ({})",
        if replace { "OR REPLACE " } else { "" },
        table,
        columns.join(", "),
        placeholders.join(", "),
    );

    let mut stmt = tx.prepare(&sql).map_err(|e| format!("{table}: {e}"))?;
    let mut written = 0;

    for row in rows.iter().filter(|row| row.is_object()) {
        let complete = required
            .iter()
            .all(|key| matches!(row.get(*key), Some(v) if !v.is_null()));
        if !complete {
            continue;
        }

        let values: Vec<rusqlite::types::Value> =
            columns.iter().map(|c| sql_value(row.get(*c))).collect();
        stmt.execute(params_from_iter(values))
            .map_err(|e| format!("{table}: {e}"))?;
        written += 1;
    }

    Ok(written)
}

/// A JSON value as SQLite would store it. Anything that isn't a primitive (a
/// hand-edited `tags` array, say) is kept as text, which is what the column holds.
fn sql_value(value: Option<&serde_json::Value>) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    use serde_json::Value as Json;

    match value {
        None | Some(Json::Null) => Value::Null,
        Some(Json::Bool(b)) => Value::Integer(i64::from(*b)),
        Some(Json::Number(n)) => n
            .as_i64()
            .map(Value::Integer)
            .unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or_default())),
        Some(Json::String(s)) => Value::Text(s.clone()),
        Some(other) => Value::Text(other.to_string()),
    }
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/// One snapshot per day, pruned to the newest `keep`. Returns the copy it wrote,
/// or None when today's already exists (or there is no database yet).
pub fn daily_snapshot(db_path: &str, keep: usize) -> Result<Option<PathBuf>, String> {
    if !Path::new(db_path).exists() {
        return Ok(None); // a fresh install has nothing to copy yet
    }

    let target = snapshot_dir(db_path).join(format!("noveltrackr-{}.db", today_label(now_secs())));
    if target.exists() {
        return Ok(None);
    }

    let written = snapshot_as(db_path, &target)?;
    prune(&snapshot_dir(db_path), "noveltrackr-", keep)?;
    Ok(Some(written))
}

/// The copy taken just before a restore overwrites the library. Timestamped to
/// the second so two restores in one day are both recoverable.
pub fn snapshot_before_restore(db_path: &str) -> Result<Option<PathBuf>, String> {
    if !Path::new(db_path).exists() {
        return Ok(None); // nothing to lose yet
    }

    let secs = now_secs();
    let target = snapshot_dir(db_path).join(format!(
        "pre-restore-{}-{}.db",
        today_label(secs),
        clock_label(secs),
    ));

    let written = snapshot_as(db_path, &target)?;
    prune(&snapshot_dir(db_path), "pre-restore-", KEEP_PRE_RESTORE)?;
    Ok(Some(written))
}

/// `VACUUM INTO` rather than a file copy: SQLite writes one consistent database
/// even if the live one is in WAL mode mid-write.
fn snapshot_as(db_path: &str, target: &Path) -> Result<PathBuf, String> {
    if !Path::new(db_path).exists() {
        return Err(format!("no database at {db_path}"));
    }

    let dir = target.parent().ok_or("snapshot target has no directory")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let conn = open_db(db_path)?;
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])
        .map_err(|e| format!("could not write {}: {e}", target.display()))?;

    Ok(target.to_path_buf())
}

/// Snapshots live beside the database they copy, so the whole thing is one
/// folder to move or to restore from.
fn snapshot_dir(db_path: &str) -> PathBuf {
    Path::new(db_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups")
}

/// Keeps the newest `keep` snapshots carrying this prefix. Names start with the
/// date, so sorting them is sorting by age.
fn prune(dir: &Path, prefix: &str, keep: usize) -> Result<(), String> {
    let keep = keep.max(1);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };

    let mut snapshots: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(prefix) && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .collect();

    snapshots.sort();
    for old in snapshots.iter().rev().skip(keep) {
        std::fs::remove_file(old).map_err(|e| format!("could not prune {}: {e}", old.display()))?;
    }

    Ok(())
}

// ── Dates ────────────────────────────────────────────────────────────────────
// The app carries no calendar library, and a snapshot filename only needs a date.

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A UTC day as `YYYY-MM-DD`
fn today_label(secs: i64) -> String {
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

/// `HHMMSS`, so two snapshots on the same day don't collide
fn clock_label(secs: i64) -> String {
    let secs_of_day = secs.rem_euclid(86_400);
    format!(
        "{:02}{:02}{:02}",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    )
}

/// Days since the epoch → (year, month, day). Howard Hinnant's civil_from_days.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };

    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// The migrations, in the order sqlx applies them
    const MIGRATIONS: [&str; 6] = [
        include_str!("../migrations/001_init.sql"),
        include_str!("../migrations/002_sources_unique.sql"),
        include_str!("../migrations/003_aliases_index.sql"),
        include_str!("../migrations/004_metadata_reading_log.sql"),
        include_str!("../migrations/005_rating_and_drop_reason.sql"),
        include_str!("../migrations/006_latest_chapter.sql"),
    ];

    /// A folder of its own per test, so one test's snapshots never see another's
    fn fresh_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nt-backup-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fresh_db(name: &str) -> PathBuf {
        let path = fresh_dir(name).join("noveltrackr.db");
        let conn = Connection::open(&path).unwrap();
        for sql in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        path
    }

    /// One row in every table an export carries
    fn seed(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO novels (id, canonical_title, status, notes, cover_url, author, tags, tag_source, rating)
               VALUES (1, 'Reading One', 'reading', 'where I left off', 'https://c/1.jpg', 'Someone',
                       '[\"LitRPG\"]', 'royalroad', 4),
                      (2, 'Finished One', 'completed', '', '', NULL, NULL, NULL, 5);
             INSERT INTO progress (id, novel_id, chapter_raw, chapter_sort) VALUES (1, 1, 'Chapter 12', 12);
             INSERT INTO aliases (id, novel_id, alias) VALUES (1, 1, 'RO');
             INSERT INTO sources (id, novel_id, domain, url_pattern, is_preferred, last_seen_url)
               VALUES (1, 1, 'royalroad.com', 'royalroad.com', 1, 'https://royalroad.com/fiction/1');
             INSERT INTO site_mappings (id, domain, detected_title, novel_id)
               VALUES (1, 'royalroad.com', 'Reading One', 1);
             INSERT INTO reading_log (id, novel_id, action, chapter, timestamp)
               VALUES (1, 1, 'started', 1, 1700000000), (2, 1, 'progressed', 12, 1700100000);
             INSERT INTO tag_vocabulary (id, name, fetched_at) VALUES (1, 'LitRPG', 1700000000);",
        )
        .unwrap();
    }

    /// The shape `exportLibrary()` writes: one `SELECT *` per table, keyed by column
    fn export_json(conn: &Connection) -> String {
        let mut doc = serde_json::Map::new();
        doc.insert("version".to_string(), serde_json::json!(EXPORT_VERSION));

        for table in TABLES {
            let columns: Vec<String> = conn
                .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect();

            let mut stmt = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let rows: Vec<serde_json::Value> = stmt
                .query_map([], |row| {
                    let mut obj = serde_json::Map::new();
                    for (i, name) in columns.iter().enumerate() {
                        let value: rusqlite::types::Value = row.get(i)?;
                        obj.insert(
                            name.clone(),
                            match value {
                                rusqlite::types::Value::Null => serde_json::Value::Null,
                                rusqlite::types::Value::Integer(i) => serde_json::json!(i),
                                rusqlite::types::Value::Real(f) => serde_json::json!(f),
                                rusqlite::types::Value::Text(t) => serde_json::json!(t),
                                rusqlite::types::Value::Blob(_) => serde_json::Value::Null,
                            },
                        );
                    }
                    Ok(serde_json::Value::Object(obj))
                })
                .unwrap()
                .filter_map(Result::ok)
                .collect();

            doc.insert(table.to_string(), serde_json::Value::Array(rows));
        }

        serde_json::to_string(&serde_json::Value::Object(doc)).unwrap()
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    // ── Dates ────────────────────────────────────────────────────────────────

    #[test]
    fn snapshot_names_carry_a_usable_date() {
        assert_eq!(today_label(0), "1970-01-01");
        assert_eq!(today_label(951_782_400), "2000-02-29", "a leap day");
        assert_eq!(today_label(1_700_000_000), "2023-11-14");
        assert_eq!(clock_label(1_700_000_000), "221320");
        assert_eq!(clock_label(0), "000000");
    }

    // ── Snapshots ────────────────────────────────────────────────────────────

    #[test]
    fn a_snapshot_opens_as_a_database() {
        let path = fresh_db("snapshot");
        let conn = Connection::open(&path).unwrap();
        seed(&conn);
        drop(conn);

        let written = daily_snapshot(path.to_str().unwrap(), KEEP_DAILY)
            .unwrap()
            .expect("a snapshot was due");

        assert!(written.starts_with(path.parent().unwrap().join("backups")));
        let copy = Connection::open(&written).unwrap();
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM novels"), 2);
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM reading_log"), 2);

        assert_eq!(
            daily_snapshot(path.to_str().unwrap(), KEEP_DAILY).unwrap(),
            None,
            "one snapshot a day is enough"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn there_is_nothing_to_snapshot_before_the_first_run() {
        let dir = fresh_dir("nodatabase");
        let path = dir.join("noveltrackr.db");

        assert_eq!(daily_snapshot(path.to_str().unwrap(), KEEP_DAILY).unwrap(), None);
        assert_eq!(snapshot_before_restore(path.to_str().unwrap()).unwrap(), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_restore_keeps_a_copy_of_what_it_replaces() {
        let path = fresh_db("prerestore");
        seed(&Connection::open(&path).unwrap());

        let copy = snapshot_before_restore(path.to_str().unwrap())
            .unwrap()
            .expect("the library existed, so a copy was due");
        let name = copy.file_name().unwrap().to_string_lossy().to_string();

        assert!(name.starts_with("pre-restore-") && name.ends_with(".db"), "{name}");
        assert_eq!(count(&Connection::open(&copy).unwrap(), "SELECT COUNT(*) FROM novels"), 2);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn only_the_newest_snapshots_survive() {
        let dir = fresh_dir("prune");
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).unwrap();

        for day in ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"] {
            std::fs::write(backups.join(format!("noveltrackr-{day}.db")), b"x").unwrap();
        }
        std::fs::write(backups.join("pre-restore-2026-09-05-120000.db"), b"x").unwrap();

        prune(&backups, "noveltrackr-", 3).unwrap();

        let mut left: Vec<String> = std::fs::read_dir(&backups)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();

        assert_eq!(
            left,
            vec![
                "noveltrackr-2026-09-03.db",
                "noveltrackr-2026-09-04.db",
                "noveltrackr-2026-09-05.db",
                "pre-restore-2026-09-05-120000.db", // a different prefix isn't ours to prune
            ]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Restoring ────────────────────────────────────────────────────────────

    #[test]
    fn restoring_replaces_whatever_is_there() {
        let source = fresh_db("restore-src");
        let source_conn = Connection::open(&source).unwrap();
        seed(&source_conn);
        let json = export_json(&source_conn);
        drop(source_conn);

        // A second install, holding a novel the backup has never heard of
        let path = fresh_db("restore-dst");
        let conn = Connection::open(&path).unwrap();
        conn.execute("INSERT INTO novels (id, canonical_title) VALUES (99, 'Later Addition')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO reading_log (novel_id, action, chapter, timestamp)
             VALUES (99, 'started', 1, 1700000000)",
            [],
        )
        .unwrap();

        let report = restore(path.to_str().unwrap(), &json).unwrap();

        assert_eq!(
            report,
            RestoreReport {
                novels: 2,
                progress: 1,
                aliases: 1,
                sources: 1,
                site_mappings: 1,
                reading_log: 2,
                tag_vocabulary: 1,
            }
        );

        let titles: Vec<String> = conn
            .prepare("SELECT canonical_title FROM novels ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(
            titles,
            vec!["Reading One".to_string(), "Finished One".to_string()],
            "the backup's library is the library now"
        );

        let (chapter, sort): (String, f64) = conn
            .query_row(
                "SELECT chapter_raw, chapter_sort FROM progress WHERE novel_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (chapter.as_str(), sort),
            ("Chapter 12", 12.0),
            "ids and parsed chapters come back"
        );

        let (notes, tags): (String, String) = conn
            .query_row("SELECT notes, tags FROM novels WHERE id = 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!((notes.as_str(), tags.as_str()), ("where I left off", "[\"LitRPG\"]"));

        let timestamp: i64 = conn
            .query_row("SELECT timestamp FROM reading_log WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timestamp, 1_700_000_000, "log timestamps are not re-dated");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tag_vocabulary"), 1, "learned tags come back");

        let rating: Option<i64> = conn
            .query_row("SELECT rating FROM novels WHERE id = 2", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rating, Some(5), "a rating survives the round trip");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        let _ = std::fs::remove_dir_all(source.parent().unwrap());
    }

    #[test]
    fn a_file_that_is_not_a_backup_changes_nothing() {
        let path = fresh_db("badfile");
        let conn = Connection::open(&path).unwrap();
        seed(&conn);

        let bad = [
            "",
            "not json at all",
            r#"{"novels":[]}"#,                                // nothing says it is ours
            r#"{"version":99,"novels":[]}"#,                   // written by a newer build
            r#"{"version":4,"novels":[{"novel":1}]}"#,         // looks the part, isn't
            r#"{"version":4,"novels":[{"id":1,"canonical_title":"Half a row"}]}"#, // breaks NOT NULL
        ];

        for json in bad {
            assert!(
                restore(path.to_str().unwrap(), json).is_err(),
                "this should not have restored: {json}"
            );
        }

        assert_eq!(count(&conn, "SELECT COUNT(*) FROM novels"), 2, "the library is untouched");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM reading_log"), 2);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn an_older_export_still_restores() {
        let path = fresh_db("oldexport");
        let conn = Connection::open(&path).unwrap();

        // Version 3 is what the app wrote before the tag vocabulary was exported
        let json = r#"{"version":3,"exported_at":"2025-01-01T00:00:00Z",
            "novels":[{"id":7,"canonical_title":"Old One","status":"reading","notes":"","cover_url":"",
                       "created_at":"2025-01-01 00:00:00","updated_at":"2025-01-02 00:00:00",
                       "author":null,"tags":null,"description":null,"tag_source":null,"tag_fetched_at":null}],
            "progress":[],"aliases":[],"sources":[],"site_mappings":[],
            "reading_log":[{"id":1,"novel_id":7,"action":"started","chapter":1,"timestamp":1700000000}]}"#;

        let report = restore(path.to_str().unwrap(), json).unwrap();

        assert_eq!(report.novels, 1);
        assert_eq!(report.reading_log, 1);
        assert_eq!(report.tag_vocabulary, 0, "a version 3 export predates the vocabulary key");

        let title: String = conn
            .query_row("SELECT canonical_title FROM novels WHERE id = 7", [], |row| row.get(0))
            .unwrap();
        assert_eq!(title, "Old One");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A migration that adds a column has to be taught to the restore, or every
    /// restore would quietly drop that column.
    #[test]
    fn every_exported_column_is_restored() {
        let path = fresh_db("columns");
        let conn = Connection::open(&path).unwrap();

        let written: [(&str, &[&str]); 7] = [
            ("novels", &NOVEL_COLUMNS),
            ("progress", &PROGRESS_COLUMNS),
            ("aliases", &ALIAS_COLUMNS),
            ("sources", &SOURCE_COLUMNS),
            ("site_mappings", &MAPPING_COLUMNS),
            ("reading_log", &LOG_COLUMNS),
            ("tag_vocabulary", &VOCABULARY_COLUMNS),
        ];

        for (table, columns) in written {
            let mut stmt = conn
                .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .unwrap();
            let declared: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect();
            let restored: Vec<String> = columns.iter().map(|c| (*c).to_string()).collect();

            assert_eq!(declared, restored, "{table}: the schema and the restore disagree");
        }

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
