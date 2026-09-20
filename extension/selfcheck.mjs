// Self-check for the "novel not in library" flow on index pages (NovelUpdates etc).
// Runs the real background.js + popup.js in a vm with chrome/DOM stubs — no browser, no framework.
// Usage: node extension/selfcheck.mjs
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { setImmediate as tick } from "node:timers/promises";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(dir, f), "utf8");

const silent = { log() {}, error() {}, warn() {} };

function makeChrome(storage = {}, { badge = "", coverPending = null } = {}) {
  const calls = { badge: [], messages: [] };
  const listeners = {};
  return {
    calls,
    listeners,
    storage: {
      local: {
        get: async (key) => ({ [key]: storage[key] }),
        set: async (obj) => Object.assign(storage, obj),
        remove: async (key) => { delete storage[key]; },
      },
    },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        calls.messages.push(msg);
        return msg.type === "GET_COVER_PENDING" ? coverPending : { ok: true };
      },
    },
    // chrome.tabs.query supports both the promise form (popup.js) and callback form (background.js)
    tabs: {
      query: (_q, cb) => {
        const tabs = [{ id: 7 }];
        if (typeof cb === "function") { cb(tabs); return undefined; }
        return Promise.resolve(tabs);
      },
      onRemoved: { addListener(fn) { listeners.removed = fn; } },
      onUpdated: { addListener(fn) { listeners.updated = fn; } },
    },
    action: {
      getBadgeText: async () => (typeof badge === "function" ? badge() : badge),
      setBadgeText: async (o) => calls.badge.push(o.text),
      setBadgeBackgroundColor: async () => {},
    },
  };
}

// fetch stub — records every call, serves /status and /novels, ok+id for writes
function makeFetch(novels, { fail = [], json = {} } = {}) {
  const calls = [];
  const fetchStub = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    if (fail.some((f) => url.endsWith(f))) {
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    }
    if (url.endsWith("/status")) return { ok: true, json: async () => ({ running: true }) };
    if (url.endsWith("/novels")) return { ok: true, json: async () => novels };
    for (const [suffix, value] of Object.entries(json)) {
      if (url.endsWith(suffix)) return { ok: true, json: async () => value };
    }
    return { ok: true, json: async () => ({ ok: true, id: 42 }) };
  };
  return { calls, fetchStub };
}

// Every request the extension makes must carry the header the server now requires
function assertAuthed(calls, who) {
  const unauthed = calls.filter((c) => c.headers["X-Noveltrackr"] !== "1");
  assert.equal(unauthed.length, 0, `${who} sent ${unauthed.length} request(s) without the auth header`);
}

// Minimal DOM: getElementById returns sticky stubs so we can read what was rendered
function makeDom() {
  const nodes = new Map();
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: "", className: "", dataset: {}, onclick: null });
    return nodes.get(id);
  };
  return { el, document: { getElementById: el, querySelectorAll: () => [] } };
}

// ── 1. background.js: index page, novel NOT in the library ────────────────────
{
  const storage = {};
  const chrome = makeChrome(storage);
  const { calls, fetchStub } = makeFetch([]); // empty library
  const ctx = vm.createContext({ chrome, fetch: fetchStub, AbortSignal, console: silent, setTimeout, Promise });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

  const detection = {
    title: "Editor\u2019s Survival Guide",
    coverUrl: "https://cdn.novelupdates.com/images/2026/01/Editors-Survival-Guide.jpg",
    domain: "novelupdates.com",
    tabId: 7,
  };
  await ctx.handleCoverDetection(detection);

  // spread into this realm: objects created inside the vm context have a different Object.prototype
  assert.deepEqual({ ...storage.cover_7 }, { ...detection, type: "add" }, "unknown novel must queue an 'add' prompt");
  assert.ok(chrome.calls.badge.includes("+"), "unknown novel must set the badge so the popup opens");
  assert.ok(calls.some(c => c.url.endsWith("/novels")), "should fuzzy-match against the library");
  console.log("\u2713 background.js queues an add-to-library prompt for unknown novels");

  // Every request must now carry the header the server requires
  assertAuthed(calls, "background.js");

  // Navigating the tab away must drop the previous page's pending state
  storage.pending_7 = { title: "stale chapter" };
  chrome.listeners.updated(7, { url: "https://example.com/elsewhere" });
  await tick();
  assert.equal(storage.cover_7, undefined, "navigation must clear the stale cover/add prompt");
  assert.equal(storage.pending_7, undefined, "navigation must clear the stale chapter prompt");
  console.log("\u2713 background.js clears per-tab state when the tab navigates");
}

