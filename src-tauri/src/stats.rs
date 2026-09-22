//! Reading statistics (plan §4.4).
//!
//! Every number comes from `reading_log` and the library rows. Nothing is
//! estimated: what can't be known yet (chapter totals — see NG2) is left out
//! rather than faked.

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
}

#[derive(Serialize, Debug, PartialEq)]
pub struct YearTag {
    pub year: String,
    pub tags: Vec<Bucket>,
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
        tag_stats: tag_stats(&conn)?,
        tag_years: tag_years(&conn)?,
        activity,
    })
}


/// One row per day for the last year, so the heatmap, streaks and pace all read
/// from the same series. Dates are UTC — the same clock the log is written on.
fn daily_activity(conn: &Connection) -> Result<Vec<Day>, String> {
    let mut stmt = conn
        .prepare(
            "WITH RECURSIVE days(d) AS (
               SELECT date('now', ?1)
               UNION ALL
               SELECT date(d, '+1 day') FROM days WHERE d < date('now')
             )
             SELECT d,
                    (SELECT COUNT(*) FROM reading_log
                      WHERE date(timestamp, 'unixepoch') = d) AS entries,
                    (SELECT COUNT(*) FROM reading_log
                      WHERE action = 'progressed' AND date(timestamp, 'unixepoch') = d) AS chapters
             FROM days",
        )
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


/// Per-tag counts for the tags used most. Tags arrive from several sites, so the
/// vocabulary keeps their spelling aligned (see server.rs).
fn tag_stats(conn: &Connection) -> Result<Vec<TagStat>, String> {
    let mut stmt = conn
        .prepare(
            "WITH tag_novels AS (
               SELECT n.id AS novel_id, j.value AS tag
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
                    COUNT(DISTINCT CASE WHEN la.action = 'dropped' THEN tn.novel_id END) AS dropped
             FROM tag_novels tn
             LEFT JOIN last_action la ON la.novel_id = tn.novel_id AND la.rn = 1
             GROUP BY tn.tag
             ORDER BY novels DESC, tn.tag
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(String, i64, i64, i64)> = stmt
        .query_map([TOP_TAGS as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut chapter_stmt = conn
        .prepare(
            "SELECT j.value AS tag, COUNT(*) AS chapters
             FROM novels n
             CROSS JOIN json_each(n.tags) j
             JOIN reading_log rl ON rl.novel_id = n.id AND rl.action = 'progressed'
             WHERE n.tags IS NOT NULL AND json_valid(n.tags) AND json_type(n.tags) = 'array'
             GROUP BY j.value",
        )
        .map_err(|e| e.to_string())?;

    let chapters: Vec<(String, i64)> = chapter_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows
        .into_iter()
        .map(|(tag, novels, completed, dropped)| TagStat {
            chapters: chapters
                .iter()
                .find(|(name, _)| name == &tag)
                .map(|(_, count)| *count)
                .unwrap_or(0),
            tag,
            novels,
            completed,
            dropped,
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
    const MIGRATIONS: [&str; 4] = [
        include_str!("../migrations/001_init.sql"),
        include_str!("../migrations/002_sources_unique.sql"),
        include_str!("../migrations/003_aliases_index.sql"),
        include_str!("../migrations/004_metadata_reading_log.sql"),
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

        assert_eq!(stats.chapters_30d, 2);
        assert!((stats.chapters_per_day - 2.0 / 30.0).abs() < 0.0001);
        assert!((stats.chapters_per_active_day - 0.5).abs() < 0.0001);

        assert_eq!(stats.weeks.len(), PACE_WEEKS);
        assert_eq!(
            stats.weeks.last().unwrap().chapters, 2,
            "the week ending today holds both logged chapters"
        );
        assert_eq!(stats.weeks[stats.weeks.len() - 2].chapters, 0, "the week before it is empty");
        assert_eq!(stats.weeks.iter().map(|w| w.chapters).sum::<i64>(), 2);

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
                ("LitRPG".to_string(), 2, 1, 0, 2),
                ("Weak to Strong".to_string(), 2, 0, 1, 2),
            ],
            "per-tag novels, outcomes and logged chapters"
        );

        assert_eq!(stats.tag_years.len(), 1, "everything was logged this year");
        assert!(stats.tag_years[0].tags.iter().any(|b| b.label == "LitRPG"));
        assert!(stats.tag_years[0].tags.iter().all(|b| b.count > 0));

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

        let _ = std::fs::remove_file(&path);
    }
}

