import { useState, useEffect } from "react";
import AddNovelPanel from "./AddNovelPanel";
import EditNovelPanel, { type EditNovelData } from "./EditNovelPanel";
import StatsPanel from "./StatsPanel";
import { getAllNovels, addNovel, updateNovel, updateProgress, deleteNovel } from "./queries";
import { exportToFile } from "./queries";
import { CoverImage } from "./formComponents";
import { openUrl } from "@tauri-apps/plugin-opener";

// ── Types ────────────────────────────────────────────────────────────────────
type Status = "reading" | "paused" | "completed" | "dropped" | "planned";

interface Novel {
  id: number;
  canonical_title: string;
  status: Status;
  notes: string;
  cover_url: string | null;
  author: string | null;
  tags: string[];
  current_chapter_raw: string | null;
  chapter_sort: number | null;
  updated_at: string;
  aliases: string[];
  last_seen_url: string | null;
}

// The panel edits a snapshot of the row — SQL NULLs become empty fields
function toEditData(n: Novel): EditNovelData {
  return {
    ...n,
    author: n.author ?? "",
    tags: n.tags ?? [],
    current_chapter_raw: n.current_chapter_raw ?? "",
    cover_url: n.cover_url ?? "",
    last_seen_url: n.last_seen_url ?? "",
  };
}

// Tags captured from a page or typed by hand, capped so a card can't overflow
function TagChips({ tags, max = 3 }: { tags: string[]; max?: number }) {
  if (tags.length === 0) return null;

  const shown = tags.slice(0, max);
  const extra = tags.length - shown.length;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
      {shown.map((t) => <span key={t} style={styles.tagChip}>{t}</span>)}
      {extra > 0 && <span style={styles.tagChip}>+{extra}</span>}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const STATUS_META: Record<Status, { label: string; color: string }> = {
  reading:   { label: "Reading",   color: "#60a5fa" },
  paused:    { label: "Paused",    color: "#facc15" },
  completed: { label: "Completed", color: "#4ade80" },
  dropped:   { label: "Dropped",   color: "#f87171" },
  planned:   { label: "Planned",   color: "#a78bfa" },
};


type SortKey = "updated" | "title" | "chapter";
type ViewMode = "list" | "grid" | "compact";

// ── Dynamic Style Helpers ────────────────────────────────────────────────────
function getNavBtnStyle(active: boolean, hovered: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: active ? "#e8e6e1" : hovered ? "#9a9aa4" : "#555",
    padding: "6px 10px",
    fontSize: 13,
    fontFamily: "'Georgia', 'Times New Roman', serif",
    letterSpacing: "0.06em",
    cursor: "pointer",
    borderBottom: `1px solid ${active ? "#e8e6e1" : "transparent"}`,
    transition: "color 0.15s, border-color 0.15s",
  };
}

function getViewBtnStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "#2a2a35" : "transparent",
    border: "1px solid #2a2a35",
    color: active ? "#e8e6e1" : "#666",
    width: 32,
    height: 32,
    cursor: "pointer",
    fontSize: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  };
}

function getTrStyle(hovered: boolean): React.CSSProperties {
  return {
    borderBottom: "1px solid #1a1a22",
    background: hovered ? "#16161e" : "transparent",
    cursor: "pointer",
    transition: "background 0.1s",
  };
}

// The DB row is untyped at the boundary — an unrecognised status must not crash the view
function statusMeta(status: string): { label: string; color: string } {
  return (STATUS_META as Record<string, { label: string; color: string }>)[status]
    ?? { label: status || "Unknown", color: "#666" };
}

function getStatusBadgeStyle(status: Status): React.CSSProperties {
  const meta = statusMeta(status);
  return {
    display: "inline-block",
    fontSize: 11,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: meta.color,
    border: `1px solid ${meta.color}40`,
    padding: "2px 9px",
    background: `${meta.color}0f`,
    borderRadius: 20,
  };
}

