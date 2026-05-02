import { useState, useEffect } from "react";
import AddNovelPanel from "./AddNovelPanel";
import EditNovelPanel, { type EditNovelData } from "./EditNovelPanel";
import { getAllNovels, addNovel, updateNovel, updateProgress, deleteNovel } from "./queries";
import { exportToFile } from "./queries";


// ── Types ────────────────────────────────────────────────────────────────────
type Status = "reading" | "paused" | "completed" | "dropped" | "planned";

interface Novel {
  id: number;
  canonical_title: string;
  status: Status;
  notes: string;
  cover_url: string | null;
  current_chapter_raw: string | null;
  chapter_sort: number | null;
  updated_at: string;
  aliases: string[];
  last_seen_url: string | null;
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

function getStatusBadgeStyle(status: Status): React.CSSProperties {
  return {
    display: "inline-block",
    fontSize: 11,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: STATUS_META[status].color,
    border: `1px solid ${STATUS_META[status].color}40`,
    padding: "2px 9px",
    background: `${STATUS_META[status].color}0f`,
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

// ── Inline Styles ────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  app: {
    height: "100vh",
    background: "#0f0f13",
    color: "#e8e6e1",
    fontFamily: "'Georgia', 'Times New Roman', serif",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    borderBottom: "1px solid #2a2a35",
    padding: "18px 28px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    background: "#0f0f13",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  logo: {
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: "0.06em",
    fontStyle: "italic",
    color: "#e8e6e1",
    opacity: 0.92,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  addBtn: {
    background: "#e8e6e1",
    color: "#0f0f13",
    border: "none",
    padding: "8px 18px",
    fontSize: 13,
    fontFamily: "inherit",
    fontWeight: 700,
    letterSpacing: "0.06em",
    cursor: "pointer",
    borderRadius: 20,
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
    outline: "none",
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
    outline: "none",
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
    borderBottom: "1px solid #1a1a22",
  },
  main: {
    padding: "20px 28px",
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden"
  },

  sourceCell: {
    fontSize: 12,
    whiteSpace: "nowrap" as const,
  },
  sourceLink: {
    color: "#4a6fa5",
    textDecoration: "none",
    fontSize: 12,
    fontStyle: "italic",
    cursor: "pointer",
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
  chapterCell: {
    color: "#999",
    fontSize: 14,
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  dateCell: {
    color: "#444",
    fontSize: 12,
    letterSpacing: "0.05em",
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
  },
  gridTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "#ddd",
    lineHeight: 1.3,
    letterSpacing: "0.02em",
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
    outline: "none",
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
};

// ── Update Button ─────────────────────────────────────────────────────────────
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
        transition: "all 0.15s",
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

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
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
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm(novel.id, value);
            if (e.key === "Escape") onClose();
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
    >
      <td style={{ ...styles.td, ...styles.titleCell }}>
        {novel.canonical_title}
        {novel.aliases.length > 0 && (
          <span style={styles.aliasTag}>{novel.aliases[0]}</span>
        )}
      </td>
      <td style={styles.td}>
        <span style={getStatusBadgeStyle(novel.status)}>
          {STATUS_META[novel.status].label}
        </span>
      </td>
      <td style={{ ...styles.td, ...styles.chapterCell }}>
        {novel.current_chapter_raw ?? <span style={{ color: "#333" }}>—</span>}
      </td>
      <td style={{ ...styles.td, ...styles.sourceCell }}>
        {novel.last_seen_url ? (
            <a
            href="#"
            style={styles.sourceLink}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.open(novel.last_seen_url!, "_blank");
            }}
          >
            {new URL(novel.last_seen_url).hostname.replace("www.", "")}
          </a>
        ) : (
          <span style={{ color: "#333" }}>—</span>
        )}
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
      <div style={styles.gridCover}>No Cover</div>
      <div style={styles.gridTitle}>{novel.canonical_title}</div>
      <span style={getStatusBadgeStyle(novel.status)}>
        {STATUS_META[novel.status].label}
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
export default function App() {
  const [novels, setNovels] = useState<Novel[]>([]);
  
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [quickUpdateTarget, setQuickUpdateTarget] = useState<Novel | null>(null);
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditNovelData | null>(null);

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
    getAllNovels().then(setNovels);
  }, []);
  async function handleQuickUpdate(id: number, chapterRaw: string) {
  await updateProgress(id, chapterRaw);
  const updated = await getAllNovels();
  setNovels(updated as Novel[]);
  setQuickUpdateTarget(null);
}

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <span style={styles.logo}>Noveltrackr</span>
        <div style={styles.headerRight}>
          <button style={styles.addBtn} onClick={() => setAddPanelOpen(true)}>
            + Add Novel
          </button>
        <button style={styles.addBtn} onClick={async () => {
  try {
    const saved = await exportToFile();
    if (saved) console.log("exported successfully");
    else console.log("user cancelled");
  } catch (e) {
    console.error("export failed:", e);
  }
}}>
  Export
</button>
          <AddNovelPanel
            open={addPanelOpen}
            onClose={() => setAddPanelOpen(false)}
            existingNovels={novels.map((n) => ({ id: n.id, title: n.canonical_title, aliases: n.aliases }))}
            onSubmit={async (data) => {
              await addNovel(data);
              const updated = await getAllNovels();
              setNovels(updated);
            }}
          />
          <EditNovelPanel
            novel={editTarget}
            onClose={() => setEditTarget(null)}
            onSave={async (data: EditNovelData) => {
              await updateNovel(data);
              const updated = await getAllNovels();
              setNovels(updated as Novel[]);
              setEditTarget(null);
            }}
            onDelete={async (id: number) => {
                await deleteNovel(id);
                const updated = await getAllNovels();
                setNovels(updated as Novel[]);
                setEditTarget(null);
            }}
          />
        </div>
      </header>

