//! Reading statistics (plan §4.4).
//!
//! Every number comes from `reading_log` and the library rows. Nothing is
//! estimated: what can't be known yet (chapter totals — see NG2) is left out
//! rather than faked.
//!
//! Chapters are counted as the chapter numbers a log entry moved, not as log
//! entries (see [`CHAPTER_ADVANCE`]) — one update that jumps 1 → 5 is four
//! chapters of reading.

use rusqlite::Connection;
use serde::Serialize;

use crate::server::open_db;

/// The heatmap, streaks and first-entry date cover the last year
const ACTIVITY_DAYS: i64 = 365;
const PACE_DAYS: usize = 30;
const PACE_WEEKS: usize = 8;
const TOP_TAGS: usize = 12;
const TOP_TAGS_PER_YEAR: usize = 5;
const TOP_YEARS: usize = 3;
/// Drop reasons offered by the edit panel are a fixed set, so this is slack
const TOP_REASONS: usize = 12;

/// Drop-point buckets — where in a novel people give up. Half-open ranges, so
/// every chapter number lands in exactly one bucket.
const DROP_BUCKETS: [(&str, f64, f64); 6] = [
    ("0–24", 0.0, 25.0),
    ("25–49", 25.0, 50.0),
    ("50–99", 50.0, 100.0),
    ("100–199", 100.0, 200.0),
    ("200–399", 200.0, 400.0),
    ("400+", 400.0, f64::INFINITY),
];