function getGridCardStyle(hovered: boolean): React.CSSProperties {
  return {
    background: hovered ? "#16161e" : "#141418",
    border: "1px solid #222230",
    padding: 14,
    cursor: "pointer",
    transition: "background 0.15s, border-color 0.15s",
    borderColor: hovered ? "#2e2e3e" : "#222230",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    borderRadius: 12,
  };
}

// The card title doubles as the edit button, so it gets an affordance of its own
// on top of the card's highlight
function getGridTitleBtnStyle(hovered: boolean): React.CSSProperties {
  return {
    ...styles.gridTitleBtn,
    textDecoration: hovered ? "underline" : "none",
  };
}

// ── Inline Styles ────────────────────────────────────────────────────────────
// The add action lives on the library itself — one round button, always the
// same corner, out of the way of the toolbar
function getFabStyle(hovered: boolean): React.CSSProperties {
  return {
    position: "fixed",
    right: 32,
    bottom: 32,
    width: 52,
    height: 52,
    borderRadius: "50%",
    background: hovered ? "#ffffff" : "#e8e6e1",
    color: "#0f0f13",
    border: "none",
    fontSize: 24,
    fontWeight: 400,
    lineHeight: 1,
    paddingBottom: 2,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: hovered ? "0 8px 24px rgba(0,0,0,0.6)" : "0 4px 16px rgba(0,0,0,0.45)",
    transition: "background 0.15s, box-shadow 0.15s, transform 0.15s",
    transform: hovered ? "scale(1.05)" : "scale(1)",
    zIndex: 40,
  };
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    height: "100vh",
    background: "#0f0f13",
    color: "#e8e6e1",
    fontFamily: "'Georgia', 'Times New Roman', serif",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    borderBottom: "1px solid #2a2a35",
    padding: "18px 28px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    background: "#0f0f13",
    flexShrink: 0,
    zIndex: 10,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  nav: {
    display: "flex",
    gap: 4,
  },
  notice: {
    fontSize: 12,
    color: "#8a8a96",
    letterSpacing: "0.03em",
    maxWidth: 340,
    lineHeight: 1.35,
  },
  searchClear: {
    position: "absolute",
    right: 10,
    bottom: 9,
    background: "none",
    border: "none",
    color: "#555",
    cursor: "pointer",
    fontSize: 14,
    padding: 0,
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
  },
  toolbar: {
    padding: "14px 28px",
    display: "flex",
    alignItems: "flex-end",
    gap: 10,
    flexWrap: "wrap",
    borderBottom: "1px solid #1e1e28",
    flexShrink: 0,
  },
  searchWrap: {
    flex: 1,
    minWidth: 180,
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  searchInput: {
    width: "100%",
    background: "#1a1a22",
    border: "1px solid #2a2a35",
    color: "#e8e6e1",
    padding: "8px 10px 8px 34px",
    fontSize: 14,
    fontFamily: "inherit",
    boxSizing: "border-box",
    borderRadius: 8,
  },
  searchIcon: {
    position: "absolute",
    left: 10,
    bottom: 10,
    opacity: 0.35,
    pointerEvents: "none",
    fontSize: 14,
  },
  selectWrap: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  selectLabel: {
    fontSize: 9,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "#444",
    paddingLeft: 2,
  },
  select: {
    background: "#1a1a22",
    border: "1px solid #2a2a35",
    color: "#e8e6e1",
    padding: "8px 10px",
    fontSize: 13,
    fontFamily: "inherit",
    cursor: "pointer",
    letterSpacing: "0.03em",
    borderRadius: 8,
  },
  viewToggle: {
    display: "flex",
    gap: 4,
  },
  countBar: {
    padding: "10px 28px",
    fontSize: 12,
    letterSpacing: "0.1em",
    color: "#555",
    textTransform: "uppercase",
    fontVariantNumeric: "tabular-nums",
    borderBottom: "1px solid #1a1a22",
    flexShrink: 0,
  },
  main: {
    padding: "20px 28px 96px",
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden"
  },

  sourceCell: {
    fontSize: 12,
    whiteSpace: "nowrap" as const,
  },
  listCover: {
    width: 32,
    height: 48,
    background: "#1a1a22",
    border: "1px solid #1e1e28",
    borderRadius: 4,
    overflow: "hidden" as const,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  // ── List View ──
  listTable: {
    width: "100%",
    borderCollapse: "collapse",
  },
  th: {
    textAlign: "left",
    fontSize: 12,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "#444",
    padding: "0 12px 14px 0",
    fontWeight: 400,
    borderBottom: "1px solid #1e1e28",
  },
  td: {
    padding: "15px 12px 15px 0",
    fontSize: 15,
    verticalAlign: "middle",
  },
  titleCell: {
    fontWeight: 600,
    color: "#e8e6e1",
    maxWidth: 320,
  },
  aliasTag: {
    display: "inline-block",
    fontSize: 10,
    letterSpacing: "0.08em",
    color: "#555",
    background: "#1a1a22",
    border: "1px solid #252530",
    padding: "1px 6px",
    marginLeft: 8,
    borderRadius: 4,
  },
  authorLine: {
    fontSize: 12,
    fontStyle: "italic",
    color: "#6a6a76",
    marginTop: 3,
  },
  tagChip: {
    fontSize: 10,
    color: "#8a8a96",
    background: "#1a1a22",
    border: "1px solid #22222e",
    padding: "1px 6px",
    borderRadius: 4,
  },

  chapterCell: {
    color: "#999",
    fontSize: 14,
    fontFamily: "inherit",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  // ── Grid View ──
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
  },
  gridCover: {
    width: "100%",
    aspectRatio: "2/3",
    background: "#1a1a22",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
    fontSize: 11,
    color: "#333",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    border: "1px solid #1e1e28",
    borderRadius: 6,
    overflow: "hidden",
    position: "relative" as const,
  },
  gridTitleBtn: {
    // A real button wearing the title's clothes — resets every button default
    background: "none",
    border: "none",
    padding: 0,
    textAlign: "left" as const,
    fontFamily: "inherit",
    fontSize: 13,
    fontWeight: 700,
    color: "#ddd",
    lineHeight: 1.3,
    letterSpacing: "0.02em",
    cursor: "pointer",
  },
  gridMeta: {
    fontSize: 12,
    color: "#555",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: "auto",
  },
  compactGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: 6,
  },
  compactCard: {
    background: "#141418",
    border: "1px solid #1e1e28",
    padding: "8px 10px",
    borderRadius: 8,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  compactTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#ccc",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },

  // ── Quick Update Modal ──
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.75)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  modal: {
    background: "#16161e",
    border: "1px solid #2a2a35",
    padding: 26,
    width: 340,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    borderRadius: 14,
    overscrollBehavior: "contain",
  },
  modalTitle: {
    fontSize: 11,
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    color: "#555",
  },
  modalNovel: {
    fontSize: 17,
    fontWeight: 700,
    color: "#e8e6e1",
    lineHeight: 1.2,
    marginTop: 2,
  },
  modalCurrent: {
    fontSize: 12,
    color: "#555",
    letterSpacing: "0.04em",
    marginTop: 4,
  },
  modalInput: {
    background: "#0f0f13",
    border: "1px solid #2a2a35",
    color: "#e8e6e1",
    padding: "10px 12px",
    fontSize: 14,
    fontFamily: "inherit",
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 8,
  },
  modalActions: {
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
  },
  modalConfirm: {
    background: "#e8e6e1",
    color: "#0f0f13",
    border: "none",
    padding: "8px 20px",
    fontSize: 12,
    fontFamily: "inherit",
    fontWeight: 700,
    letterSpacing: "0.06em",
    cursor: "pointer",
    borderRadius: 20,
  },
  modalCancel: {
    background: "transparent",
    color: "#555",
    border: "1px solid #2a2a35",
    padding: "8px 20px",
    fontSize: 12,
    fontFamily: "inherit",
    letterSpacing: "0.06em",
    cursor: "pointer",
    borderRadius: 20,
  },
  emptyState: {
    textAlign: "center",
    padding: "60px 0",
    color: "#444",
    fontSize: 14,
    letterSpacing: "0.06em",
  },
  emptyHint: {
    maxWidth: 400,
    margin: "10px auto 0",
    fontSize: 12,
    lineHeight: 1.6,
    letterSpacing: "0.02em",
    color: "#3a3a45",
  },
};

// ── Update Button ─────────────────────────────────────────────────────────────
function NavButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={getNavBtnStyle(active, hovered)}
    >
      {label}
    </button>
  );
}

function UpdateButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        background: hovered ? "#60a5fa18" : "#1a1a22",
        border: `1px solid ${hovered ? "#60a5fa55" : "#2a2a35"}`,
        color: hovered ? "#60a5fa" : "#666",
        fontSize: 11,
        padding: "4px 10px",
        cursor: "pointer",
        fontFamily: "inherit",
        letterSpacing: "0.06em",
        borderRadius: 6,
        transition: "background 0.15s, border-color 0.15s, color 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      + Update
    </button>
  );
}

// ── Quick Update Modal ────────────────────────────────────────────────────────
function QuickUpdateModal({
  novel,
  onConfirm,
  onClose,
}: {
  novel: Novel;
  onConfirm: (id: number, chapter: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(novel.current_chapter_raw ?? "");

  // Escape has to close this even when focus has wandered off the input
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Update progress"
        style={styles.modal}
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <div style={styles.modalTitle}>Update Progress</div>
          <div style={styles.modalNovel}>{novel.canonical_title}</div>
          {novel.current_chapter_raw && (
            <div style={styles.modalCurrent}>
              Currently at {novel.current_chapter_raw}
            </div>
          )}
        </div>
        <input
          style={styles.modalInput}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. Chapter 222"
          aria-label="Current chapter"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm(novel.id, value);
          }}
        />
        <div style={styles.modalActions}>
          <button style={styles.modalCancel} onClick={onClose}>Cancel</button>
          <button style={styles.modalConfirm} onClick={() => onConfirm(novel.id, value)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── List Row ──────────────────────────────────────────────────────────────────
// ── Source Link ───────────────────────────────────────────────────────────────
// Opens in the OS browser — the app window must never navigate away from itself
function SourceLink({ url }: { url: string }) {
  const [hovered, setHovered] = useState(false);

  const host = (() => {
    try {
      return new URL(url).hostname.replace("www.", "");
    } catch {
      return url;
    }
  })();

  return (
    <a
      href={url}
      title={url}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openUrl(url).catch((err) => {
          console.error("openUrl failed:", err);
        });
      }}
      style={{
        color: hovered ? "#6f97d1" : "#4a6fa5",
        textDecoration: "none",
        fontSize: 12,
        fontStyle: "italic",
        cursor: "pointer",
        transition: "color 0.15s",
      }}
    >
      {host}
    </a>
  );
}