// ── 2. background.js: index page, novel IS in the library (unchanged path) ────
{
  const storage = {};
  const chrome = makeChrome(storage);
  const novels = [{
    id: 3,
    canonical_title: "Editor\u2019s Survival Guide",
    aliases: [],
    current_chapter_raw: "Chapter 12",
  }];
  const { calls: novelCalls, fetchStub } = makeFetch(novels);
  const ctx = vm.createContext({ chrome, fetch: fetchStub, AbortSignal, console: silent, setTimeout, Promise });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

  await ctx.handleCoverDetection({
    title: "Editor\u2019s Survival Guide",
    coverUrl: "https://cdn.novelupdates.com/images/2026/01/Editors-Survival-Guide.jpg",
    domain: "novelupdates.com",
    tabId: 7,
  });

  assert.equal(storage.cover_7.type, "cover", "known novel must keep the save-cover prompt");
  assert.equal(storage.cover_7.novelId, 3);
  assertAuthed(novelCalls, "background.js (matched novel)");
  console.log("\u2713 background.js still offers 'Save as Cover' for novels already in the library");
}

// ── 3. popup.js: renders the add prompt and posts the new novel ───────────────
{
  const storage = {};
  const pending = {
    title: "Editor\u2019s Survival Guide",
    coverUrl: "https://cdn.novelupdates.com/images/2026/01/Editors-Survival-Guide.jpg",
    domain: "novelupdates.com",
    type: "add",
    tabId: 7,
  };
  const chrome = makeChrome(storage, { badge: "+", coverPending: pending });
  const { calls, fetchStub } = makeFetch([]);
  const { el, document } = makeDom();
  const window = { close() {} };

  const ctx = vm.createContext({ chrome, document, window, fetch: fetchStub, AbortSignal, console: silent, setTimeout: (fn) => { fn(); return 0; }, Promise });
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  await tick(); // let init()'s promise chain settle

  assert.match(el("body").innerHTML, /Add to Library/, "popup must offer 'Add to Library'");
  assert.equal(typeof el("btnAdd").onclick, "function", "the Add button must be wired up");

  await el("btnAdd").onclick();
  await tick();

  const quickAdd = calls.find(c => c.url.endsWith("/quick-add"));
  assert.deepEqual(quickAdd?.body, { title: pending.title, chapter_raw: "" }, "must quick-add with no chapter");
  assert.deepEqual(calls.find(c => c.url.endsWith("/cover"))?.body, { novel_id: 42, cover_url: pending.coverUrl });
  assert.deepEqual(calls.find(c => c.url.endsWith("/mappings"))?.body, {
    domain: pending.domain,
    detected_title: pending.title,
    novel_id: 42,
  });
  assert.equal(storage["mapping:novelupdates.com:editors survival guide"], 42, "mapping must be cached locally");
  assert.ok(chrome.calls.messages.some(m => m.type === "DISMISS_COVER"), "pending state must be cleared");
  assert.match(el("body").innerHTML, /Added to library/);
  assertAuthed(calls, "popup.js");
  console.log("\u2713 popup.js adds the novel, saves its cover and caches the mapping");
}