#[derive(Serialize, Debug, PartialEq)]
pub struct Day {
    pub date: String,
    pub entries: i64,
    pub chapters: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct StatusCount {
    pub status: String,
    pub count: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Week {
    pub label: String,
    pub chapters: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Bucket {
    pub label: String,
    pub count: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct TagStat {
    pub tag: String,
    pub novels: i64,
    pub completed: i64,
    pub dropped: i64,
    pub chapters: i64,
    /// How many of those novels carry a rating, and what they average. The count
    /// matters: an average of one novel is not a finding.
    pub rated: i64,
    pub avg_rating: Option<f64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct YearTag {
    pub year: String,
    pub tags: Vec<Bucket>,
}

/// One line of a novel's reading log. `gained` is how far that entry moved the
/// chapter — the same number the charts add up, zero for status changes.
#[derive(Serialize, Debug, PartialEq)]
pub struct HistoryEntry {
    pub action: String,
    pub chapter: Option<f64>,
    pub at: String,
    pub gained: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct NovelHistory {
    pub chapters_30d: i64,
    pub entries: Vec<HistoryEntry>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Stats {
    pub status_counts: Vec<StatusCount>,
    pub total_novels: i64,
    pub tagged_novels: i64,
    pub log_entries: i64,
    pub first_entry: Option<String>,
    pub active_days: i64,
    pub completed: i64,
    pub dropped: i64,
    pub chapters_30d: i64,
    pub chapters_per_day: f64,
    pub chapters_per_active_day: f64,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub weeks: Vec<Week>,
    pub activity: Vec<Day>,
    pub drop_points: Vec<Bucket>,
    pub drop_reasons: Vec<Bucket>,
    pub tag_stats: Vec<TagStat>,
    pub tag_years: Vec<YearTag>,
}

pub fn build_stats(db_path: &str) -> Result<Stats, String> {
    let conn = open_db(db_path)?;

    let activity = daily_activity(&conn)?;
    let (status_counts, total_novels, tagged_novels) = library_counts(&conn)?;
    let (log_entries, first_entry) = log_span(&conn)?;
    let (completed, dropped) = completion_counts(&conn)?;
    let (current_streak, longest_streak, active_days) = streaks(&activity);

    let chapters: i64 = activity.iter().map(|day| day.chapters).sum();
    let chapters_30d: i64 = activity.iter().rev().take(PACE_DAYS).map(|day| day.chapters).sum();

    Ok(Stats {
        status_counts,
        total_novels,
        tagged_novels,
        log_entries,
        first_entry,
        active_days,
        completed,
        dropped,
        chapters_30d,
        chapters_per_day: chapters_30d as f64 / PACE_DAYS as f64,
        chapters_per_active_day: if active_days > 0 {
            chapters as f64 / active_days as f64
        } else {
            0.0
        },
        current_streak,
        longest_streak,
        weeks: weekly_pace(&activity),
        drop_points: drop_buckets(&conn)?,
        drop_reasons: drop_reasons(&conn)?,
        tag_stats: tag_stats(&conn)?,
        tag_years: tag_years(&conn)?,
        activity,
    })
}

/// A novel's own reading log, newest first — the history behind the charts.
/// `gained` comes from the same CHAPTER_ADVANCE the stats add up, so the timeline
/// and the charts cannot disagree.
pub fn novel_history(db_path: &str, novel_id: i64) -> Result<NovelHistory, String> {
    let conn = open_db(db_path)?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT rl.action,
                    rl.chapter,
                    date(rl.timestamp, 'unixepoch') AS at,
                    COALESCE(CAST(ROUND(a.gained) AS INTEGER), 0) AS gained
             FROM reading_log rl
             LEFT JOIN ({CHAPTER_ADVANCE}) a ON a.id = rl.id
             WHERE rl.novel_id = ?1
             ORDER BY rl.timestamp DESC, rl.id DESC",
        ))
        .map_err(|e| e.to_string())?;

    let entries: Vec<HistoryEntry> = stmt
        .query_map([novel_id], |row| {
            Ok(HistoryEntry {
                action: row.get(0)?,
                chapter: row.get(1)?,
                at: row.get(2)?,
                gained: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // The same window the pace card uses, so "chapters in the last 30 days" means
    // the same days in both places
    let chapters_30d: i64 = conn
        .query_row(
            &format!(
                "SELECT COALESCE(CAST(ROUND(SUM(gained)) AS INTEGER), 0)
                 FROM ({CHAPTER_ADVANCE})
                 WHERE novel_id = ?1 AND day >= date('now', ?2)"
            ),
            rusqlite::params![novel_id, format!("-{} days", PACE_DAYS - 1)],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(NovelHistory { chapters_30d, entries })
}


/// Chapters gained by each `progressed` entry: how far the chapter moved since
/// that novel's previous logged chapter, so a jump from 1 to 5 counts as four
/// chapters rather than one entry. The whole gap lands on the later entry's day
/// — that is the only day the log can prove. An entry with nothing before it
/// counts as one (the log starts here, the chapters before it are unknowable),
/// and a backwards correction clamps to zero rather than subtracting chapters
/// that were already counted. Chapter numbers can be fractional (10.5), so a
/// day's total is rounded to whole chapters — every stat built on it is a count.
const CHAPTER_ADVANCE: &str = "
  SELECT id,
         novel_id,
         day,
         MAX(0, chapter - COALESCE(prev, chapter - 1)) AS gained
  FROM (
    SELECT id,
           novel_id,
           action,
           chapter,
           date(timestamp, 'unixepoch') AS day,
           LAG(chapter) OVER (PARTITION BY novel_id ORDER BY timestamp, id) AS prev
    FROM reading_log
  )
  WHERE action = 'progressed' AND chapter IS NOT NULL";

/// One row per day for the last year, so the heatmap, streaks and pace all read
/// from the same series. `chapters` is chapters read, not entries: a day whose
/// single update jumped five chapters is five chapters. Dates are UTC — the
/// same clock the log is written on.
fn daily_activity(conn: &Connection) -> Result<Vec<Day>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "WITH RECURSIVE days(d) AS (
               SELECT date('now', ?1)
               UNION ALL
               SELECT date(d, '+1 day') FROM days WHERE d < date('now')
             ),
             advance AS ({CHAPTER_ADVANCE})
             SELECT d,
                    (SELECT COUNT(*) FROM reading_log
                      WHERE date(timestamp, 'unixepoch') = d) AS entries,
                    (SELECT COALESCE(CAST(ROUND(SUM(gained)) AS INTEGER), 0)
                       FROM advance WHERE advance.day = days.d) AS chapters
             FROM days",
        ))
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([format!("-{} days", ACTIVITY_DAYS - 1)], |row| {
            Ok(Day { date: row.get(0)?, entries: row.get(1)?, chapters: row.get(2)? })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Library composition, and how much of it has tags
fn library_counts(conn: &Connection) -> Result<(Vec<StatusCount>, i64, i64), String> {
    let mut stmt = conn
        .prepare(
            "SELECT status, COUNT(*) FROM novels
             GROUP BY status
             ORDER BY CASE status
               WHEN 'reading' THEN 0 WHEN 'planned' THEN 1 WHEN 'paused' THEN 2
               WHEN 'completed' THEN 3 WHEN 'dropped' THEN 4 ELSE 5 END",
        )
        .map_err(|e| e.to_string())?;

    let status_counts: Vec<StatusCount> = stmt
        .query_map([], |row| Ok(StatusCount { status: row.get(0)?, count: row.get(1)? }))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let total_novels: i64 = conn
        .query_row("SELECT COUNT(*) FROM novels", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    let tagged_novels: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM novels
             WHERE tags IS NOT NULL AND json_valid(tags) AND json_array_length(tags) > 0",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok((status_counts, total_novels, tagged_novels))
}

/// How much history there is, and when it starts
fn log_span(conn: &Connection) -> Result<(i64, Option<String>), String> {
    let entries: i64 = conn
        .query_row("SELECT COUNT(*) FROM reading_log", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    let first: Option<String> = conn
        .query_row("SELECT date(MIN(timestamp), 'unixepoch') FROM reading_log", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    Ok((entries, first))
}

/// Completion rate over novels whose latest status action was completed/dropped,
/// so a novel that was dropped and later finished counts once, as finished.
fn completion_counts(conn: &Connection) -> Result<(i64, i64), String> {
    let mut stmt = conn
        .prepare(
            "WITH ranked AS (
               SELECT action,
                      ROW_NUMBER() OVER (PARTITION BY novel_id ORDER BY timestamp DESC, id DESC) rn
               FROM reading_log
               WHERE action IN ('completed', 'dropped')
             )
             SELECT action, COUNT(*) FROM ranked WHERE rn = 1 GROUP BY action",
        )
        .map_err(|e| e.to_string())?;

    let mut completed = 0;
    let mut dropped = 0;
    for row in stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
    {
        match row.0.as_str() {
            "completed" => completed = row.1,
            "dropped" => dropped = row.1,
            _ => {}
        }
    }

    Ok((completed, dropped))
}

/// Current and longest run of consecutive days with any reading activity, plus
/// the number of days that had activity at all.
fn streaks(activity: &[Day]) -> (i64, i64, i64) {
    let mut longest = 0;
    let mut run = 0;

    for day in activity {
        if day.entries > 0 {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }

    // A streak is still "current" while today has simply not been logged yet
    let mut current = 0;
    let last_index = activity.len().saturating_sub(1);
    for (i, day) in activity.iter().enumerate().rev() {
        if day.entries > 0 {
            current += 1;
        } else if i == last_index {
            continue;
        } else {
            break;
        }
    }

    let active_days = activity.iter().filter(|day| day.entries > 0).count() as i64;
    (current, longest, active_days)
}

/// Chapters per week, oldest first — the last bar is the week ending today.
/// Labels are the week's start date (MM-DD).
fn weekly_pace(activity: &[Day]) -> Vec<Week> {
    let recent: Vec<&Day> = activity.iter().rev().take(PACE_WEEKS * 7).collect();

    recent
        .chunks(7)
        .map(|week| {
            let start = week.last().map(|d| d.date.as_str()).unwrap_or("");
            Week {
                label: start.get(5..).unwrap_or(start).to_string(),
                chapters: week.iter().map(|d| d.chapters).sum(),
            }
        })
        .rev()
        .collect()
}

/// Where novels get dropped, bucketed by chapter number
fn drop_buckets(conn: &Connection) -> Result<Vec<Bucket>, String> {
    let mut stmt = conn
        .prepare("SELECT chapter FROM reading_log WHERE action = 'dropped' AND chapter IS NOT NULL")
        .map_err(|e| e.to_string())?;

    let chapters: Vec<f64> = stmt
        .query_map([], |row| row.get::<_, f64>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(DROP_BUCKETS
        .iter()
        .map(|(label, low, high)| Bucket {
            label: label.to_string(),
            count: chapters.iter().filter(|c| **c >= *low && **c < *high).count() as i64,
        })
        .collect())
}

/// Why novels get dropped, biggest reason first. It reads the novel's own row,
/// not the log: that is where the edit panel records the reason, and a novel that
/// was dropped and then resumed is no longer a drop at all.
fn drop_reasons(conn: &Connection) -> Result<Vec<Bucket>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT drop_reason, COUNT(*) AS count
             FROM novels
             WHERE status = 'dropped' AND drop_reason IS NOT NULL AND drop_reason <> ''
             GROUP BY drop_reason
             ORDER BY count DESC, drop_reason
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([TOP_REASONS as i64], |row| {
            Ok(Bucket { label: row.get(0)?, count: row.get(1)? })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}


/// Per-tag counts for the tags used most. Tags arrive from several sites, so the
/// vocabulary keeps their spelling aligned (see server.rs).
fn tag_stats(conn: &Connection) -> Result<Vec<TagStat>, String> {
    let mut stmt = conn
        .prepare(
            "WITH tag_novels AS (
               SELECT n.id AS novel_id, j.value AS tag, n.rating AS rating
               FROM novels n
               CROSS JOIN json_each(n.tags) j
               WHERE n.tags IS NOT NULL AND json_valid(n.tags) AND json_type(n.tags) = 'array'
             ),
             last_action AS (
               SELECT novel_id, action,
                      ROW_NUMBER() OVER (PARTITION BY novel_id ORDER BY timestamp DESC, id DESC) rn
               FROM reading_log
               WHERE action IN ('completed', 'dropped')
             )
             SELECT tn.tag,
                    COUNT(DISTINCT tn.novel_id) AS novels,
                    COUNT(DISTINCT CASE WHEN la.action = 'completed' THEN tn.novel_id END) AS completed,
                    COUNT(DISTINCT CASE WHEN la.action = 'dropped' THEN tn.novel_id END) AS dropped,
                    COUNT(DISTINCT CASE WHEN tn.rating IS NOT NULL THEN tn.novel_id END) AS rated,
                    AVG(tn.rating) AS avg_rating
             FROM tag_novels tn
             LEFT JOIN last_action la ON la.novel_id = tn.novel_id AND la.rn = 1
             GROUP BY tn.tag
             ORDER BY novels DESC, tn.tag
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, i64, i64, i64, i64, Option<f64>)> = stmt
        .query_map([TOP_TAGS as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut chapter_stmt = conn
        .prepare(&format!(
            "SELECT j.value AS tag, CAST(ROUND(SUM(a.gained)) AS INTEGER) AS chapters
             FROM novels n
             CROSS JOIN json_each(n.tags) j
             JOIN ({CHAPTER_ADVANCE}) a ON a.novel_id = n.id
             WHERE n.tags IS NOT NULL AND json_valid(n.tags) AND json_type(n.tags) = 'array'
             GROUP BY j.value",
        ))
        .map_err(|e| e.to_string())?;

    let chapters: Vec<(String, i64)> = chapter_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows
        .into_iter()
        .map(|(tag, novels, completed, dropped, rated, avg_rating)| TagStat {
            chapters: chapters
                .iter()
                .find(|(name, _)| name == &tag)
                .map(|(_, count)| *count)
                .unwrap_or(0),
            tag,
            novels,
            completed,
            dropped,
            rated,
            avg_rating,
        })
        .collect())
}

/// The tags behind each year's reading — how taste moves over time (plan §4.4.2)
fn tag_years(conn: &Connection) -> Result<Vec<YearTag>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT strftime('%Y', rl.timestamp, 'unixepoch') AS year,
                    j.value AS tag,
                    COUNT(*) AS count
             FROM reading_log rl
             JOIN novels n ON n.id = rl.novel_id
             CROSS JOIN json_each(n.tags) j
             WHERE n.tags IS NOT NULL AND json_valid(n.tags) AND json_type(n.tags) = 'array'
             GROUP BY year, tag
             ORDER BY year DESC, count DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, String, i64)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut years: Vec<YearTag> = Vec::new();
    for (year, tag, count) in rows {
        match years.last_mut() {
            Some(last) if last.year == year => {
                if last.tags.len() < TOP_TAGS_PER_YEAR {
                    last.tags.push(Bucket { label: tag, count });
                }
            }
            _ => {
                if years.len() == TOP_YEARS {
                    break;
                }
                years.push(YearTag { year, tags: vec![Bucket { label: tag, count }] });
            }
        }
    }

    Ok(years)
}


#[cfg(test)]
mod tests {
    use super::*;

    /// The migrations, in the order sqlx applies them
    const MIGRATIONS: [&str; 5] = [
        include_str!("../migrations/001_init.sql"),
        include_str!("../migrations/002_sources_unique.sql"),
        include_str!("../migrations/003_aliases_index.sql"),
        include_str!("../migrations/004_metadata_reading_log.sql"),
        include_str!("../migrations/005_rating_and_drop_reason.sql"),
    ];

    /// A throwaway database with the real schema, as an install would have it
    fn fresh_db(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("nt-stats-{}-{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);

        let conn = Connection::open(&path).unwrap();
        for sql in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }

        path
    }

    /// A library and a log that cover every stat this module produces
    fn seeded_db(name: &str) -> std::path::PathBuf {
        let path = fresh_db(name);
        let conn = Connection::open(&path).unwrap();

        conn.execute(
            "INSERT INTO novels (canonical_title, status, tags) VALUES
               ('Reading One', 'reading', '[\"LitRPG\",\"Weak to Strong\"]'),
               ('Finished One', 'completed', '[\"LitRPG\"]'),
               ('Planned One', 'planned', NULL),
               ('Dropped One', 'dropped', '[\"Weak to Strong\"]')",
            [],
        ).unwrap();

        // Chapters on three consecutive days, plus a completion and a drop
        conn.execute_batch(
            "INSERT INTO reading_log (novel_id, action, chapter, timestamp) VALUES
               (1, 'started',     1, strftime('%s','now') - 3 * 86400),
               (1, 'progressed', 10, strftime('%s','now') - 2 * 86400),
               (1, 'progressed', 20, strftime('%s','now') - 1 * 86400),
               (2, 'completed',  80, strftime('%s','now') - 2 * 86400),
               (4, 'dropped',    30, strftime('%s','now') - 4 * 86400)",
        ).unwrap();

        path
    }

    #[test]
    fn activity_streaks_and_pace() {
        let path = seeded_db("activity");
        let stats = build_stats(path.to_str().unwrap()).unwrap();

        assert_eq!(stats.activity.len(), ACTIVITY_DAYS as usize, "the heatmap wants a full year of days");
        assert_eq!(stats.log_entries, 5);
        assert_eq!(stats.active_days, 4, "four distinct days carry entries");
        assert_eq!(stats.longest_streak, 4);
        assert_eq!(stats.current_streak, 4, "today is still unlogged, so the streak runs to yesterday");
        assert!(stats.first_entry.is_some());

        // The log moved 1 → 10 → 20, so it holds 19 chapters of reading, not two
        // entries. Each gap counts on the day its entry was written.
        assert_eq!(stats.chapters_30d, 19);
        assert!((stats.chapters_per_day - 19.0 / 30.0).abs() < 0.0001);
        assert!((stats.chapters_per_active_day - 19.0 / 4.0).abs() < 0.0001);

        let yesterday = &stats.activity[stats.activity.len() - 2];
        let day_before = &stats.activity[stats.activity.len() - 3];
        assert_eq!((day_before.chapters, yesterday.chapters), (9, 10));

        assert_eq!(stats.weeks.len(), PACE_WEEKS);
        assert_eq!(
            stats.weeks.last().unwrap().chapters, 19,
            "the week ending today holds every chapter the log moved"
        );
        assert_eq!(stats.weeks[stats.weeks.len() - 2].chapters, 0, "the week before it is empty");
        assert_eq!(stats.weeks.iter().map(|w| w.chapters).sum::<i64>(), 19);

        let _ = std::fs::remove_file(&path);
    }

    /// The reading log stores the chapter an entry landed on, not how far it
    /// jumped, so the gap has to be recovered from the novel's own history
    #[test]
    fn a_jump_counts_every_chapter_in_it() {
        let path = fresh_db("jump");
        let conn = Connection::open(&path).unwrap();

        conn.execute(
            "INSERT INTO novels (canonical_title, status) VALUES
               ('Jumped', 'reading'), ('First Entry', 'reading'),
               ('Corrected', 'reading'), ('Small Step', 'reading'),
               ('Half Chapter', 'reading')",
            [],
        ).unwrap();

        conn.execute_batch(
            "INSERT INTO reading_log (novel_id, action, chapter, timestamp) VALUES
               (1, 'started',     1, strftime('%s','now') - 3 * 86400),
               (1, 'progressed',  5, strftime('%s','now') - 1 * 86400),
               (2, 'progressed', 12, strftime('%s','now') - 1 * 86400),
               (3, 'started',    40, strftime('%s','now') - 2 * 86400),
               (3, 'progressed', 38, strftime('%s','now') - 1 * 86400),
               (4, 'started',    10, strftime('%s','now') - 3 * 86400),
               (4, 'progressed', 12, strftime('%s','now') - 2 * 86400),
               (5, 'started',    20, strftime('%s','now') - 4 * 86400),
               (5, 'progressed', 21.5, strftime('%s','now') - 3 * 86400)",
        ).unwrap();

        let stats = build_stats(path.to_str().unwrap()).unwrap();
        let day = |days_ago: usize| &stats.activity[stats.activity.len() - 1 - days_ago];

        assert_eq!(
            day(1).chapters, 5,
            "1 → 5 is four chapters, plus one for the novel with no earlier chapter, \
             and the backwards correction adds nothing"
        );
        assert_eq!(day(2).chapters, 2, "10 → 12 is two chapters");
        assert_eq!(day(3).chapters, 2, "20 → 21.5 rounds to the nearest whole chapter");
        assert_eq!(stats.chapters_30d, 9, "the pace numbers follow the per-day counts");

        let _ = std::fs::remove_file(&path);
    }

    /// The per-novel timeline the edit panel shows
    #[test]
    fn the_history_lists_what_each_entry_gained() {
        let path = seeded_db("history");
        let history = novel_history(path.to_str().unwrap(), 1).unwrap();

        let rows: Vec<(String, Option<f64>, i64)> = history
            .entries
            .iter()
            .map(|e| (e.action.clone(), e.chapter, e.gained))
            .collect();

        assert_eq!(
            rows,
            vec![
                ("progressed".to_string(), Some(20.0), 10),
                ("progressed".to_string(), Some(10.0), 9),
                ("started".to_string(), Some(1.0), 0),
            ],
            "newest first, and only progress entries carry chapters"
        );
        assert_eq!(history.chapters_30d, 19, "the same 30-day window as the pace card");

        let _ = std::fs::remove_file(&path);
    }

    /// The timeline and the charts read the same rule, so they cannot drift apart
    #[test]
    fn the_history_adds_up_to_the_chart() {
        let path = seeded_db("history-sums");
        let history = novel_history(path.to_str().unwrap(), 1).unwrap();
        let stats = build_stats(path.to_str().unwrap()).unwrap();

        let logged: i64 = history.entries.iter().map(|e| e.gained).sum();
        let charted: i64 = stats.activity.iter().map(|day| day.chapters).sum();

        // Only novel 1 ever progressed in the seeded library
        assert_eq!(logged, 19, "1 → 10 → 20");
        assert_eq!(logged, charted, "a novel's log is the chart's data, counted once");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_jump_reads_as_the_chapters_it_covered() {
        let path = fresh_db("history-jump");
        let conn = Connection::open(&path).unwrap();

        conn.execute(
            "INSERT INTO novels (id, canonical_title, status) VALUES (1, 'Jumped', 'reading')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO reading_log (novel_id, action, chapter, timestamp) VALUES
               (1, 'started',    1, strftime('%s','now') - 2 * 86400),
               (1, 'progressed', 5, strftime('%s','now') - 1 * 86400),
               (1, 'progressed', 3, strftime('%s','now'))",
        )
        .unwrap();

        let history = novel_history(path.to_str().unwrap(), 1).unwrap();
        let gained: Vec<i64> = history.entries.iter().map(|e| e.gained).collect();

        assert_eq!(
            gained,
            vec![0, 4, 0],
            "newest first: a backwards correction adds nothing, the 1 → 5 jump adds four"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn library_completion_and_drop_points() {
        let path = seeded_db("library");
        let stats = build_stats(path.to_str().unwrap()).unwrap();

        let counts: Vec<(String, i64)> = stats
            .status_counts
            .iter()
            .map(|s| (s.status.clone(), s.count))
            .collect();
        assert_eq!(
            counts,
            vec![
                ("reading".to_string(), 1),
                ("planned".to_string(), 1),
                ("completed".to_string(), 1),
                ("dropped".to_string(), 1),
            ]
        );
        assert_eq!(stats.total_novels, 4);
        assert_eq!(stats.tagged_novels, 3, "the untagged planned novel doesn't count");

        // Completion reads each novel's latest status action
        assert_eq!((stats.completed, stats.dropped), (1, 1));

        // Chapter 30 is a "25–49" drop, and nothing else was dropped
        let dropped: Vec<(String, i64)> = stats
            .drop_points
            .iter()
            .map(|b| (b.label.clone(), b.count))
            .collect();
        assert_eq!(
            dropped,
            vec![
                ("0–24".to_string(), 0),
                ("25–49".to_string(), 1),
                ("50–99".to_string(), 0),
                ("100–199".to_string(), 0),
                ("200–399".to_string(), 0),
                ("400+".to_string(), 0),
            ]
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tag_stats_and_taste_drift() {
        let path = seeded_db("tags");
        let stats = build_stats(path.to_str().unwrap()).unwrap();

        // Both tags sit on two novels; LitRPG sorts first when the counts tie
        let tags: Vec<(String, i64, i64, i64, i64)> = stats
            .tag_stats
            .iter()
            .map(|t| (t.tag.clone(), t.novels, t.completed, t.dropped, t.chapters))
            .collect();

        assert_eq!(
            tags,
            vec![
                ("LitRPG".to_string(), 2, 1, 0, 19),
                ("Weak to Strong".to_string(), 2, 0, 1, 19),
            ],
            "per-tag novels, outcomes and chapters read (1 → 10 → 20)"
        );

        assert_eq!(stats.tag_years.len(), 1, "everything was logged this year");
        assert!(stats.tag_years[0].tags.iter().any(|b| b.label == "LitRPG"));
        assert!(stats.tag_years[0].tags.iter().all(|b| b.count > 0));

        // Nothing in the seeded library has been rated
        assert!(
            stats.tag_stats.iter().all(|t| t.rated == 0 && t.avg_rating.is_none()),
            "an unrated novel must not invent an average"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// A fresh install has nothing to show — every stat must still come back
    #[test]
    fn an_empty_library_reports_zeros() {
        let path = fresh_db("empty");
        let stats = build_stats(path.to_str().unwrap()).unwrap();

        assert_eq!(stats.log_entries, 0);
        assert_eq!(stats.total_novels, 0);
        assert_eq!(stats.first_entry, None);
        assert_eq!((stats.current_streak, stats.longest_streak), (0, 0));
        assert_eq!((stats.completed, stats.dropped), (0, 0));
        assert_eq!(stats.chapters_per_day, 0.0);
        assert_eq!(stats.weeks.len(), PACE_WEEKS, "the chart keeps its shape with no data");
        assert!(stats.activity.iter().all(|d| d.entries == 0));
        assert!(stats.tag_stats.is_empty());
        assert!(stats.tag_years.is_empty());
        assert!(stats.drop_reasons.is_empty());

        let _ = std::fs::remove_file(&path);
    }

    /// Ratings and drop reasons are the only taste signal the library carries
    #[test]
    fn ratings_average_per_tag_and_drop_reasons_are_grouped() {
        let path = fresh_db("ratings");
        let conn = Connection::open(&path).unwrap();

        conn.execute_batch(
            "INSERT INTO novels (canonical_title, status, tags, rating, drop_reason) VALUES
               ('Loved',   'completed', '[\"LitRPG\"]', 5,    NULL),
               ('Liked',   'reading',   '[\"LitRPG\"]', 3,    NULL),
               ('Unrated', 'reading',   '[\"LitRPG\"]', NULL, NULL),
               ('Bored',   'dropped',   '[\"Harem\"]',  2,    'Lost interest'),
               ('Boring',  'dropped',   '[\"Harem\"]',  NULL, 'Lost interest'),
               ('Slow',    'dropped',   NULL,          1,    'Too slow'),
               ('Resumed', 'reading',   NULL,          2,    'Lost interest')",
        )
        .unwrap();

        let stats = build_stats(path.to_str().unwrap()).unwrap();

        let litrpg = stats.tag_stats.iter().find(|t| t.tag == "LitRPG").unwrap();
        assert_eq!(litrpg.rated, 2, "the unrated novel is not averaged in");
        assert_eq!(
            litrpg.avg_rating.map(|r| (r * 100.0).round()),
            Some(400.0),
            "5 and 3 average to 4"
        );

        let harem = stats.tag_stats.iter().find(|t| t.tag == "Harem").unwrap();
        assert_eq!((harem.rated, harem.avg_rating), (1, Some(2.0)));

        // A novel that was dropped and then resumed is not a drop any more, so its
        // reason doesn't count towards the chart
        let reasons: Vec<(String, i64)> = stats
            .drop_reasons
            .iter()
            .map(|b| (b.label.clone(), b.count))
            .collect();
        assert_eq!(
            reasons,
            vec![("Lost interest".to_string(), 2), ("Too slow".to_string(), 1)],
            "biggest reason first"
        );

        let _ = std::fs::remove_file(&path);
    }
}

