import { useState, useEffect } from "react";
import {
  type Status,
  FieldLabel, TextInput, TextArea,
  StatusPicker, AliasInput,
  PanelShell, PanelHeader, PanelFooter,
  BtnPrimary, BtnSecondary,
} from "./formComponents";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface NewNovelData {
  canonical_title: string;
  status: Status;
  current_chapter_raw: string;
  notes: string;
  cover_url: string;
  aliases: string[];
}

interface ExistingNovel {
  id: number;
  title: string;
  aliases: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: NewNovelData) => void;
  existingNovels: ExistingNovel[];
}

const EMPTY_FORM: NewNovelData = {
  canonical_title: "",
  status: "reading",
  current_chapter_raw: "",
  notes: "",
  cover_url: "",
  aliases: [],
};

// ── Fuzzy match ───────────────────────────────────────────────────────────────
// Normalise a string for comparison: lowercase, strip punctuation, collapse spaces
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

// Simple similarity ratio using longest common subsequence length
function similarity(a: string, b: string): number {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  // Count matching characters in order (cheap approximation)
  let matches = 0;
  let bi = 0;
  for (let ai = 0; ai < na.length && bi < nb.length; ai++) {
    if (na[ai] === nb[bi]) { matches++; bi++; }
  }
  return (matches * 2) / (na.length + nb.length);
}

function findDuplicates(title: string, existing: ExistingNovel[]): ExistingNovel[] {
  if (!title.trim()) return [];
  return existing.filter((n) => {
    // Check against canonical title
    if (similarity(title, n.title) >= 0.75) return true;
    // Check against all aliases
    if (n.aliases.some((a) => similarity(title, a) >= 0.75)) return true;
    return false;
  });
}