// ── 4. popup.js: the badge may not be set yet when the popup opens ────────────
{
  const storage = {};
  const pending = {
    title: "Editor\u2019s Survival Guide",
    coverUrl: "https://cdn.novelupdates.com/images/2026/01/Editors-Survival-Guide.jpg",
    domain: "novelupdates.com",
    type: "add",
    tabId: 7,
  };
  let reads = 0;
  const chrome = makeChrome(storage, {
    badge: () => (++reads > 2 ? "+" : ""), // background finishes a moment later
    coverPending: pending,
  });
  const { fetchStub } = makeFetch([]);
  const { el, document } = makeDom();

  const ctx = vm.createContext({ chrome, document, window: { close() {} }, fetch: fetchStub, AbortSignal, console: silent, setTimeout: (fn) => { fn(); return 0; }, Promise });
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  await tick();

  assert.ok(reads > 1, "popup should re-check the badge before giving up");
  assert.match(el("body").innerHTML, /Add to Library/, "late detection must still reach the popup");
  console.log("\u2713 popup.js waits for a late badge instead of reporting a false 'nothing detected'");
}

// ── 5. popup.js: a duplicate title is linked, not added twice ─────────────────
{
  const storage = {};
  const pending = {
    title: "Editor\u2019s Survival Guide",
    coverUrl: "https://cdn.novelupdates.com/images/2026/01/Editors-Survival-Guide.jpg",
    domain: "novelupdates.com",
    type: "add",
    tabId: 7,
  };
  const chrome = makeChrome(storage, { badge: "+", coverPending: pending });
  const { calls, fetchStub } = makeFetch([], {
    json: { "/quick-add": { ok: false, error: "duplicate", novel_id: 9, novel_title: "Editors Survival Guide" } },
  });
  const { el, document } = makeDom();

  const ctx = vm.createContext({ chrome, document, window: { close() {} }, fetch: fetchStub, AbortSignal, console: silent, setTimeout: (fn) => { fn(); return 0; }, Promise });
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  await tick();

  // The app answers the Add click with "you already have this"
  await el("btnAdd").onclick();
  await tick();

  assert.match(el("body").innerHTML, /Already in your library/, "duplicate must be surfaced, not hidden");
  assert.equal(typeof el("btnLink").onclick, "function", "duplicate prompt must offer to link");

  await el("btnLink").onclick();
  await tick();

  assert.equal(storage["mapping:novelupdates.com:editors survival guide"], 9, "link must point at the existing novel");
  assert.ok(chrome.calls.messages.some((m) => m.type === "DISMISS_COVER"), "pending must be cleared after linking");
  assert.match(el("body").innerHTML, /Linked to/);
  console.log("\u2713 popup.js links a duplicate to the existing novel instead of adding a copy");
}

// ── 6. popup.js: a failed cover write must not read as plain success ──────────
{
  const storage = {};
  const pending = {
    title: "Editor\u2019s Survival Guide",
    coverUrl: "https://cdn.novelupdates.com/images/2026/01/Editors-Survival-Guide.jpg",
    domain: "novelupdates.com",
    type: "add",
    tabId: 7,
  };
  const chrome = makeChrome(storage, { badge: "+", coverPending: pending });
  const { calls, fetchStub } = makeFetch([], { fail: ["/cover"] });
  const { el, document } = makeDom();

  const ctx = vm.createContext({ chrome, document, window: { close() {} }, fetch: fetchStub, AbortSignal, console: silent, setTimeout: (fn) => { fn(); return 0; }, Promise });
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  await tick();
  await el("btnAdd").onclick();
  await tick();

  assert.match(el("body").innerHTML, /Couldn't save the cover/, "silent cover failure must be reported");
  assertAuthed(calls, "popup.js");
  console.log("\u2713 popup.js reports a failed cover write instead of a bare success");
}

// ── 7. selector guard: NovelUpdates markup matches what content.js looks for ──
{
  const ref = path.join(dir, "..", "novelupdate.txt");
  if (existsSync(ref)) {
    const html = readFileSync(ref, "utf8");
    assert.ok(html.includes('class="serieseditimg"'), "page markup changed — re-check cover selectors");
    assert.ok(read("content.js").includes('".serieseditimg img"'), "content.js must use the real NovelUpdates class");
    console.log("\u2713 content.js cover selectors match the saved NovelUpdates markup");
  } else {
    console.log("\u2013 skipped markup check (novelupdate.txt not present)");
  }
}

console.log("\nAll extension self-checks passed.");

