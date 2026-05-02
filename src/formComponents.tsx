import { useState, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
export type Status = "reading" | "paused" | "completed" | "dropped" | "planned";

export const STATUS_OPTIONS: { value: Status; label: string; color: string }[] = [
  { value: "reading",   label: "Reading",   color: "#60a5fa" },
  { value: "planned",   label: "Planned",   color: "#a78bfa" },
  { value: "paused",    label: "Paused",    color: "#facc15" },
  { value: "completed", label: "Completed", color: "#4ade80" },
  { value: "dropped",   label: "Dropped",   color: "#f87171" },
];

export const FONT = "'Georgia', 'Times New Roman', serif";

// ── Field Label ───────────────────────────────────────────────────────────────
export function FieldLabel({ text, required }: { text: string; required?: boolean }) {
  return (
    <div style={{
      fontSize: 9,
      letterSpacing: "0.16em",
      textTransform: "uppercase",
      color: "#555",
      marginBottom: 6,
      paddingLeft: 1,
    }}>
      {text}
      {required && <span style={{ color: "#f87171", marginLeft: 3 }}>*</span>}
    </div>
  );
}

// ── Text Input ────────────────────────────────────────────────────────────────
export function TextInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onBlur?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      style={{
        width: "100%",
        background: "#0f0f13",
        border: `1px solid ${focused ? "#3a3a50" : "#22222e"}`,
        borderRadius: 8,
        color: "#e8e6e1",
        padding: "9px 12px",
        fontSize: 14,
        fontFamily: FONT,
        outline: "none",
        boxSizing: "border-box",
        transition: "border-color 0.15s",
      }}
    />
  );
}

// ── Textarea ──────────────────────────────────────────────────────────────────
export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: "100%",
        background: "#0f0f13",
        border: `1px solid ${focused ? "#3a3a50" : "#22222e"}`,
        borderRadius: 8,
        color: "#e8e6e1",
        padding: "9px 12px",
        fontSize: 13,
        fontFamily: FONT,
        outline: "none",
        boxSizing: "border-box",
        resize: "vertical",
        lineHeight: 1.5,
        transition: "border-color 0.15s",
      }}
    />
  );
}

// ── Status Picker ─────────────────────────────────────────────────────────────
export function StatusPicker({
  value,
  onChange,
}: {
  value: Status;
  onChange: (v: Status) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {STATUS_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              background: active ? `${opt.color}15` : "transparent",
              border: `1px solid ${active ? opt.color + "60" : "#22222e"}`,
              color: active ? opt.color : "#555",
              borderRadius: 20,
              padding: "5px 14px",
              fontSize: 11,
              letterSpacing: "0.06em",
              cursor: "pointer",
              fontFamily: FONT,
              transition: "all 0.15s",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Alias Input ───────────────────────────────────────────────────────────────
export function AliasInput({
  aliases,
  onChange,
}: {
  aliases: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  function addAlias() {
    const trimmed = draft.trim();
    if (!trimmed || aliases.includes(trimmed)) { setDraft(""); return; }
    onChange([...aliases, trimmed]);
    setDraft("");
  }

  function removeAlias(i: number) {
    onChange(aliases.filter((_, idx) => idx !== i));
  }

  return (
    <div>
      {aliases.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {aliases.map((a, i) => (
            <span
              key={i}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: "#1a1a22",
                border: "1px solid #2a2a35",
                color: "#aaa",
                borderRadius: 6,
                padding: "2px 8px",
                fontSize: 12,
              }}
            >
              {a}
              <button
                onClick={() => removeAlias(i)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#555",
                  cursor: "pointer",
                  padding: 0,
                  fontSize: 13,
                  lineHeight: 1,
                  fontFamily: "inherit",
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="e.g. TBATE, The Beginning..."
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); addAlias(); }
            if (e.key === ",")     { e.preventDefault(); addAlias(); }
          }}
          style={{
            flex: 1,
            background: "#0f0f13",
            border: `1px solid ${focused ? "#3a3a50" : "#22222e"}`,
            borderRadius: 8,
            color: "#e8e6e1",
            padding: "8px 12px",
            fontSize: 13,
            fontFamily: FONT,
            outline: "none",
            transition: "border-color 0.15s",
          }}
        />
        <button
          onClick={addAlias}
          style={{
            background: "#1a1a22",
            border: "1px solid #2a2a35",
            color: "#888",
            borderRadius: 8,
            padding: "8px 14px",
            fontSize: 12,
            cursor: "pointer",
            fontFamily: FONT,
            whiteSpace: "nowrap",
          }}
        >
          Add
        </button>
      </div>
      <div style={{ fontSize: 10, color: "#3a3a45", marginTop: 5, paddingLeft: 1 }}>
        Press Enter or comma to add. Searched alongside the main title.
      </div>
    </div>
  );
}

// ── Panel Shell (shared wrapper) ──────────────────────────────────────────────
export function PanelShell({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          zIndex: 50,
          opacity: visible ? 1 : 0,
          transition: "opacity 0.2s ease",
          pointerEvents: visible ? "auto" : "none",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          height: "100%",
          width: 420,
          background: "#13131a",
          borderLeft: "1px solid #2a2a35",
          zIndex: 60,
          display: "flex",
          flexDirection: "column",
          transform: visible ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)",
        }}
      >
        {children}
      </div>
    </>
  );
}

// ── Panel Header ──────────────────────────────────────────────────────────────
export function PanelHeader({
  eyebrow,
  title,
  onClose,
  actions,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div style={{
      padding: "20px 24px 18px",
      borderBottom: "1px solid #1e1e28",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      flexShrink: 0,
    }}>
      <div>
        <div style={{
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "#444",
          marginBottom: 4,
        }}>
          {eyebrow}
        </div>
        <div style={{
          fontSize: 17,
          fontWeight: 700,
          fontStyle: "italic",
          color: "#e8e6e1",
          maxWidth: 280,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {title}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {actions}
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "1px solid #2a2a35",
            color: "#555",
            width: 32,
            height: 32,
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: FONT,
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ── Panel Footer ──────────────────────────────────────────────────────────────
export function PanelFooter({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: "16px 24px",
      borderTop: "1px solid #1e1e28",
      display: "flex",
      gap: 10,
      justifyContent: "flex-end",
      flexShrink: 0,
      background: "#13131a",
    }}>
      {children}
    </div>
  );
}

// ── Panel Button variants ─────────────────────────────────────────────────────
export function BtnPrimary({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "#e8e6e1",
        border: "none",
        color: "#0f0f13",
        padding: "9px 22px",
        fontSize: 12,
        fontFamily: FONT,
        fontWeight: 700,
        letterSpacing: "0.06em",
        borderRadius: 20,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

export function BtnSecondary({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "1px solid #2a2a35",
        color: "#666",
        padding: "9px 20px",
        fontSize: 12,
        fontFamily: FONT,
        letterSpacing: "0.05em",
        borderRadius: 20,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

export function BtnDanger({ label, onClick }: { label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? "#f8717115" : "transparent",
        border: `1px solid ${hovered ? "#f8717155" : "#2a2a35"}`,
        color: hovered ? "#f87171" : "#555",
        padding: "9px 20px",
        fontSize: 12,
        fontFamily: FONT,
        letterSpacing: "0.05em",
        borderRadius: 20,
        cursor: "pointer",
        transition: "all 0.15s",
        marginRight: "auto",
      }}
    >
      {label}
    </button>
  );
}