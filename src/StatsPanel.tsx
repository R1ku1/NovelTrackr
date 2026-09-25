import { useEffect, useState } from "react";
import {
  getStats,
  type Bucket,
  type Day,
  type NovelPace,
  type SourceStat,
  type Stats,
  type TagStat,
  type Week,
} from "./stats";
import { STATUS_OPTIONS, FONT, BtnDanger, BtnSecondary } from "./formComponents";

// ── Helpers ───────────────────────────────────────────────────────────────────
function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Heatmap columns are weeks; the first column is padded so each row is a weekday.
// Dates are UTC — the same clock the log is written on.
function heatmapWeeks(activity: Day[]): (Day | null)[][] {
  if (activity.length === 0) return [];

  const firstWeekday = new Date(`${activity[0].date}T00:00:00Z`).getUTCDay();
  const weeks: (Day | null)[][] = [];
  let week: (Day | null)[] = Array.from({ length: firstWeekday }, () => null);

  for (const day of activity) {
    week.push(day);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    weeks.push([...week, ...Array.from({ length: 7 - week.length }, () => null)]);
  }

  return weeks;
}

// Heat intensity is chapters read, so a day whose single update jumped four
// chapters paints like four chapters, not one entry.
// ponytail: the five bands were tuned for log entries; if an ordinary reading
// day now saturates at the top band, re-tune these thresholds against real data.
function heatColour(count: number): string {
  if (count <= 0) return "#16161e";
  if (count <= 2) return "#1d3a5c";
  if (count <= 5) return "#2b5687";
  if (count <= 10) return "#3f78b5";
  return "#60a5fa";
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  page: {
    padding: "24px 28px 48px",
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 26,
  },
  head: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  headTitle: {
    fontSize: 22,
    fontStyle: "italic",
    fontWeight: 700,
    color: "#e8e6e1",
    letterSpacing: "0.02em",
    textWrap: "balance",
  },
  headMeta: {
    fontSize: 11,
    color: "#555",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  empty: {
    fontSize: 13,
    color: "#8a8a96",
    lineHeight: 1.6,
    border: "1px solid #22222e",
    borderRadius: 10,
    padding: "16px 18px",
    background: "#13131a",
  },
  notice: {
    fontSize: 11,
    color: "#a8a06a",
    lineHeight: 1.5,
    border: "1px solid #3a3620",
    borderRadius: 8,
    padding: "8px 12px",
    background: "#1c1a12",
    marginBottom: 4,
  },
  state: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    color: "#555",
    fontSize: 14,
    gap: 4,
  },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 12,
  },
  card: {
    background: "#141418",
    border: "1px solid #222230",
    borderRadius: 12,
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  cardLabel: {
    fontSize: 9,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "#555",
  },
  cardValue: {
    fontSize: 24,
    fontWeight: 700,
    fontStyle: "italic",
    color: "#e8e6e1",
    fontVariantNumeric: "tabular-nums",
  },
  cardSub: {
    fontSize: 11,
    color: "#6a6a76",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    background: "#12121a",
    border: "1px solid #1e1e28",
    borderRadius: 12,
    padding: "16px 18px",
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "#888",
  },
  sectionHint: {
    fontSize: 11,
    color: "#4a4a56",
    marginTop: -4,
  },
  subTitle: {
    fontSize: 10,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "#555",
    marginBottom: 8,
  },
  tagRow: {
    display: "flex",
    alignItems: "center",
    padding: "7px 0",
    borderBottom: "1px solid #191922",
  },
  tagHead: {
    width: 78,
    fontSize: 9,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "#444",
    textAlign: "right",
  },
  tagCell: {
    width: 78,
    fontSize: 12,
    color: "#888",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  },
  totalChip: {
    fontSize: 11,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#555",
    border: "1px solid #22222e",
    padding: "3px 10px",
    borderRadius: 20,
  },
  yearRow: {
    display: "flex",
    gap: 10,
    padding: "3px 0",
  },
};

