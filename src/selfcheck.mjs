// Self-check for the desktop app's frontend contracts — the things a reviewer
// would otherwise have to eyeball: no wordmark in the header, icon buttons named,
// label/select pairs bound, covers rendered through one component.
// Plain node, no framework. Usage: node src/selfcheck.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(dir, f), "utf8");

const app = read("App.tsx");
const forms = read("formComponents.tsx");
const stats = read("StatsPanel.tsx");
const add = read("AddNovelPanel.tsx");
const edit = read("EditNovelPanel.tsx");
const css = read("App.css");
const html = readFileSync(path.join(dir, "..", "index.html"), "utf8");

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

// ── Header ────────────────────────────────────────────────────────────────────
check("header carries no wordmark", () => {
  assert.ok(!/NovelTrackr|Noveltrackr/.test(app), "the brand text is back in the app shell");
});

check("export lives on the stats page", () => {
  assert.ok(!/>\s*Export\s*<\/button>/.test(app), "a bare Export button reappeared in the header");
  assert.match(stats, /BtnSecondary label="Export Data"/, "the stats page has no export action");
});

check("add is a labelled floating button", () => {
  assert.match(app, /function AddButton/);
  assert.match(app, /aria-label="Add novel"/);
});

// ── Dialogs ───────────────────────────────────────────────────────────────────
check("sheets are labelled dialogs and Escape-aware", () => {
  assert.match(forms, /role="dialog"/);
  assert.match(forms, /aria-modal="true"/);
  assert.match(forms, /aria-label=\{label\}/);
  assert.match(add, /label="Add Novel"/, "the add panel passes no dialog label");
  assert.match(edit, /label="Edit novel"/, "the edit panel passes no dialog label");
  assert.match(edit, /closeOnEscape=\{!dirty\}/, "Escape can still discard unsaved edits");
  assert.match(forms, /aria-label="Close panel"/, "the panel close button has no name");
});

check("quick update modal is a labelled dialog", () => {
  assert.match(app, /aria-label="Update progress"/);
  assert.match(app, /aria-label="Current chapter"/, "the chapter input has no label");
  assert.match(app, /Escape has to close this/, "Escape only works while the input has focus");
});

// ── Controls ──────────────────────────────────────────────────────────────────
check("icon-only buttons are named", () => {
  for (const label of ["List view", "Grid view", "Compact view", "Clear search"]) {
    assert.match(app, new RegExp(`aria-label="${label}"`), `missing aria-label: ${label}`);
  }
  assert.match(app, /aria-pressed=\{viewMode/, "the view toggles don't expose their state");
  assert.match(app, /aria-current=\{active \? "page"/, "the nav doesn't mark the current page");
});

check("selects are bound to real labels", () => {
  for (const id of ["status-filter", "sort-key"]) {
    assert.match(app, new RegExp(`htmlFor="${id}"`), `no label points at #${id}`);
    assert.match(app, new RegExp(`id="${id}"`), `#${id} does not exist`);
  }
  assert.match(app, /aria-label="Search novels by title or alias"/, "the search input has no name");
});

check("clickable rows and cards have a keyboard path", () => {
  const handlers = app.match(/onKeyDown=\{\(e\) => \{/g) ?? [];
  assert.ok(handlers.length >= 3, "a clickable row/card lost its Enter/Space handler");
  assert.match(
    app,
    /role="button"[\s\S]{0,240}?aria-label=\{`Edit \$\{n\.canonical_title\}`\}/,
    "the compact cards are unnamed buttons",
  );
});

check("the notice is a live region", () => {
  assert.match(app, /role="status"/);
  assert.match(app, /aria-live="polite"/);
});

// ── Covers ────────────────────────────────────────────────────────────────────
check("covers render through the one shared component", () => {
  assert.match(forms, /export function CoverImage/);
  for (const [name, file] of [["App.tsx", app], ["AddNovelPanel.tsx", add], ["EditNovelPanel.tsx", edit]]) {
    assert.match(file, /<CoverImage /, `${name} renders a cover by hand`);
    assert.ok(!/document\.createElement/.test(file), `${name} mutates the DOM when an image fails`);
  }
  assert.ok(!/CoverPreview/.test(app + forms + add + edit), "the per-file cover copies are back");
});

// ── Styling and motion ────────────────────────────────────────────────────────
check("no blanket transitions or unset outlines", () => {
  const files = [["App.tsx", app], ["formComponents.tsx", forms], ["StatsPanel.tsx", stats],
    ["AddNovelPanel.tsx", add], ["EditNovelPanel.tsx", edit]];
  for (const [name, file] of files) {
    assert.ok(!/transition:\s*"all/.test(file), `${name}: transition: all`);
    assert.ok(!/outline:\s*"none"/.test(file), `${name}: outline: none with nothing in its place`);
  }
});

check("the shell handles dark mode, focus and reduced motion", () => {
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /:focus-visible \{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /name="theme-color" content="#0f0f13"/);
});

check("the stylesheet import matches the file name", () => {
  // Windows resolves "./app.css"; a Linux build of the same tree does not
  assert.match(read("main.tsx"), /import "\.\/App\.css";/);
});

check("empty states say what to do next", () => {
  assert.match(app, /Your library is empty\./);
  assert.match(app, /No novels match those filters\./);
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}
console.log(failed === 0
  ? `\n${checks.length} frontend checks passed.`
  : `\n${failed} of ${checks.length} checks failed.`);
process.exit(failed === 0 ? 0 : 1);
