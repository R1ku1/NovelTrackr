//! Reading statistics (plan §4.4).
//!
//! Every number comes from `reading_log` and the library rows. Nothing is
//! estimated: what can't be known yet (chapter totals — see NG2) is left out
//! rather than faked.
//!
//! Chapters are counted as the chapter numbers a log entry moved, not as log
//! entries (see [`CHAPTER_ADVANCE`]) — one update that jumps 1 → 5 is four
//! chapters of reading.

use rusqlite::{Connection, OptionalExtension};
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
/// Novels listed in the "what am I reading" and "fastest finished" tables
const TOP_NOVELS: usize = 5;

/// How long planned novels have been waiting. Half-open ranges, like the drop
/// buckets, so every novel lands in exactly one.
const BACKLOG_BUCKETS: [(&str, f64, f64); 5] = [
    ("0–30 days", 0.0, 30.0),
    ("1–3 months", 30.0, 90.0),
    ("3–6 months", 90.0, 180.0),
    ("6–12 months", 180.0, 365.0),
    ("over a year", 365.0, f64::INFINITY),
];

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

/// Where a novel is read: the site it was last seen on, so a novel only counts
/// towards the domain it is actually being read from.
#[derive(Serialize, Debug, PartialEq)]
pub struct SourceStat {
    pub domain: String,
    pub novels: i64,
    pub chapters: i64,
}

/// One row of a leaderboard: how much was read, over how many days, and the rate
/// that falls out of the two.
#[derive(Serialize, Debug, PartialEq)]
pub struct NovelPace {
    pub title: String,
    pub chapters: i64,
    pub days: i64,
    pub per_day: f64,
}

