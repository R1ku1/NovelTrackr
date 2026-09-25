// What the extension has seen of the sites' own chapter numbers (migration 006).
//
// Best effort by design: a novel nobody has browsed lately simply has no value,
// and every helper here answers `null` for "unknown" rather than a zero that
// would read as "nothing new". The library row, the edit panel and the stats
// headline all ask the same questions of this one file.

/// A value nobody has confirmed for this long is shown, but muted. `stats.rs`
/// counts its stale novels at the same age, so the two cannot disagree.
export const STALE_AFTER_DAYS = 30;

const DAY_SECONDS = 86_400;

/// How far behind the site the reader is, or null when that cannot be known
export function unreadChapters(latest: number | null, current: number | null): number | null {
  if (latest === null || current === null) return null;
  const behind = Math.round(latest - current);
  return behind > 0 ? behind : 0;
}

/// True when a number is old enough that the app stops trusting it
export function isStale(seenAt: number | null, now: number = Date.now() / 1000): boolean {
  if (seenAt === null) return true; // never confirmed is as old as it gets
  return now - seenAt > STALE_AFTER_DAYS * DAY_SECONDS;
}

/// "Sep 10" — the day a value was last confirmed, or null when it never was
export function seenDate(seenAt: number | null): string | null {
  if (seenAt === null) return null;
  return new Date(seenAt * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/// What the stored number rests on, in words
export function confidenceLabel(confidence: string | null): string {
  switch (confidence) {
    case "exact":
      return "from the ToC";
    case "caught_up":
      return "caught up";
    case "lower_bound":
      return "at least";
    default:
      return "unconfirmed";
  }
}

/// The one line the edit panel shows about the site's own count
export function latestSummary(
  latest: number | null,
  confidence: string | null,
  seenAt: number | null
): string | null {
  if (latest === null) return null;

  const asOf = seenDate(seenAt) ? `as of ${seenDate(seenAt)}` : "never confirmed";
  const stale = isStale(seenAt) ? " · nothing has confirmed it in 30 days" : "";

  switch (confidence) {
    case "caught_up":
      return `Caught up — chapter ${latest} ${asOf}${stale}`;
    case "lower_bound":
      return `At least chapter ${latest} · ${asOf}${stale}`;
    case "exact":
      return `Chapter ${latest} ${asOf}, ${confidenceLabel(confidence)}${stale}`;
    default:
      return `Chapter ${latest} · ${asOf}${stale}`;
  }
}

/// 0–1 once a real chapter count is known, null otherwise — never estimated
export function progressPercent(current: number | null, total: number | null): number | null {
  if (current === null || total === null || total <= 0) return null;
  return Math.min(1, Math.max(0, current / total));
}