      <div style={styles.toolbar}>
        <div style={styles.searchWrap}>
          <span style={styles.searchIcon}>⌕</span>
          <input
            style={{
              ...styles.searchInput,
              paddingRight: search ? 32 : 10,  // make room for clear btn
            }}
            placeholder="Search titles, aliases..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              style={styles.searchClear}
              onClick={() => setSearch("")}
            >
              ×
            </button>
          )}
        </div>
        <div style={styles.selectWrap}>
          <span style={styles.selectLabel}>Filter</span>
          <select
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
          <span style={styles.selectLabel}>Sort</span>
          <select
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
          <button style={getViewBtnStyle(viewMode === "list")} onClick={() => setViewMode("list")}>☰</button>
          <button style={getViewBtnStyle(viewMode === "grid")} onClick={() => setViewMode("grid")}>⊞</button>
          <button style={getViewBtnStyle(viewMode === "compact")} onClick={() => setViewMode("compact")}>▤</button>
          
        </div>
      </div>

      <div style={styles.countBar}>
        {filtered.length} {filtered.length === 1 ? "novel" : "novels"}
        {statusFilter !== "all" && ` · ${STATUS_META[statusFilter].label}`}
        {search && ` · "${search}"`}
      </div>

      <main style={styles.main}>
        {filtered.length === 0 ? (
          <div style={styles.emptyState}>No novels found.</div>
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
                  onClick={() => setEditTarget({
                    ...n,
                    current_chapter_raw: n.current_chapter_raw ?? "",
                    cover_url: n.cover_url ?? "",
                    })}
                />
              ))}
            </tbody>
          </table>
        ) : viewMode === "compact" ? (
          <div style={styles.compactGrid}>
          {filtered.map((n) => (
            <div
              key={n.id}
              style={styles.compactCard}
              onClick={() => setEditTarget({
                ...n,
                current_chapter_raw: n.current_chapter_raw ?? "",
                cover_url: n.cover_url ?? "",
              })}
            >
              <div style={styles.compactTitle}>{n.canonical_title}</div>
              <span style={{ ...getStatusBadgeStyle(n.status), fontSize: 9, padding: "1px 6px" }}>
                {STATUS_META[n.status].label}
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
                onClick={() => setEditTarget({
                  ...n,
                  current_chapter_raw: n.current_chapter_raw ?? "",
                  cover_url: n.cover_url ?? "",
                  })}
                />
            ))}
          </div>
        )}
      </main>

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
