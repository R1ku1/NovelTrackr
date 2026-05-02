import { useState, useEffect } from "react";
import {
  type Status,
  FieldLabel,
  TextInput,
  TextArea,
  StatusPicker,
  AliasInput,
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
  current_chapter_raw: string;
  notes: string;
  cover_url: string;
  aliases: string[];
  updated_at: string;
}

interface Props {
  novel: EditNovelData | null; // null = closed
  onClose: () => void;
  onSave: (data: EditNovelData) => void;
  onDelete: (id: number) => void;
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

// ── Main Panel ────────────────────────────────────────────────────────────────
export default function EditNovelPanel({ novel, onClose, onSave, onDelete }: Props) {
  const [form, setForm] = useState<EditNovelData | null>(null);
  const [errors, setErrors] = useState<{ title?: string }>({});
  const [visible, setVisible] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dirty, setDirty] = useState(false);

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

  function set<K extends keyof EditNovelData>(key: K, value: EditNovelData[K]) {
    setForm((prev) => prev ? { ...prev, [key]: value } : prev);
    setDirty(true);
    if (key === "canonical_title") setErrors({});
  }

  function handleSave() {
    if (!form) return;
    if (!form.canonical_title.trim()) {
      setErrors({ title: "Title is required" });
      return;
    }
    onSave({
      ...form,
      canonical_title: form.canonical_title.trim(),
      current_chapter_raw: form.current_chapter_raw.trim(),
      cover_url: form.cover_url.trim(),
      notes: form.notes.trim(),
      updated_at: new Date().toISOString(),
    });
    onClose();
  }

  function handleDelete() {
    if (!form) return;
    onDelete(form.id);
    onClose();
  }

  const open = novel !== null;
  if (!open && !visible) return null;

  return (
    <PanelShell visible={visible} onClose={onClose}>
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

          {/* Status */}
          <div>
            <FieldLabel text="Status" />
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
          </div>

          {/* Aliases */}
          <div>
            <FieldLabel text="Aliases" />
            <AliasInput
              aliases={form.aliases}
              onChange={(v) => set("aliases", v)}
            />
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
              placeholder="Anything you want to remember..."
              rows={4}
            />
          </div>

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