// ── Building blocks ───────────────────────────────────────────────────────────
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.sectionTitle}>{title}</h2>
      {hint && <div style={styles.sectionHint}>{hint}</div>}
      {children}
    </section>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardLabel}>{label}</div>
      <div style={styles.cardValue}>{value}</div>
      <div style={styles.cardSub}>{sub}</div>
    </div>
  );
}

function Heatmap({ activity }: { activity: Day[] }) {
  const weeks = heatmapWeeks(activity);
  const readingDays = activity.filter((d) => d.chapters > 0).length;

  return (
    <div
      role="img"
      aria-label={`Chapters read over the last 12 months: ${plural(readingDays, "day")} with reading`}
      style={{ display: "flex", gap: 3, overflowX: "auto", paddingBottom: 4 }}
    >
      {weeks.map((week, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {week.map((day, j) => (
            <div
              key={j}
              title={day ? `${day.date} — ${plural(day.chapters, "chapter")} read · ${day.entries} ${day.entries === 1 ? "entry" : "entries"}` : ""}
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: day ? heatColour(day.chapters) : "transparent",
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function WeekBars({ weeks }: { weeks: Week[] }) {
  const max = Math.max(1, ...weeks.map((w) => w.chapters));

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
      {weeks.map((week, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <div style={{ fontSize: 10, color: week.chapters > 0 ? "#8a8a96" : "#3a3a45", fontVariantNumeric: "tabular-nums" }}>{week.chapters}</div>
          <div
            title={`${plural(week.chapters, "chapter")} read`}
            style={{
              width: "100%",
              height: Math.max(2, Math.round((week.chapters / max) * 64)),
              background: week.chapters > 0 ? "#3f78b5" : "#1e1e28",
              borderRadius: 3,
            }}
          />
          <div style={{ fontSize: 9, color: "#444", whiteSpace: "nowrap" }}>{week.label}</div>
        </div>
      ))}
    </div>
  );
}

function Histogram({ buckets, colour = "#a8555a" }: { buckets: Bucket[]; colour?: string }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {buckets.map((bucket) => (
        <div key={bucket.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 66, fontSize: 11, color: "#666", fontFamily: FONT }}>{bucket.label}</span>
          <div style={{ flex: 1, height: 10, background: "#16161e", borderRadius: 3, overflow: "hidden" }}>
            <div
              style={{
                width: `${(bucket.count / max) * 100}%`,
                height: "100%",
                background: bucket.count > 0 ? colour : "transparent",
                borderRadius: 3,
              }}
            />
          </div>
          <span style={{ width: 24, fontSize: 11, color: bucket.count > 0 ? "#999" : "#3a3a45", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {bucket.count}
          </span>
        </div>
      ))}
    </div>
  );
}

function TagTable({ rows }: { rows: TagStat[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ ...styles.tagRow, borderBottom: "1px solid #1e1e28" }}>
        <span style={{ ...styles.tagHead, flex: 1 }}>Tag</span>
        <span style={styles.tagHead}>Novels</span>
        <span style={styles.tagHead}>Completion</span>
        <span style={styles.tagHead}>Chapters</span>
        <span style={styles.tagHead}>Rating</span>
      </div>
      {rows.map((row) => {
        const decided = row.completed + row.dropped;
        return (
          <div key={row.tag} style={styles.tagRow}>
            <span style={{ flex: 1, fontSize: 12, color: "#d5d2cc" }}>{row.tag}</span>
            <span style={styles.tagCell}>{row.novels}</span>
            <span style={{ ...styles.tagCell, color: decided === 0 ? "#3a3a45" : "#9ec1e4" }}>
              {decided === 0 ? "—" : `${percent(row.completed, decided)}%`}
            </span>
            <span style={styles.tagCell}>{row.chapters}</span>
            {/* An average without its count says very little, so the count is the
                tooltip and a tag with nothing rated shows a dash */}
            <span
              style={{ ...styles.tagCell, color: row.rated === 0 ? "#3a3a45" : "#e0b64a" }}
              title={row.rated === 0 ? "Nothing rated yet" : `${row.rated} of ${row.novels} novels rated`}
            >
              {row.rated === 0 || row.avg_rating === null ? "—" : row.avg_rating.toFixed(1)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Leaderboards and sources ──────────────────────────────────────────────────
// Both read the log and the sources the extension already wrote — no new data
function PaceRows({ rows, showRate }: { rows: NovelPace[]; showRate?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((row) => (
        <div key={row.title} style={styles.tagRow}>
          <span
            style={{
              flex: 1,
              fontSize: 12,
              color: "#d5d2cc",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.title}
          </span>
          <span style={styles.tagCell} title="chapters read">
            {row.chapters}
          </span>
          <span style={styles.tagCell} title="days with a progress entry">
            {row.days} d
          </span>
          {showRate && (
            <span style={{ ...styles.tagCell, color: "#60a5fa" }} title="chapters a day">
              {row.per_day.toFixed(1)}/d
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function SourceTable({ rows }: { rows: SourceStat[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ ...styles.tagRow, borderBottom: "1px solid #1e1e28" }}>
        <span style={{ ...styles.tagHead, flex: 1 }}>Site</span>
        <span style={styles.tagHead}>Novels</span>
        <span style={styles.tagHead}>Chapters</span>
      </div>
      {rows.map((row) => (
        <div key={row.domain} style={styles.tagRow}>
          <span style={{ flex: 1, fontSize: 12, color: "#d5d2cc" }}>{row.domain}</span>
          <span style={styles.tagCell}>{row.novels}</span>
          <span style={styles.tagCell}>{row.chapters}</span>
        </div>
      ))}
    </div>
  );
}

// ── The panel ─────────────────────────────────────────────────────────────────
export default function StatsPanel({
  onExport,
  onRestore,
}: {
  onExport: () => void;
  onRestore: () => Promise<void>;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    // `reload` is what a restore bumps — the numbers on screen then belong to a
    // library that no longer exists
    setError(null);
    getStats()
      .then(setStats)
      .catch((e: unknown) => {
        console.error("stats failed to load:", e);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [reload]);

  // Replacing the library is the one action here that can lose data, so it asks
  // first and reports through the header like every other write
  async function handleRestore() {
    setConfirmRestore(false);
    setStats(null);
    await onRestore();
    setReload((n) => n + 1);
  }

  if (error) {
    return (
      <div style={styles.state}>
        Couldn't load stats.
        <div style={{ fontSize: 12, color: "#8a5a5a", marginTop: 8, letterSpacing: 0 }}>{error}</div>
      </div>
    );
  }
  if (!stats) return <div style={styles.state}>Reading stats…</div>;

  const hasLog = stats.log_entries > 0;
  const coverage = percent(stats.tagged_novels, stats.total_novels);
  const backlog = stats.status_counts
    .filter((s) => s.status === "planned" || s.status === "paused")
    .reduce((sum, s) => sum + s.count, 0);

  return (
    <div style={styles.page}>
      <div style={styles.head}>
        <div>
          <h1 style={styles.headTitle}>Reading Stats</h1>
          <div style={styles.headMeta}>
            {plural(stats.log_entries, "log entry")}
            {stats.first_entry ? ` · since ${stats.first_entry}` : ""}
            {` · ${plural(stats.active_days, "active day")}`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {confirmRestore ? (
            <>
              <span style={{ fontSize: 11, color: "#a8a06a", maxWidth: 280, lineHeight: 1.4 }}>
                Replace the whole library with a backup file? A copy of the current
                database is kept in the app's backups folder first.
              </span>
              <BtnSecondary label="Cancel" onClick={() => setConfirmRestore(false)} />
              <BtnDanger label="Replace library" onClick={handleRestore} />
            </>
          ) : (
            <>
              <BtnSecondary label="Restore Backup" onClick={() => setConfirmRestore(true)} />
              <BtnSecondary label="Export Data" onClick={onExport} />
            </>
          )}
        </div>
      </div>

      {!hasLog && (
        <div style={styles.empty}>
          Start reading to unlock stats — progress updates and status changes fill the log.
        </div>
      )}

      {hasLog && stats.active_days < 7 && (
        <div style={styles.notice}>
          Only {plural(stats.active_days, "day")} of activity so far. Pace and streaks get sharper as the log grows.
        </div>
      )}

      <div style={styles.cards}>
        <StatCard
          label="Completion rate"
          value={`${percent(stats.completed, stats.completed + stats.dropped)}%`}
          sub={`${stats.completed} completed · ${stats.dropped} dropped`}
        />
        <StatCard
          label="Pace · 30 days"
          value={`${stats.chapters_per_day.toFixed(1)}/day`}
          sub={`${stats.chapters_30d} chapters · ${stats.chapters_per_active_day.toFixed(1)} per active day`}
        />
        <StatCard
          label="Streak"
          value={`${stats.current_streak} d`}
          sub={`Longest ${stats.longest_streak} d in the last year`}
        />
        <StatCard
          label="Backlog"
          value={`${backlog}`}
          sub="Planned + paused novels"
        />
      </div>

      <Section title="Activity" hint="Chapters read each day, last 12 months">
        <Heatmap activity={stats.activity} />
      </Section>

      <Section title="Chapters per week" hint="Chapters read in the last 8 weeks">
        <WeekBars weeks={stats.weeks} />
      </Section>

      <Section title="Where novels get dropped" hint="Chapter number at the moment they were dropped">
        <Histogram buckets={stats.drop_points} />
      </Section>

      {stats.drop_reasons.length > 0 && (
        <Section title="Why novels get dropped" hint="Reasons recorded when a novel is dropped">
          <Histogram buckets={stats.drop_reasons} />
        </Section>
      )}

      {stats.reading_now.length > 0 && (
        <Section title="Reading now" hint="Chapters read in the last 30 days, biggest first">
          <PaceRows rows={stats.reading_now} />
        </Section>
      )}

      {stats.fastest_finishes.length > 0 && (
        <Section title="Quickest finishes" hint="Chapters a day, from the first log entry to the last">
          <PaceRows rows={stats.fastest_finishes} showRate />
        </Section>
      )}

      {stats.backlog.buckets.some((b) => b.count > 0) && (
        <Section
          title="Backlog age"
          hint={stats.backlog.oldest_title
            ? `Oldest plan: ${stats.backlog.oldest_title} · waiting ${plural(stats.backlog.oldest_days, "day")}`
            : "Planned novels by how long they have been waiting"}
        >
          <Histogram buckets={stats.backlog.buckets} colour="#a78bfa" />
        </Section>
      )}

      {stats.sources.length > 0 && (
        <Section title="Where you read" hint="Each novel counts towards the site it was last read on">
          <SourceTable rows={stats.sources} />
        </Section>
      )}

      <Section title="Library">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {stats.status_counts.map((row) => {
            const meta = STATUS_OPTIONS.find((o) => o.value === row.status);
            const colour = meta?.color ?? "#666";
            return (
              <span
                key={row.status}
                style={{
                  fontSize: 11,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: colour,
                  border: `1px solid ${colour}40`,
                  background: `${colour}0f`,
                  padding: "3px 10px",
                  borderRadius: 20,
                }}
              >
                {meta?.label ?? row.status} {row.count}
              </span>
            );
          })}
          <span style={styles.totalChip}>Total {stats.total_novels}</span>
        </div>
      </Section>

      {stats.tag_stats.length > 0 && (
        <Section
          title="Tags"
          hint={`Based on ${stats.tagged_novels} of ${stats.total_novels} novels with tags (${coverage}%)`}
        >
          {coverage < 40 && (
            <div style={styles.notice}>
              Improve tag coverage to unlock better tag insights — “Find on NU” and visiting the sites you read on both fill tags in.
            </div>
          )}
          <TagTable rows={stats.tag_stats} />
          {stats.tag_years.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={styles.subTitle}>Taste over time · chapters read</div>
              {stats.tag_years.map((year) => (
                <div key={year.year} style={styles.yearRow}>
                  <span style={{ width: 44, color: "#666", fontSize: 12 }}>{year.year}</span>
                  <span style={{ fontSize: 12, color: "#9a9a9a" }}>
                    {year.tags.map((t) => `${t.label} (${t.count})`).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
