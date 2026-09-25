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
const latest = read("latest.ts");
const content = read("../extension/content.js");
const background = read("../extension/background.js");
const popup = read("../extension/popup.js");
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

check("the edit panel shows a novel's own log", () => {
  assert.match(edit, /getNovelHistory\(novel\.id\)/, "the panel never asks for this novel's history");
  assert.match(edit, /FieldLabel text="History"/, "the history section has no label");
  assert.match(edit, /aria-label="Reading history"/, "the history list is anonymous");
});

check("the stats read the sources and backlog that are already recorded", () => {
  assert.match(stats, /<SourceTable rows=\{stats\.sources\}/, "the sites aren't broken down");
  assert.match(stats, /<PaceRows rows=\{stats\.reading_now\}/, "no reading-now leaderboard");
  assert.match(stats, /<PaceRows rows=\{stats\.fastest_finishes\} showRate/, "no fastest-finish table");
  assert.match(stats, /backlog\.oldest_title/, "the oldest plan is never named");
  assert.match(stats, /Histogram buckets=\{stats\.backlog\.buckets\}/, "the backlog age isn't charted");
});

check("an unknown latest chapter is never shown as zero", () => {
  assert.match(app, /unreadChapters\(novel\.latest_chapter, novel\.chapter_sort\)/, "the badge ignores the shared rule");
  assert.match(app, /if \(unread === null \|\| unread === 0\) return null/, "the badge shows something when nothing is known");
  assert.match(app, /progressPercent\(novel\.chapter_sort, novel\.total_chapters\)/, "no per-novel progress bar");
  assert.match(stats, /stats\.unread\.known > 0/, "the headline doesn't check its own coverage");
  assert.match(stats, /have known data/, "the headline doesn't say how much it knows about");
});

