import { invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/stats.rs. Stats are aggregated in Rust (with tests
// there); this is just the shape that comes back.
export interface Day {
  date: string;
  entries: number;
  chapters: number;
}

export interface StatusCount {
  status: string;
  count: number;
}

export interface Week {
  label: string;
  chapters: number;
}

export interface Bucket {
  label: string;
  count: number;
}

export interface TagStat {
  tag: string;
  novels: number;
  completed: number;
  dropped: number;
  chapters: number;
}

export interface YearTag {
  year: string;
  tags: Bucket[];
}

// One line of a novel's reading log. `gained` is how many chapters that entry
// moved — the same number the charts add up, zero for status changes.
export interface HistoryEntry {
  action: string;
  chapter: number | null;
  at: string;
  gained: number;
}

export interface NovelHistory {
  chapters_30d: number;
  entries: HistoryEntry[];
}

export interface Stats {
  status_counts: StatusCount[];
  total_novels: number;
  tagged_novels: number;
  log_entries: number;
  first_entry: string | null;
  active_days: number;
  completed: number;
  dropped: number;
  chapters_30d: number;
  chapters_per_day: number;
  chapters_per_active_day: number;
  current_streak: number;
  longest_streak: number;
  weeks: Week[];
  activity: Day[];
  drop_points: Bucket[];
  tag_stats: TagStat[];
  tag_years: YearTag[];
}

export async function getStats(): Promise<Stats> {
  return invoke<Stats>("get_stats");
}

// One novel's own log, newest first — what the edit panel's history section shows
export async function getNovelHistory(id: number): Promise<NovelHistory> {
  return invoke<NovelHistory>("get_novel_history", { id });
}
