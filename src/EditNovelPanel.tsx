import { useState, useEffect } from "react";
import { getTagVocabulary } from "./queries";
import { getNovelHistory, type HistoryEntry, type NovelHistory } from "./stats";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type Status,
  FieldLabel,
  TextInput,
  TextArea,
  StatusPicker,
  RatingPicker,
  ReasonPicker,
  ChipInput,
  CoverImage,
  PanelShell,
  PanelHeader,
  PanelFooter,
  BtnPrimary,
  BtnSecondary,
  BtnDanger,
  FONT,
} from "./formComponents";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface EditNovelData {
  id: number;
  canonical_title: string;
  status: Status;
  author: string;
  current_chapter_raw: string;
  notes: string;
  cover_url: string;
  aliases: string[];
  tags: string[];
  rating: number | null;
  drop_reason: string;
  updated_at: string;
  last_seen_url: string;
}

interface Props {
  novel: EditNovelData | null; // null = closed
  onClose: () => void;
  onSave: (data: EditNovelData) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}
// ── Delete Confirmation ───────────────────────────────────────────────────────
function DeleteConfirm({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{
      position: "absolute",
      inset: 0,
      background: "#13131a",
      zIndex: 10,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: 40,
      gap: 20,
    }}>
      <div style={{
        width: 48,
        height: 48,
        borderRadius: "50%",
        background: "#f8717115",
        border: "1px solid #f8717140",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 22,
      }}>
        ⚠
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{
          fontSize: 16,
          fontWeight: 700,
          fontStyle: "italic",
          color: "#e8e6e1",
          marginBottom: 8,
        }}>
          Remove from library?
        </div>
        <div style={{
          fontSize: 13,
          color: "#555",
          lineHeight: 1.5,
          maxWidth: 280,
        }}>
          <span style={{ color: "#aaa" }}>{title}</span> and all its progress
          and sources will be permanently deleted.
        </div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={onCancel}
          style={{
            background: "transparent",
            border: "1px solid #2a2a35",
            color: "#666",
            padding: "9px 20px",
            fontSize: 12,
            fontFamily: FONT,
            borderRadius: 20,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          style={{
            background: "#f87171",
            border: "none",
            color: "#0f0f13",
            padding: "9px 22px",
            fontSize: 12,
            fontFamily: FONT,
            fontWeight: 700,
            borderRadius: 20,
            cursor: "pointer",
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ── Small text button (panel actions that sit next to a field label) ──────────
function MiniBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: "transparent",
        border: `1px solid ${hovered ? "#3a3a50" : "#252530"}`,
        color: hovered ? "#bbb" : "#777",
        borderRadius: 6,
        padding: "3px 9px",
        fontSize: 10,
        letterSpacing: "0.06em",
        fontFamily: FONT,
        cursor: "pointer",
        transition: "border-color 0.15s, color 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

// ── Reading history ───────────────────────────────────────────────────────────
const ACTION_LABELS: Record<string, string> = {
  started: "Started reading",
  progressed: "Progressed",
  completed: "Completed",
  dropped: "Dropped",
  paused: "Paused",
};

function historyLine(entry: HistoryEntry): string {
  const action = ACTION_LABELS[entry.action] ?? entry.action;
  return entry.chapter === null ? action : `${action} — chapter ${entry.chapter}`;
}

// ── Main Panel ────────────────────────────────────────────────────────────────
export default function EditNovelPanel({ novel, onClose, onSave, onDelete }: Props) {
  const [form, setForm] = useState<EditNovelData | null>(null);
  const [errors, setErrors] = useState<{ title?: string }>({});
  const [visible, setVisible] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [history, setHistory] = useState<NovelHistory | null>(null);

  // Animate open/close
  useEffect(() => {
    if (novel) {
      setForm({ ...novel });
      setErrors({});
      setDirty(false);
      setConfirmDelete(false);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [novel]);

  // Tag suggestions come from the NovelUpdates vocabulary the extension captures
  useEffect(() => {
    if (!novel) return;
    getTagVocabulary()
      .then(setVocabulary)
      .catch((e: unknown) => console.error("tag vocabulary load failed:", e));
  }, [novel]);

  // This novel's own log, so the panel shows the numbers the charts counted
  useEffect(() => {
    if (!novel) return;
    setHistory(null);
    getNovelHistory(novel.id)
      .then(setHistory)
      .catch((e: unknown) => console.error("history load failed:", e));
  }, [novel]);

  function set<K extends keyof EditNovelData>(key: K, value: EditNovelData[K]) {
    setForm((prev) => prev ? { ...prev, [key]: value } : prev);
    setDirty(true);
    if (key === "canonical_title") setErrors({});
  }

  async function handleSave() {
    if (!form) return;
    if (!form.canonical_title.trim()) {
      setErrors({ title: "Title is required" });
      return;
    }
    try {
      await onSave({
        ...form,
        canonical_title: form.canonical_title.trim(),
        author: form.author.trim(),
        current_chapter_raw: form.current_chapter_raw.trim(),
        cover_url: form.cover_url.trim(),
        notes: form.notes.trim(),
        drop_reason: form.drop_reason.trim(),
        last_seen_url: form.last_seen_url.trim(),
        updated_at: new Date().toISOString(),
      });
      onClose();
    } catch {
      // The app already reported the failure — stay open with the edits intact
    }
  }

  async function handleDelete() {
    if (!form) return;
    try {
      await onDelete(form.id);
      onClose();
    } catch {
      // Nothing was deleted; keep the panel so it can be retried
    }
  }

  const open = novel !== null;
  if (!open && !visible) return null;

  return (
    <PanelShell visible={visible} onClose={onClose} label="Edit novel" closeOnEscape={!dirty}>
      {/* Delete confirmation overlay — sits inside the panel */}
      {confirmDelete && form && (
        <DeleteConfirm
          title={form.canonical_title}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      <PanelHeader
        eyebrow="Editing"
        title={form?.canonical_title ?? ""}
        onClose={onClose}
      />

      {/* Meta row — last updated */}
      {form && (
        <div style={{
          padding: "10px 24px",
          borderBottom: "1px solid #1a1a22",
          fontSize: 11,
          color: "#3a3a45",
          letterSpacing: "0.05em",
          flexShrink: 0,
        }}>
          Last updated {new Date(form.updated_at).toLocaleDateString("en-AU", {
            day: "numeric", month: "short", year: "numeric",
          })}
        </div>
      )}

      {/* Form body */}
      {form && (
        <div style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}>

          {/* Title */}
          <div>
            <FieldLabel text="Title" required />
            <TextInput
              value={form.canonical_title}
              onChange={(v) => set("canonical_title", v)}
              placeholder="Novel title"
              autoFocus
            />
            {errors.title && (
              <div style={{ fontSize: 11, color: "#f87171", marginTop: 5, paddingLeft: 2 }}>
                {errors.title}
              </div>
            )}
          </div>

          {/* Author */}
          <div>
            <FieldLabel text="Author" />
            <TextInput
              value={form.author}
              onChange={(v) => set("author", v)}
              placeholder="e.g. Guiltythree"
            />
            <div style={{ fontSize: 10, color: "#3a3a45", marginTop: 5, paddingLeft: 1 }}>
              Filled in automatically when you visit the novel's page. Editing it here wins.
            </div>
          </div>

          {/* Status */}
          <div>
            <FieldLabel text="Status" />
            <StatusPicker value={form.status} onChange={(v) => set("status", v)} />
          </div>

          {/* Rating — what the tag table averages on the stats page */}
          <div>
            <FieldLabel text="Rating" />
            <RatingPicker value={form.rating} onChange={(v) => set("rating", v)} />
          </div>

          {/* Only a dropped novel has a reason to give — and it is what the
              drop-reasons chart groups on, so the set is fixed */}
          {form.status === "dropped" && (
            <div>
              <FieldLabel text="Reason for dropping" />
              <ReasonPicker value={form.drop_reason} onChange={(v) => set("drop_reason", v)} />
              <div style={{ fontSize: 10, color: "#3a3a45", marginTop: 5, paddingLeft: 1 }}>
                Optional. Groups the stats page by why, not just where you stopped.
              </div>
            </div>
          )}

          {/* Chapter */}
          <div>
            <FieldLabel text="Current Chapter" />
            <TextInput
              value={form.current_chapter_raw}
              onChange={(v) => set("current_chapter_raw", v)}
              placeholder="e.g. Chapter 221, Vol 2 Ch 4"
            />
          </div>

          {/* Aliases */}
          <div>
            <FieldLabel text="Aliases" />
            <ChipInput
              values={form.aliases}
              onChange={(v) => set("aliases", v)}
              placeholder="e.g. TBATE, The Beginning…"
              hint="Press Enter or comma to add. Searched alongside the main title."
            />
          </div>

          {/* Tags */}
          <div>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}>
              <FieldLabel text="Tags" />
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <MiniBtn
                  label="Find on NU"
                  title="Opens NovelUpdates with this title in its search box — press Enter there, pick the right series, and its tags come back"
                  onClick={() => {
                    // Title only: NU's search is title-oriented, and a title plus
                    // author narrows it to nothing. The query rides in the fragment
                    // (never sent to NU) so the extension can run the site's own
                    // search for it.
                    const query = form.canonical_title.trim();
                    openUrl(`https://www.novelupdates.com/#noveltrackr=${encodeURIComponent(query)}`)
                      .catch((e: unknown) => console.error("could not open NovelUpdates:", e));
                  }}
                />
              </div>
            </div>
            <ChipInput
              values={form.tags}
              onChange={(v) => set("tags", v)}
              placeholder="e.g. LitRPG, Progression Fantasy"
              suggestions={vocabulary}
              hint={vocabulary.length > 0
                ? `Captured from the site you read on, or added here. ${vocabulary.length} tags known — start typing for suggestions.`
                : "Captured from the site you read on, or added here. Visiting a NovelUpdates series page or using “Find on NU” teaches the app its tag names."}
            />
          </div>

          {/* Cover URL */}
          <div>
            <FieldLabel text="Cover Image URL" />

            {form.cover_url && (
              <div style={{
                width: 80,
                height: 120,
                marginBottom: 10,
                borderRadius: 6,
                overflow: "hidden",
                border: "1px solid #2a2a35",
                background: "#1a1a22",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}>
                <CoverImage url={form.cover_url} alt="Cover preview" />
              </div>
            )}

            <TextInput
              value={form.cover_url}
              onChange={(v) => set("cover_url", v)}
              placeholder="https://…"
            />
            <div style={{ fontSize: 10, color: "#3a3a45", marginTop: 5, paddingLeft: 1 }}>
              Paste any image URL. Right-click a cover → Copy image address.
            </div>
          </div>

          {/* Source URL */}
          <div>
            <FieldLabel text="Source URL" />
            <TextInput
              value={form.last_seen_url}
              onChange={(v) => set("last_seen_url", v)}
              placeholder="https://…"
            />
            <div style={{ fontSize: 10, color: "#3a3a45", marginTop: 5, paddingLeft: 1 }}>
              The website where you read this novel. Updated automatically by the extension.
            </div>
          </div>

          {/* Notes */}
          <div>
            <FieldLabel text="Notes" />
            <TextArea
              value={form.notes}
              onChange={(v) => set("notes", v)}
              placeholder="Anything you want to remember…"
              rows={4}
            />
          </div>

          {/* History — this novel's own log, read back. The chapters column is
              how far each entry moved, so a jump shows what it was worth */}
          {history && history.entries.length > 0 && (
            <div>
              <FieldLabel text="History" />
              <div style={{ fontSize: 10, color: "#3a3a45", marginBottom: 8, paddingLeft: 1 }}>
                {history.entries.length} {history.entries.length === 1 ? "entry" : "entries"} in the log
                {history.chapters_30d > 0 && ` · ${history.chapters_30d} chapters in the last 30 days`}
              </div>
              <div
                aria-label="Reading history"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  maxHeight: 220,
                  overflowY: "auto",
                  border: "1px solid #1e1e28",
                  borderRadius: 8,
                  padding: "10px 12px",
                  background: "#141418",
                }}
              >
                {history.entries.map((entry, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 12 }}>
                    <span style={{ width: 74, color: "#555", fontVariantNumeric: "tabular-nums" }}>
                      {entry.at}
                    </span>
                    <span style={{ flex: 1, color: "#9a9a9a" }}>{historyLine(entry)}</span>
                    {entry.gained > 0 && (
                      <span style={{ color: "#60a5fa", fontVariantNumeric: "tabular-nums" }}>
                        +{entry.gained}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      )}

      <PanelFooter>
        <BtnDanger label="Delete" onClick={() => setConfirmDelete(true)} />
        <BtnSecondary label="Cancel" onClick={onClose} />
        <BtnPrimary label={dirty ? "Save Changes" : "Done"} onClick={dirty ? handleSave : onClose} />
      </PanelFooter>
    </PanelShell>
  );
}