function ListRow({
  novel,
  onQuickUpdate,
  onClick,
}: {
  novel: Novel;
  onQuickUpdate: (novel: Novel) => void;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <tr
      style={getTrStyle(hovered)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      tabIndex={0}
      onKeyDown={(e) => {
        // Only when the row itself holds focus — Enter on the + Update button or
        // the source link inside must not also open the edit panel
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <td style={{ ...styles.td, ...styles.titleCell }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={styles.listCover}>
            <CoverImage url={novel.cover_url} alt="" placeholder={false} />
          </div>
          <div>
            {novel.canonical_title}
            {novel.aliases.length > 0 && (
              <span style={styles.aliasTag}>{novel.aliases[0]}</span>
            )}
            {novel.author && <div style={styles.authorLine}>{novel.author}</div>}
            <TagChips tags={novel.tags} />
          </div>
        </div>
      </td>
      <td style={styles.td}>
        <span style={getStatusBadgeStyle(novel.status)}>
          {statusMeta(novel.status).label}
        </span>
      </td>
      <td style={{ ...styles.td, ...styles.chapterCell }}>
        {novel.current_chapter_raw ?? <span style={{ color: "#333" }}>—</span>}
      </td>
      <td style={{ ...styles.td, ...styles.sourceCell }}>
        {novel.last_seen_url
          ? <SourceLink url={novel.last_seen_url} />
          : <span style={{ color: "#333" }}>—</span>
        }
      </td>
      <td style={styles.td}>
        <UpdateButton onClick={() => onQuickUpdate(novel)} />
      </td>
    </tr>
  );
}

// ── Grid Card ─────────────────────────────────────────────────────────────────
function GridCard({
  novel,
  onQuickUpdate,
  onClick,
}: {
  novel: Novel;
  onQuickUpdate: (novel: Novel) => void;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={getGridCardStyle(hovered)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      <div style={styles.gridCover}>
        <CoverImage url={novel.cover_url} alt="" />
      </div>
      {/* The title is the card's keyboard path — clicking the card is a mouse shortcut */}
      <button
        style={getGridTitleBtnStyle(hovered)}
        aria-label={`Edit ${novel.canonical_title}`}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {novel.canonical_title}
      </button>
      {novel.author && <div style={styles.authorLine}>{novel.author}</div>}
      <TagChips tags={novel.tags} />
      <span style={getStatusBadgeStyle(novel.status)}>
        {statusMeta(novel.status).label}
      </span>
      <div style={styles.gridMeta}>
        <span style={{ color: "#666", fontSize: 12 }}>
          {novel.current_chapter_raw ?? "Not started"}
        </span>
        <UpdateButton onClick={() => onQuickUpdate(novel)} />
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
// ── Add Button (floating) ─────────────────────────────────────────────────────
// The library's own action, parked in the corner instead of competing with the
// nav for header space
function AddButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      aria-label="Add novel"
      title="Add a novel"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={getFabStyle(hovered)}
    >
      +
    </button>
  );
}

export default function App() {
  const [novels, setNovels] = useState<Novel[]>([]);
  
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [quickUpdateTarget, setQuickUpdateTarget] = useState<Novel | null>(null);
  const [page, setPage] = useState<"library" | "stats">("library");
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditNovelData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  const filtered = novels
    .filter((n) => {
      if (statusFilter !== "all" && n.status !== statusFilter) return false;
      const q = search.trim().toLowerCase();
      if (q) {
        return (
          n.canonical_title.toLowerCase().includes(q) ||
          n.aliases.some((a) => a.toLowerCase().includes(q))
        );
      }
      return true;
    })
    .sort((a, b) => {
      if (sortKey === "updated")
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      if (sortKey === "title")
        return a.canonical_title.localeCompare(b.canonical_title);
      if (sortKey === "chapter")
        return (b.chapter_sort ?? -1) - (a.chapter_sort ?? -1);
      return 0;
    });

  useEffect(() => {
    // Initial load — a failure must not look like an empty library
    getAllNovels()
      .then((rows) => setNovels(rows as Novel[]))
      .catch((e: unknown) => {
        console.error("failed to load library:", e);
        setLoadError(e instanceof Error ? e.message : String(e));
      });

    // Poll for updates from extension every 5 seconds
    const interval = setInterval(async () => {
      // Only poll when window is visible
      if (document.visibilityState === "hidden") return;
      try {
        const updated = await getAllNovels();
        setNovels(updated as Novel[]);
        setLoadError(null); // keep showing real data if a poll fails
      } catch (e) {
        console.error("library refresh failed:", e);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, []);
  // Transient status line in the header. Every write path reports through this,
  // so a failed save never looks like a successful one.
  function notify(text: string, error = false) {
    setNotice({ text, error });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 5000);
  }

  // Export lives on the stats page — its outcome still reports through the header
  async function handleExport() {
    try {
      const saved = await exportToFile();
      notify(saved
        ? "Exported to file — novels, progress, aliases, sources, site links, reading log"
        : "Export cancelled — nothing was written");
    } catch (e) {
      console.error("export failed:", e);
      notify("Export failed — see the console for details", true);
    }
  }

  async function handleQuickUpdate(id: number, chapterRaw: string) {
    try {
      await updateProgress(id, chapterRaw);
      const updated = await getAllNovels();
      setNovels(updated as Novel[]);
      setQuickUpdateTarget(null);
    } catch (e) {
      // Leave the modal open so the typed chapter isn't lost
      console.error("progress update failed:", e);
      notify("Couldn't save that chapter — nothing was written.", true);
    }
  }

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <nav style={styles.nav}>
          <NavButton label="Library" active={page === "library"} onClick={() => setPage("library")} />
          <NavButton label="Stats" active={page === "stats"} onClick={() => setPage("stats")} />
        </nav>
        <div style={styles.headerRight}>
          {notice && (
            <span
              role="status"
              aria-live="polite"
              style={{ ...styles.notice, color: notice.error ? "#f87171" : "#8a8a96" }}
            >
              {notice.text}
            </span>
          )}
        </div>
      </header>

      {/* The panels sit outside the header — a dialog has no business inside a banner */}
      <AddNovelPanel
        open={addPanelOpen}
        onClose={() => setAddPanelOpen(false)}
        existingNovels={novels.map((n) => ({ id: n.id, title: n.canonical_title, aliases: n.aliases }))}
        onSubmit={async (data) => {
          try {
            await addNovel(data);
            const updated = await getAllNovels();
            setNovels(updated);
            notify(`Added ${data.canonical_title}`);
          } catch (e) {
            console.error("add failed:", e);
            notify("Couldn't add that novel — nothing was written.", true);
            throw e; // keep the panel open with the form intact
          }
        }}
      />
      <EditNovelPanel
        novel={editTarget}
        onClose={() => setEditTarget(null)}
        onSave={async (data: EditNovelData) => {
          // The panel edits a snapshot. If the extension wrote anything newer
          // while it was open, keep that instead of reverting it to stale data.
          try {
            const before = await getAllNovels();
            const live = before.find((n) => n.id === data.id) as Novel | undefined;
            const chapterUntouched = !editTarget
              || data.current_chapter_raw === editTarget.current_chapter_raw;
            const authorUntouched = !editTarget || data.author === editTarget.author;
            const tagsUntouched = !editTarget
              || JSON.stringify(data.tags) === JSON.stringify(editTarget.tags);

            const payload = {
              ...data,
              current_chapter_raw: chapterUntouched && live
                ? live.current_chapter_raw ?? ""
                : data.current_chapter_raw,
              author: authorUntouched && live ? live.author ?? "" : data.author,
              tags: tagsUntouched && live ? live.tags : data.tags,
            };

            await updateNovel(payload);
            const updated = await getAllNovels();
            setNovels(updated as Novel[]);
            setEditTarget(null);
            notify("Changes saved");
          } catch (e) {
            console.error("save failed:", e);
            notify("Couldn't save changes — nothing was written.", true);
            throw e; // leave the panel open so the edits aren't lost
          }
        }}
        onDelete={async (id: number) => {
          try {
            await deleteNovel(id);
            const updated = await getAllNovels();
            setNovels(updated as Novel[]);
            setEditTarget(null);
            notify("Removed from library");
          } catch (e) {
            console.error("delete failed:", e);
            notify("Couldn't remove that novel — nothing was deleted.", true);
            throw e;
          }
        }}
      />

      {page === "stats" && <StatsPanel onExport={handleExport} />}

      {page === "library" && <div style={styles.toolbar}>
        <div style={styles.searchWrap}>
          <span style={styles.searchIcon} aria-hidden="true">⌕</span>
          <input
            style={{
              ...styles.searchInput,
              paddingRight: search ? 32 : 10,  // make room for clear btn
            }}
            placeholder="Search titles, aliases…"
            aria-label="Search novels by title or alias"
            autoComplete="off"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              style={styles.searchClear}
              aria-label="Clear search"
              onClick={() => setSearch("")}
            >
              ×
            </button>
          )}
        </div>
        <div style={styles.selectWrap}>
          <label htmlFor="status-filter" style={styles.selectLabel}>Filter</label>
          <select
            id="status-filter"
            style={styles.select}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as Status | "all")}
          >
            <option value="all">All Status</option>
            {(Object.keys(STATUS_META) as Status[]).map((s) => (
              <option key={s} value={s}>{STATUS_META[s].label}</option>
            ))}
          </select>
        </div>
        <div style={styles.selectWrap}>
          <label htmlFor="sort-key" style={styles.selectLabel}>Sort</label>
          <select
            id="sort-key"
            style={styles.select}
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
          >
            <option value="updated">Last Updated</option>
            <option value="title">Title A–Z</option>
            <option value="chapter">Chapter</option>
          </select>
        </div>
        <div style={styles.viewToggle}>
          <button
            style={getViewBtnStyle(viewMode === "list")}
            aria-label="List view"
            aria-pressed={viewMode === "list"}
            title="List view"
            onClick={() => setViewMode("list")}
          >☰</button>
          <button
            style={getViewBtnStyle(viewMode === "grid")}
            aria-label="Grid view"
            aria-pressed={viewMode === "grid"}
            title="Grid view"
            onClick={() => setViewMode("grid")}
          >⊞</button>
          <button
            style={getViewBtnStyle(viewMode === "compact")}
            aria-label="Compact view"
            aria-pressed={viewMode === "compact"}
            title="Compact view"
            onClick={() => setViewMode("compact")}
          >▤</button>
          
        </div>
      </div>}

      {page === "library" && <div style={styles.countBar}>
        {filtered.length} {filtered.length === 1 ? "novel" : "novels"}
        {statusFilter !== "all" && ` · ${statusMeta(statusFilter).label}`}
        {search && ` · "${search}"`}
      </div>}

      {page === "library" && <main style={styles.main}>
        {loadError ? (
          <div style={{ ...styles.emptyState, color: "#f87171" }}>
            Couldn't load your library.
            <div style={{ fontSize: 12, color: "#8a5a5a", marginTop: 8, letterSpacing: 0 }}>
              {loadError}
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div style={styles.emptyState}>
            {novels.length === 0 ? "Your library is empty." : "No novels match those filters."}
            <div style={styles.emptyHint}>
              {novels.length === 0
                ? "Add the first one with the + button in the corner, or open a site you read on and let the extension catch it."
                : "Try a different search, or set the status filter back to All Status."}
            </div>
          </div>
        ) : viewMode === "list" ? (
          <table style={styles.listTable}>
            <thead>
              <tr>
                <th style={styles.th}>Title</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Chapter</th>
                <th style={styles.th}>Source</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((n) => (
                <ListRow 
                  key={n.id} 
                  novel={n} 
                  onQuickUpdate={setQuickUpdateTarget} 
                  onClick={() => setEditTarget(toEditData(n))}
                />
              ))}
            </tbody>
          </table>
        ) : viewMode === "compact" ? (
          <div style={styles.compactGrid}>
          {filtered.map((n) => (
            <div
              key={n.id}
              role="button"
              tabIndex={0}
              aria-label={`Edit ${n.canonical_title}`}
              style={styles.compactCard}
              onClick={() => setEditTarget(toEditData(n))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setEditTarget(toEditData(n));
                }
              }}
            >
              <div style={styles.compactTitle}>{n.canonical_title}</div>
              <span style={{ ...getStatusBadgeStyle(n.status), fontSize: 9, padding: "1px 6px" }}>
                {statusMeta(n.status).label}
              </span>
            </div>
          ))}
        </div>
        ) : (
          <div style={styles.grid}>
            {filtered.map((n) => (
              <GridCard
                key={n.id} 
                novel={n} 
                onQuickUpdate={setQuickUpdateTarget} 
                onClick={() => setEditTarget(toEditData(n))}
                />
            ))}
          </div>
        )}
      </main>}

      {page === "library" && <AddButton onClick={() => setAddPanelOpen(true)} />}

      {quickUpdateTarget && (
        <QuickUpdateModal
          novel={quickUpdateTarget}
          onConfirm={handleQuickUpdate}
          onClose={() => setQuickUpdateTarget(null)}
        />
      )}
    </div>
  );
}