check("a floor is never drawn as a proportion", () => {
  assert.match(latest, /export function latestSuffix\(/, "no shared rule for the chapter tail");
  assert.match(latest, /lower_bound" \? `\u2265/, "a floor would look exactly like a real total");
  assert.match(
    app,
    /latestSuffix\(novel\.latest_chapter, novel\.latest_chapter_confidence\)/,
    "the chapter cell ignores the floor rule"
  );
  assert.match(app, /if \(percent !== null\) \{/, "a bar must be drawn only with a real total");
});

check("the 30-day staleness rule lives in one place", () => {
  assert.match(latest, /export const STALE_AFTER_DAYS = 30/, "the threshold moved or changed");
  for (const [name, file] of [["App.tsx", app], ["EditNovelPanel.tsx", edit]]) {
    assert.match(file, /from "\.\/latest"/, `${name} doesn't use the shared rule`);
  }
  assert.ok(!/86_400|86400/.test(app + edit + stats), "a second copy of the staleness maths appeared");
});

check("the extension reports a latest chapter only when a page showed one", () => {
  for (const kind of ["exact", "caught_up", "lower_bound"]) {
    assert.ok(content.includes(`"${kind}"`), `no ${kind} read is ever reported`);
  }
  assert.match(content, /const latest = detectLatestChapters\(/, "nothing asks the page");
  assert.match(
    background,
    /if \(!latest \|\| typeof latest\.latest_chapter !== "number"\) return \{\}/,
    "a page with no evidence would still send fields",
  );
  assert.match(background, /\.\.\.latestFields\(latest\)/, "the observation never reaches the routes");
  assert.match(popup, /latest: detection\.latest/, "the popup drops what the page reported");
});

check("rating and drop reason are labelled pickers", () => {
  assert.match(forms, /aria-label="Rating"/, "the rating picker has no group label");
  assert.match(forms, /aria-label="Reason for dropping"/, "the reason picker has no group label");
  assert.match(forms, /aria-checked=\{value === star\}/, "the stars don't expose which one is set");
  assert.match(forms, /aria-checked=\{active\}/, "the reasons don't expose which one is set");
  assert.match(edit, /<RatingPicker value=\{form\.rating\}/, "the edit panel never offers a rating");
  assert.match(edit, /<ReasonPicker value=\{form\.drop_reason\}/, "the edit panel never asks why");
  // A novel that was never dropped has no reason to give
  assert.match(edit, /form\.status === "dropped" && \(/, "the reason is asked for on every status");
});

check("restoring a backup asks before it replaces the library", () => {
  assert.match(stats, /BtnSecondary label="Restore Backup"/, "the stats page has no restore action");
  assert.match(stats, /await onRestore\(\)/, "the confirm step never runs the restore");
  // One click must not swap a library out from under the user
  assert.match(stats, /BtnDanger label="Replace library"/, "restore replaces the library without asking");
  assert.match(stats, /setConfirmRestore\(true\)/, "nothing reaches the confirm step");
  // What was restored has to be reported, not assumed
  assert.match(app, /Restored \$\{report\.novels\}/, "the header doesn't report what a restore wrote");
});

check("add is a labelled floating button", () => {
  assert.match(app, /function AddButton/);
  assert.match(app, /aria-label="Add novel"/);
  // The icon is drawn, not typed — a font's "+" is never optically centred
  assert.match(app, /function AddButton[\s\S]{0,800}?<svg/, "the add icon is a text glyph again");
  assert.ok(
    !/getFabStyle[\s\S]{0,400}?fontSize/.test(app),
    "the FAB is nudging a text glyph with font metrics again",
  );
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
  for (const id of ["status-filter", "author-filter", "sort-key"]) {
    assert.match(app, new RegExp(`htmlFor="${id}"`), `no label points at #${id}`);
    assert.match(app, new RegExp(`id="${id}"`), `#${id} does not exist`);
  }
  assert.match(app, /aria-label="Search novels by title, alias, author or notes"/, "the search input has no name");
});

check("tag filters toggle and can be cleared", () => {
  assert.match(app, /aria-pressed=\{active\}/, "the tag filters don't expose their state");
  assert.match(app, /Filter by \$\{tag\.name\}/, "the tag filters have no description");
  assert.match(app, /Clear filters/, "a filtered library can't be reset");
  // Notes hold \"where I left off\" — search has to reach them
  assert.match(app, /n\.notes \?\? ""\)\.toLowerCase\(\)\.includes\(q\)/, "notes dropped out of search");
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

// ── Library work per render ───────────────────────────────────────────────────
check("the library doesn't redo its work every time something re-renders", () => {
  assert.match(forms, /loading="lazy"/, "opening the library fetches every cover at once");
  assert.match(forms, /decoding="async"/, "cover decoding blocks the paint");
  assert.match(app, /const filtered = useMemo\(/, "the filter and sort run on every render");
  assert.match(app, /const tagChoices = useMemo\(/, "the tag chips are rebuilt on every render");
  assert.ok(
    !/new Date\([ab]\.updated_at\)/.test(app),
    "the sort parses dates inside the comparator — n log n parses per keystroke"
  );
  assert.match(app, /memo\(function ListRow/, "a keystroke in the search box redraws every row");
  assert.ok(app.includes("const openNovel = useCallback("), "the row opener is rebuilt on every render");
  assert.equal(
    app.split("onOpen={openNovel}").length - 1,
    2,
    "a row or card is handed a fresh closure, which defeats its memo"
  );
});

// ── Five stars ────────────────────────────────────────────────────────────────
check("five stars are foil-stamped, and never rely on motion or colour alone", () => {
  assert.match(app, /function isFavourite\(novel: \{ rating: number \| null \}\)/);
  assert.match(app, /return novel\.rating === 5;/, "the treatment must be exactly five stars");
  assert.equal(
    (app.match(/getCoverFrameStyle\(styles\.\w+/g) || []).length,
    2,
    "the cover in one of the two views has no frame"
  );
  assert.equal((app.match(/"foil-host"/g) || []).length, 2, "pointing at a row or card would not sweep it");
  assert.match(app, /Rated 5 out of 5 stars/, "the frame says nothing to a screen reader");
  assert.match(app, /role=\{favourite \? "img" : undefined\}/, "the frame is silent about what it means");

  // The frame is permanent; only the highlight animates, and only while it is being
  // pointed at or focused. Movement is never what carries the rating.
  assert.match(css, /\.foil \{/);
  assert.match(css, /\.foil-host:hover \.foil::after/);
  assert.match(css, /\.foil-host:focus-within \.foil::after/, "the keyboard gets no sweep");
  assert.ok(!/\.foil \{[\s\S]{0,160}animation:/.test(css), "the foil animates without being pointed at");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "the sweep ignores reduced motion");

  // Gold means five stars now, so nothing else may be that colour
  assert.ok(!/facc15/.test(app + forms), "the paused badge is still the colour of the foil");
  assert.match(app, /paused:.*#fb923c/);
  assert.match(forms, /"paused"[\s\S]{0,80}#fb923c/, "the picker and the badge disagree about paused");
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