/// Planned novels by how long they have been waiting, and the worst offender
#[derive(Serialize, Debug, PartialEq)]
pub struct Backlog {
    pub buckets: Vec<Bucket>,
    pub oldest_title: Option<String>,
    pub oldest_days: i64,
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
    pub sources: Vec<SourceStat>,
    pub reading_now: Vec<NovelPace>,
    pub fastest_finishes: Vec<NovelPace>,
    pub backlog: Backlog,
    pub unread: Unread,
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
        sources: source_stats(&conn)?,
        reading_now: reading_now(&conn)?,
        fastest_finishes: fastest_finishes(&conn)?,
        backlog: backlog(&conn)?,
        unread: unread(&conn)?,
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

/// A latest chapter nobody has confirmed in this long is shown, but muted. The
/// library row greys out at the same age (src/latest.ts) — the two have to agree.
const STALE_DAYS: i64 = 30;

/// How far behind the sites the library is. Best effort by design: a novel nobody
/// has browsed lately has no number at all, and is never counted as zero.
#[derive(Serialize, Debug, PartialEq)]
pub struct Unread {
    pub chapters: i64,
    pub novels: i64,
    pub known: i64,
    pub stale: i64,
    pub total: i64,
}

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


/// Which sites the library is actually read on. Preferred sources only — the
/// extension keeps exactly one per novel, so nothing is counted twice.
fn source_stats(conn: &Connection) -> Result<Vec<SourceStat>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT s.domain,
                    COUNT(DISTINCT s.novel_id) AS novels,
                    COALESCE(CAST(ROUND(SUM(a.gained)) AS INTEGER), 0) AS chapters
             FROM sources s
             LEFT JOIN ({CHAPTER_ADVANCE}) a ON a.novel_id = s.novel_id
             WHERE s.is_preferred = 1
             GROUP BY s.domain
             ORDER BY novels DESC, s.domain",
        ))
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SourceStat { domain: row.get(0)?, novels: row.get(1)?, chapters: row.get(2)? })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// What is being read right now: the last 30 days, biggest first. `days` counts
/// the days that actually had a progress entry, so a novel read in one sitting is
/// not slower than one spread over a week.
fn reading_now(conn: &Connection) -> Result<Vec<NovelPace>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT n.canonical_title AS title,
                    CAST(ROUND(SUM(a.gained)) AS INTEGER) AS chapters,
                    COUNT(DISTINCT a.day) AS days
             FROM ({CHAPTER_ADVANCE}) a
             JOIN novels n ON n.id = a.novel_id
             WHERE a.day >= date('now', ?1)
             GROUP BY a.novel_id
             ORDER BY chapters DESC, title
             LIMIT ?2",
        ))
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(
            rusqlite::params![format!("-{} days", PACE_DAYS - 1), TOP_NOVELS as i64],
            |row| {
                let chapters: i64 = row.get(1)?;
                let days: i64 = row.get(2)?;
                Ok(NovelPace {
                    title: row.get(0)?,
                    chapters,
                    days,
                    per_day: per_day(chapters, days),
                })
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Finished novels by chapters a day — the quickest reads, measured from the first
/// log entry to the last. A novel whose whole log lands on one day counts as one.
fn fastest_finishes(conn: &Connection) -> Result<Vec<NovelPace>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "WITH span AS (
               SELECT novel_id, MIN(timestamp) AS first, MAX(timestamp) AS last
               FROM reading_log
               GROUP BY novel_id
             )
             SELECT n.canonical_title AS title,
                    CAST(ROUND(SUM(a.gained)) AS INTEGER) AS chapters,
                    MAX(1, CAST(ROUND((s.last - s.first) / 86400.0) AS INTEGER)) AS days
             FROM ({CHAPTER_ADVANCE}) a
             JOIN novels n ON n.id = a.novel_id
             JOIN span s ON s.novel_id = a.novel_id
             WHERE n.status = 'completed'
             GROUP BY a.novel_id
             HAVING chapters > 0
             ORDER BY (chapters * 1.0) / days DESC, chapters DESC
             LIMIT ?1",
        ))
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([TOP_NOVELS as i64], |row| {
            let chapters: i64 = row.get(1)?;
            let days: i64 = row.get(2)?;
            Ok(NovelPace {
                title: row.get(0)?,
                chapters,
                days,
                per_day: per_day(chapters, days),
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Chapters a day, never dividing by zero
fn per_day(chapters: i64, days: i64) -> f64 {
    chapters as f64 / days.max(1) as f64
}

/// How far behind the sites the library is. Only novels being read count towards
/// the gap — a finished novel that has since gained chapters is not a backlog, and
/// one with no latest chapter is unknown rather than zero. `known` and `total` are
/// what make the headline honest about its own coverage.
fn unread(conn: &Connection) -> Result<Unread, String> {
    conn.query_row(
        &format!(
            "WITH gaps AS (
               SELECT n.latest_chapter - p.chapter_sort AS gap
               FROM novels n
               JOIN progress p ON p.novel_id = n.id
               WHERE n.status IN ('reading', 'paused')
                 AND n.latest_chapter IS NOT NULL
                 AND p.chapter_sort IS NOT NULL
                 AND n.latest_chapter > p.chapter_sort
             )
             SELECT (SELECT COUNT(*) FROM novels),
                    (SELECT COUNT(*) FROM novels WHERE latest_chapter IS NOT NULL),
                    (SELECT COUNT(*) FROM novels
                      WHERE latest_chapter IS NOT NULL
                        AND (latest_chapter_seen_at IS NULL
                             OR latest_chapter_seen_at < strftime('%s','now') - ?1)),
                    (SELECT COUNT(*) FROM gaps),
                    (SELECT COALESCE(CAST(ROUND(SUM(gap)) AS INTEGER), 0) FROM gaps)"
        ),
        rusqlite::params![STALE_DAYS * 86_400],
        |row| {
            Ok(Unread {
                total: row.get(0)?,
                known: row.get(1)?,
                stale: row.get(2)?,
                novels: row.get(3)?,
                chapters: row.get(4)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// Planned novels by how long they have been waiting. Paused ones don't count:
/// they were started, so they are not a plan being put off.
fn backlog(conn: &Connection) -> Result<Backlog, String> {
    let mut stmt = conn
        .prepare(
            "SELECT julianday('now') - julianday(created_at)
             FROM novels
             WHERE status = 'planned'",
        )
        .map_err(|e| e.to_string())?;

    let ages: Vec<f64> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let buckets = BACKLOG_BUCKETS
        .iter()
        .map(|(label, low, high)| Bucket {
            label: label.to_string(),
            count: ages.iter().filter(|days| **days >= *low && **days < *high).count() as i64,
        })
        .collect();

    let oldest: Option<(String, i64)> = conn
        .query_row(
            "SELECT canonical_title,
                    CAST(ROUND(julianday('now') - julianday(created_at)) AS INTEGER)
             FROM novels
             WHERE status = 'planned'
             ORDER BY created_at, id
             LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(Backlog {
        buckets,
        oldest_title: oldest.as_ref().map(|(title, _)| title.clone()),
        oldest_days: oldest.map(|(_, days)| days).unwrap_or(0),
    })
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

/// The tags behind each year's reading — how taste moves over time (plan §4.4.2).
/// Chapters read, like the rest of the page, so the years add up to the pace.
fn tag_years(conn: &Connection) -> Result<Vec<YearTag>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT strftime('%Y', rl.timestamp, 'unixepoch') AS year,
                    j.value AS tag,
                    CAST(ROUND(SUM(a.gained)) AS INTEGER) AS count
             FROM reading_log rl
             JOIN ({CHAPTER_ADVANCE}) a ON a.id = rl.id
             JOIN novels n ON n.id = rl.novel_id
             CROSS JOIN json_each(n.tags) j
             WHERE n.tags IS NOT NULL AND json_valid(n.tags) AND json_type(n.tags) = 'array'
             GROUP BY year, tag
             ORDER BY year DESC, count DESC",
        ))
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
    const MIGRATIONS: [&str; 6] = [
        include_str!("../migrations/001_init.sql"),
        include_str!("../migrations/002_sources_unique.sql"),
        include_str!("../migrations/003_aliases_index.sql"),
        include_str!("../migrations/004_metadata_reading_log.sql"),
        include_str!("../migrations/005_rating_and_drop_reason.sql"),
        include_str!("../migrations/006_latest_chapter.sql"),
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
        assert_eq!(
            stats.unread,
            Unread { chapters: 0, novels: 0, known: 0, stale: 0, total: 0 },
            "an empty library is not behind on anything"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// Sources, leaderboards, backlog and the tag years all read tables the app
    /// already had — nothing here is estimated
    #[test]
    fn sources_leaderboards_and_backlog_come_from_existing_rows() {
        let path = fresh_db("extras");
        let conn = Connection::open(&path).unwrap();

        conn.execute_batch(
            "INSERT INTO novels (id, canonical_title, status, tags, created_at) VALUES
               (1, 'Halfway',    'completed', '[\"LitRPG\"]', datetime('now','-10 days')),
               (2, 'Current',    'reading',   '[\"LitRPG\"]', datetime('now')),
               (3, 'Waiting',    'planned',   NULL,          datetime('now','-400 days')),
               (4, 'Fresh Plan', 'planned',   NULL,          datetime('now','-10 days'));

             INSERT INTO sources (id, novel_id, domain, url_pattern, is_preferred) VALUES
               (1, 1, 'royalroad.com',   'royalroad.com',   1),
               (2, 2, 'scribblehub.com', 'scribblehub.com', 1),
               (3, 2, 'royalroad.com',   'royalroad.com',   0);

             INSERT INTO reading_log (novel_id, action, chapter, timestamp) VALUES
               (1, 'started',     1, strftime('%s','now') - 10 * 86400),
               (1, 'progressed', 50, strftime('%s','now') - 5 * 86400),
               (2, 'started',     1, strftime('%s','now') - 2 * 86400),
               (2, 'progressed', 10, strftime('%s','now') - 1 * 86400)",
        )
        .unwrap();

        let stats = build_stats(path.to_str().unwrap()).unwrap();

        let sources: Vec<(String, i64, i64)> = stats
            .sources
            .iter()
            .map(|s| (s.domain.clone(), s.novels, s.chapters))
            .collect();
        assert_eq!(
            sources,
            vec![
                ("royalroad.com".to_string(), 1, 49),
                ("scribblehub.com".to_string(), 1, 9),
            ],
            "a novel counts towards the site it is read on, so the second source is left out"
        );

        // Only the last 30 days, biggest first
        let reading: Vec<(String, i64, i64)> = stats
            .reading_now
            .iter()
            .map(|n| (n.title.clone(), n.chapters, n.days))
            .collect();
        assert_eq!(
            reading,
            vec![("Halfway".to_string(), 49, 1), ("Current".to_string(), 9, 1)]
        );

        let fastest = &stats.fastest_finishes;
        assert_eq!(fastest.len(), 1, "only finished novels are ranked");
        assert_eq!(fastest[0].title, "Halfway");
        assert_eq!((fastest[0].chapters, fastest[0].days), (49, 5), "1 → 50 over five days");
        assert!((fastest[0].per_day - 9.8).abs() < 0.0001);

        let buckets: Vec<(String, i64)> = stats
            .backlog
            .buckets
            .iter()
            .map(|b| (b.label.clone(), b.count))
            .collect();
        assert_eq!(
            buckets,
            vec![
                ("0–30 days".to_string(), 1),
                ("1–3 months".to_string(), 0),
                ("3–6 months".to_string(), 0),
                ("6–12 months".to_string(), 0),
                ("over a year".to_string(), 1),
            ],
            "each plan falls in exactly one bucket"
        );
        assert_eq!(stats.backlog.oldest_title.as_deref(), Some("Waiting"));
        assert!(
            (399..=401).contains(&stats.backlog.oldest_days),
            "{} days",
            stats.backlog.oldest_days
        );

        // Taste over time counts chapters now, like the rest of the page
        let litrpg: i64 = stats
            .tag_years
            .iter()
            .map(|year| {
                year.tags
                    .iter()
                    .filter(|t| t.label == "LitRPG")
                    .map(|t| t.count)
                    .sum::<i64>()
            })
            .sum();
        assert_eq!(litrpg, 49 + 9, "the years add up to what the tag accounts for");

        let _ = std::fs::remove_file(&path);
    }
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

    /// The unread headline is best effort: unknown is not zero, and a finished
    /// novel that gained chapters is not something to catch up on
    #[test]
    fn unread_counts_only_novels_with_a_known_latest_chapter() {
        let path = fresh_db("unread");
        let conn = Connection::open(&path).unwrap();

        conn.execute_batch(
            "INSERT INTO novels (id, canonical_title, status, latest_chapter,
                                 latest_chapter_confidence, latest_chapter_seen_at) VALUES
               (1, 'Behind',    'reading',   420,  'exact',     strftime('%s','now')),
               (2, 'Caught up', 'reading',   400,  'caught_up', strftime('%s','now')),
               (3, 'Stale',     'paused',    500,  'exact',     strftime('%s','now') - 40 * 86400),
               (4, 'Unknown',   'reading',   NULL, NULL,        NULL),
               (5, 'Finished',  'completed', 900,  'exact',     strftime('%s','now'));

             INSERT INTO progress (novel_id, chapter_raw, chapter_sort) VALUES
               (1, 'Chapter 400', 400),
               (2, 'Chapter 400', 400),
               (3, 'Chapter 450', 450),
               (4, 'Chapter 10',  10),
               (5, 'Chapter 900', 900)",
        )
        .unwrap();

        let stats = build_stats(path.to_str().unwrap()).unwrap();
        let unread = &stats.unread;

        assert_eq!(unread.chapters, 20 + 50, "400 to 420, and 450 to 500");
        assert_eq!(unread.novels, 2, "the finished novel is not a backlog to clear");
        assert_eq!(unread.known, 4, "four novels have a number at all");
        assert_eq!(unread.stale, 1, "only one has gone unconfirmed for 30+ days");
        assert_eq!(unread.total, 5, "the coverage the headline reports itself against");

        let _ = std::fs::remove_file(&path);
    }

    /// The badge and the headline have to agree on when a number is old
    #[test]
    fn the_staleness_threshold_is_thirty_days() {
        assert_eq!(STALE_DAYS, 30, "changing this changes what the library greys out");

        let path = fresh_db("stale-threshold");
        let conn = Connection::open(&path).unwrap();

        conn.execute_batch(&format!(
            "INSERT INTO novels (id, canonical_title, latest_chapter, latest_chapter_seen_at) VALUES
               (1, 'Fresh', 400, strftime('%s','now') - {} * 86400),
               (2, 'Old',   400, strftime('%s','now') - {} * 86400),
               (3, 'Never', 400, NULL)",
            STALE_DAYS - 1,
            STALE_DAYS + 1,
        ))
        .unwrap();

        let stats = build_stats(path.to_str().unwrap()).unwrap();

        assert_eq!(stats.unread.known, 3);
        assert_eq!(
            stats.unread.stale, 2,
            "one day inside the window is current, one day past it is not, and a \
             number nobody ever confirmed is as old as it gets"
        );

        let _ = std::fs::remove_file(&path);
    }
}