// ── Duplicate Warning ─────────────────────────────────────────────────────────
function DuplicateWarning({
  matches,
  onAddAnyway,
  onDismiss,
}: {
  matches: ExistingNovel[];
  onAddAnyway: () => void;
  onDismiss: () => void;
}) {
  return (
    <div style={{
      background: "#1a1410",
      border: "1px solid #f59e0b40",
      borderRadius: 8,
      padding: "12px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 10,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{ fontSize: 14, marginTop: 1 }}>⚠</span>
        <div>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            color: "#f59e0b",
            letterSpacing: "0.06em",
            marginBottom: 3,
          }}>
            Possible duplicate
          </div>
          <div style={{ fontSize: 12, color: "#888", lineHeight: 1.4 }}>
            {matches.length === 1
              ? "A similar novel is already in your library:"
              : "Similar novels are already in your library:"}
          </div>
        </div>
      </div>

      {/* Matched novels */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 24 }}>
        {matches.map((m) => (
          <div key={m.id} style={{
            fontSize: 12,
            color: "#bbb",
            fontStyle: "italic",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}>
            <span style={{ color: "#3a3a45", fontSize: 10 }}>—</span>
            {m.title}
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{
        display: "flex",
        gap: 8,
        paddingLeft: 24,
      }}>
        <button
          onClick={onDismiss}
          style={{
            background: "transparent",
            border: "1px solid #2a2a35",
            color: "#666",
            padding: "5px 12px",
            fontSize: 11,
            fontFamily: "'Georgia', 'Times New Roman', serif",
            borderRadius: 20,
            cursor: "pointer",
            letterSpacing: "0.04em",
          }}
        >
          Cancel
        </button>
        <button
          onClick={onAddAnyway}
          style={{
            background: "transparent",
            border: "1px solid #f59e0b40",
            color: "#f59e0b",
            padding: "5px 12px",
            fontSize: 11,
            fontFamily: "'Georgia', 'Times New Roman', serif",
            borderRadius: 20,
            cursor: "pointer",
            letterSpacing: "0.04em",
          }}
        >
          Add anyway
        </button>
      </div>
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────
export default function AddNovelPanel({ open, onClose, onSubmit, existingNovels }: Props) {
  const [form, setForm] = useState<NewNovelData>(EMPTY_FORM);
  const [errors, setErrors] = useState<{ title?: string }>({});
  const [visible, setVisible] = useState(false);
  const [duplicates, setDuplicates] = useState<ExistingNovel[]>([]);
  const [overrideDuplicate, setOverrideDuplicate] = useState(false);

  useEffect(() => {
    if (open) requestAnimationFrame(() => setVisible(true));
    else setVisible(false);
  }, [open]);

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setErrors({});
      setDuplicates([]);
      setOverrideDuplicate(false);
    }
  }, [open]);

  function set<K extends keyof NewNovelData>(key: K, value: NewNovelData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key === "canonical_title") {
      setErrors({});
      // Clear duplicate warning while typing
      setDuplicates([]);
      setOverrideDuplicate(false);
    }
  }

  // Check for duplicates when user leaves the title field
  function handleTitleBlur() {
    if (!overrideDuplicate && form.canonical_title.trim()) {
      const found = findDuplicates(form.canonical_title, existingNovels);
      setDuplicates(found);
    }
  }

  function handleSubmit() {
    if (!form.canonical_title.trim()) {
      setErrors({ title: "Title is required" });
      return;
    }

    // If duplicates found and not yet overridden, show warning instead of submitting
    if (duplicates.length > 0 && !overrideDuplicate) {
      return;
    }

    onSubmit({
      ...form,
      canonical_title: form.canonical_title.trim(),
      current_chapter_raw: form.current_chapter_raw.trim(),
      cover_url: form.cover_url.trim(),
      notes: form.notes.trim(),
    });
    onClose();
  }

  if (!open && !visible) return null;

  return (
    <PanelShell visible={visible} onClose={onClose}>
      <PanelHeader eyebrow="Library" title="Add Novel" onClose={onClose} />

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
            onBlur={handleTitleBlur}
            placeholder="e.g. The Beginning After The End"
            autoFocus
          />
          {errors.title && (
            <div style={{ fontSize: 11, color: "#f87171", marginTop: 5, paddingLeft: 2 }}>
              {errors.title}
            </div>
          )}

          {/* Duplicate warning — appears below title field */}
          {duplicates.length > 0 && !overrideDuplicate && (
            <div style={{ marginTop: 10 }}>
              <DuplicateWarning
                matches={duplicates}
                onAddAnyway={() => setOverrideDuplicate(true)}
                onDismiss={() => {
                  setDuplicates([]);
                  setForm((prev) => ({ ...prev, canonical_title: "" }));
                }}
              />
            </div>
          )}
        </div>

        {/* Status */}
        <div>
          <FieldLabel text="Status" required />
          <StatusPicker value={form.status} onChange={(v) => set("status", v)} />
        </div>

        {/* Chapter */}
        <div>
          <FieldLabel text="Current Chapter" />
          <TextInput
            value={form.current_chapter_raw}
            onChange={(v) => set("current_chapter_raw", v)}
            placeholder="e.g. Chapter 221, Vol 2 Ch 4"
          />
          <div style={{ fontSize: 10, color: "#3a3a45", marginTop: 5, paddingLeft: 1 }}>
            Leave blank if not started yet.
          </div>
        </div>

        {/* Aliases */}
        <div>
          <FieldLabel text="Aliases" />
          <AliasInput aliases={form.aliases} onChange={(v) => set("aliases", v)} />
        </div>

        {/* Cover URL */}
        <div>
          <FieldLabel text="Cover Image URL" />
          <TextInput
            value={form.cover_url}
            onChange={(v) => set("cover_url", v)}
            placeholder="https://..."
          />
        </div>

        {/* Notes */}
        <div>
          <FieldLabel text="Notes" />
          <TextArea
            value={form.notes}
            onChange={(v) => set("notes", v)}
            placeholder="Anything you want to remember about this novel..."
            rows={3}
          />
        </div>

      </div>

      <PanelFooter>
        <BtnSecondary label="Cancel" onClick={onClose} />
        <BtnPrimary label="Add to Library" onClick={handleSubmit} />
      </PanelFooter>
    </PanelShell>
  );
}