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

function makeChrome(storage = {}, { badge = "", coverPending = null, nuPending = null } = {}) {
  const calls = { badge: [], messages: [], tabs: [] };
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
      onMessage: { addListener(fn) { listeners.message = fn; } },
      sendMessage: async (msg) => {
        calls.messages.push(msg);
        if (msg.type === "GET_COVER_PENDING") return coverPending;
        if (msg.type === "GET_NU_PENDING") return nuPending;
        return { ok: true };
      },
    },
    // chrome.tabs.query supports both the promise form (popup.js) and callback form (background.js)
    tabs: {
      query: (_q, cb) => {
        const tabs = [{ id: 7 }];
        if (typeof cb === "function") { cb(tabs); return undefined; }
        return Promise.resolve(tabs);
      },
      update: async (id, props) => {
        calls.tabs.push({ id, ...props });
        return [{ id }];
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

// ── 7. content.js: one pending cover check, never for a page you already left ─
{
  const cover = {
    src: "https://cdn.novelupdates.com/images/2026/01/Editors-Survival-Guide.jpg",
    complete: true,
    naturalWidth: 400,
    naturalHeight: 600,
  };
  const location = {
    href: "https://www.novelupdates.com/series/editors-survival-guide/",
    hostname: "www.novelupdates.com",
    pathname: "/series/editors-survival-guide/",
  };

  const timers = [];
  const chrome = makeChrome({});
  const document = {
    title: "Editor\u2019s Survival Guide - Novel Updates",
    querySelector: (sel) => (sel.includes("img") ? cover : null),
    querySelectorAll: (sel) => (sel.includes("img") ? [cover] : []),
    addEventListener: () => {},
  };

  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: (fn) => timers.push(fn) - 1,
    clearTimeout: (id) => { if (id !== null && id !== undefined) timers[id] = null; },
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  assert.equal(timers.length, 1, "loading a page must schedule exactly one cover check");

  // A second run() (turbo/pjax navigation) must replace the pending timer, not add another
  ctx.run();
  assert.equal(timers[0], null, "re-running must cancel the previous timer");
  assert.equal(timers.filter(Boolean).length, 1, "only one cover check may be pending");

  // Firing it finds the cover and reports this page once
  timers[1]();
  const sent = chrome.calls.messages;
  assert.equal(sent.length, 1, "a found cover must be sent once");
  assert.equal(sent[0].type, "COVER_DETECTED");
  assert.equal(sent[0].payload.coverUrl, cover.src);
  assert.equal(sent[0].payload.domain, "novelupdates.com");

  // If the page navigates in-page while we wait, the stale title must not be sent
  ctx.run();
  location.href = "https://www.novelupdates.com/series/something-else/";
  timers[2]();
  assert.equal(chrome.calls.messages.length, 1, "a page change must drop the pending detection");

  console.log("\u2713 content.js keeps one pending cover check and drops it when the page changes");
}

// ── 8. selector guard: NovelUpdates markup matches what content.js looks for ──
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

// ── 9. content.js: the page's author and tags are read and reported ──────────
{
  const author = { textContent: "  Guiltythree  " };
  const cover = {
    src: "https://cdn.royalroadcdn.com/cover.jpg",
    complete: true,
    naturalWidth: 400,
    naturalHeight: 600,
  };
  const tagEls = [
    { textContent: "LitRPG" },
    { textContent: " Progression Fantasy " },
    { textContent: "litrpg" }, // same tag, different case
    { textContent: "" },       // stray element with nothing in it
  ];
  const location = {
    href: "https://www.royalroad.com/fiction/99/shadow-slave",
    hostname: "www.royalroad.com",
    pathname: "/fiction/99/shadow-slave",
  };

  const timers = [];
  const chrome = makeChrome({});
  const document = {
    title: "Shadow Slave | Royal Road",
    querySelector: (sel) => {
      if (sel.includes("img")) return cover;
      if (sel.includes("/profile/")) return author;
      return null;
    },
    querySelectorAll: (sel) => (sel.includes("tagsAdd") ? tagEls : []),
    addEventListener: () => {},
  };

  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: (fn) => timers.push(fn) - 1,
    clearTimeout: (id) => { if (id !== null && id !== undefined) timers[id] = null; },
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  const metadata = chrome.calls.messages.find((m) => m.type === "METADATA_DETECTED");
  assert.ok(metadata, "an author on a supported site must be reported");
  assert.equal(metadata.payload.title, "Shadow Slave", "metadata must carry the resolved title");
  assert.equal(metadata.payload.author, "Guiltythree", "the author must be trimmed");
  assert.deepEqual([...metadata.payload.tags], ["LitRPG", "Progression Fantasy"], "tags must be trimmed and de-duplicated");
  assert.equal(metadata.payload.source, "royalroad", "tags must be labelled with the site they came from");

  timers[0]();
  const coverMsg = chrome.calls.messages.find((m) => m.type === "COVER_DETECTED");
  assert.equal(coverMsg.payload.author, "Guiltythree", "the author rides along with the cover");
  assert.deepEqual([...coverMsg.payload.tags], ["LitRPG", "Progression Fantasy"], "the tags ride along with the cover");
  assert.equal(coverMsg.payload.domain, "royalroad.com");
  console.log("\u2713 content.js reads the page's author and tags, and carries both with the cover");
}

// ── 10. background.js: metadata is written for a known novel, silently ───────
{
  const storage = {};
  const chrome = makeChrome(storage);
  const novels = [{
    id: 5,
    canonical_title: "Shadow Slave",
    aliases: [],
    current_chapter_raw: "Chapter 220",
  }];
  const { calls, fetchStub } = makeFetch(novels);
  const ctx = vm.createContext({ chrome, fetch: fetchStub, AbortSignal, console: silent, setTimeout, Promise });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

  await ctx.handleMetadataDetection({ title: "Shadow Slave", author: "Guiltythree" });

  const write = calls.find((c) => c.url.endsWith("/metadata"));
  assert.deepEqual(write?.body, {
    novel_id: 5,
    author: "Guiltythree",
    tags: null,
    source: null,
  }, "the matched novel gets the author");
  assert.equal(chrome.calls.badge.length, 0, "passive metadata must never touch the badge");
  assertAuthed(calls, "background.js (metadata)");

  // Tags from a supported site go to the same route, labelled with their source
  calls.length = 0;
  await ctx.handleMetadataDetection({
    title: "Shadow Slave",
    author: null,
    tags: ["LitRPG", "Progression Fantasy"],
    source: "royalroad",
  });
  assert.deepEqual(calls.find((c) => c.url.endsWith("/metadata"))?.body, {
    novel_id: 5,
    author: null,
    tags: ["LitRPG", "Progression Fantasy"],
    source: "royalroad",
  }, "tags must be written with the site they came from");
  assert.equal(
    calls.filter((c) => c.url.endsWith("/tag-vocabulary")).length, 0,
    "only NovelUpdates' tags are canonical enough to teach the vocabulary"
  );

  // A page for a novel the library doesn't have is the cover flow's business
  calls.length = 0;
  await ctx.handleMetadataDetection({ title: "Something Else Entirely", author: "Nobody" });
  assert.equal(calls.filter((c) => c.url.endsWith("/metadata")).length, 0, "unknown pages must not write metadata");
  console.log("\u2713 background.js writes metadata only for novels already in the library");
}

// ── 11. popup.js: the author and tags found on the novel page are saved ──────
{
  const storage = {};
  const pending = {
    title: "Shadow Slave",
    coverUrl: "https://cdn.royalroadcdn.com/cover.jpg",
    author: "Guiltythree",
    tags: ["LitRPG", "Progression Fantasy"],
    source: "royalroad",
    domain: "royalroad.com",
    type: "add",
    tabId: 7,
  };
  const chrome = makeChrome(storage, { badge: "+", coverPending: pending });
  const { calls, fetchStub } = makeFetch([]);
  const { el, document } = makeDom();

  const ctx = vm.createContext({ chrome, document, window: { close() {} }, fetch: fetchStub, AbortSignal, console: silent, setTimeout: (fn) => { fn(); return 0; }, Promise });
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  await tick();

  await el("btnAdd").onclick();
  await tick();

  const quickAdd = calls.find((c) => c.url.endsWith("/quick-add"));
  assert.deepEqual(quickAdd?.body, {
    title: pending.title,
    chapter_raw: "",
    author: "Guiltythree",
    tags: ["LitRPG", "Progression Fantasy"],
    source: "royalroad",
  }, "the detected author and tags must be saved with the add");
  console.log("\u2713 popup.js saves the author and tags it detected on the novel page");
}

// ── 12. background.js: 'Save as Cover' passes the author on to the app ───────
{
  const storage = {};
  const chrome = makeChrome(storage);
  const novels = [{
    id: 5,
    canonical_title: "Shadow Slave",
    aliases: [],
    current_chapter_raw: null,
  }];
  const { calls, fetchStub } = makeFetch(novels);
  const ctx = vm.createContext({ chrome, fetch: fetchStub, AbortSignal, console: silent, setTimeout, Promise });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

  let replied = null;
  chrome.listeners.message(
    { type: "SAVE_COVER", payload: { novelId: 5, coverUrl: "https://cdn.royalroadcdn.com/cover.jpg", author: "Guiltythree", tabId: 7 } },
    {},
    (r) => { replied = r; }
  );
  await tick();

  const cover = calls.find((c) => c.url.endsWith("/cover"));
  assert.deepEqual(cover?.body, {
    novel_id: 5,
    cover_url: "https://cdn.royalroadcdn.com/cover.jpg",
    author: "Guiltythree",
  });
  assert.deepEqual({ ...replied }, { ok: true }, "the popup must be told the write succeeded");
  console.log("\u2713 background.js passes the page's author through the cover save");
}

// ── 13. content.js: NU's Series Finder loads tag names into the vocabulary ───
{
  const tagEls = [
    { textContent: "LitRPG" },
    { textContent: "lit-rpg" }, // same tag, other spelling
    { textContent: "Progression Fantasy" },
    { textContent: "z".repeat(80) }, // junk
  ];
  const location = {
    href: "https://www.novelupdates.com/series-finder/",
    hostname: "www.novelupdates.com",
    pathname: "/series-finder/",
    search: "",
    hash: "",
  };

  const timers = [];
  const chrome = makeChrome({});
  const document = {
    title: "Series Finder - Novel Updates",
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes("sh=") ? tagEls : []),
    addEventListener: () => {},
  };

  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: (fn) => timers.push(fn) - 1,
    clearTimeout: () => {},
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  const msg = chrome.calls.messages.find((m) => m.type === "VOCABULARY_DETECTED");
  assert.ok(msg, "the Series Finder page must report the tags it lists");
  assert.deepEqual([...msg.payload.tags], ["LitRPG", "Progression Fantasy"], "the list must be cleaned");
  assert.equal(timers.length, 0, "the finder is not a novel page — no cover check");
  console.log("\u2713 content.js loads tag names from NU's Series Finder");
}

// ── 14. background.js: the vocabulary is posted to the app ───────────────────
{
  const storage = {};
  const chrome = makeChrome(storage);
  const { calls, fetchStub } = makeFetch([]);
  const ctx = vm.createContext({ chrome, fetch: fetchStub, AbortSignal, console: silent, setTimeout, Promise });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

  await ctx.postVocabulary(["LitRPG", "Progression Fantasy"]);

  const write = calls.find((c) => c.url.endsWith("/tag-vocabulary"));
  assert.deepEqual(write?.body, { tags: ["LitRPG", "Progression Fantasy"] }, "the app must get the tag list");
  assert.equal(chrome.calls.badge.length, 0, "the vocabulary capture must stay silent");
  assertAuthed(calls, "background.js (vocabulary)");
  console.log("\u2713 background.js posts the tag vocabulary to the app");
}

// ── 15. content.js: the NU results page reports its candidates ───────────────
{
  const anchors = [
    { href: "https://www.novelupdates.com/series/shadow-slave/", textContent: "Shadow Slave" },
    { href: "https://www.novelupdates.com/series/shadow-slave/", textContent: "Shadow Slave" }, // duplicate link
    { href: "https://www.novelupdates.com/user/guiltythree/", textContent: "Guiltythree" },      // not a series
    { href: "https://www.novelupdates.com/series/shadow-slave-2/", textContent: "Shadow Slave 2" },
  ];
  const location = {
    href: "https://www.novelupdates.com/?s=Shadow%20Slave&post_type=wp-manga",
    hostname: "www.novelupdates.com",
    pathname: "/",
    search: "?s=Shadow%20Slave&post_type=wp-manga",
  };

  const timers = [];
  const chrome = makeChrome({});
  const document = {
    title: "Shadow Slave - Novel Updates",
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes("/series/") ? anchors : []),
    addEventListener: () => {},
  };

  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: (fn) => timers.push(fn) - 1,
    clearTimeout: () => {},
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  const msg = chrome.calls.messages.find((m) => m.type === "NU_SEARCH_DETECTED");
  assert.ok(msg, "the results page must report what it found");
  assert.equal(msg.payload.query, "Shadow Slave", "the search query comes from the URL");
  assert.equal(msg.payload.candidates.length, 2, "duplicates and non-series links are dropped");
  assert.equal(msg.payload.candidates[0].title, "Shadow Slave");
  assert.equal(msg.payload.candidates[0].url, anchors[0].href);
  assert.equal(timers.length, 0, "a results page is not a novel page — no cover check");
  console.log("\u2713 content.js lists the NU search candidates for the app's request");
}

// ── 16. background.js: matching the search back to a novel, then confirming ──
{
  const storage = {};
  const chrome = makeChrome(storage);
  const novels = [{
    id: 5,
    canonical_title: "Shadow Slave",
    aliases: [],
    current_chapter_raw: "Chapter 220",
  }];
  const { calls, fetchStub } = makeFetch(novels);
  const ctx = vm.createContext({ chrome, fetch: fetchStub, AbortSignal, console: silent, setTimeout, Promise });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

  const candidates = [
    { title: "Shadow Slave", url: "https://www.novelupdates.com/series/shadow-slave/" },
    { title: "Shadow Slave 2", url: "https://www.novelupdates.com/series/shadow-slave-2/" },
  ];
  await ctx.handleNuSearch({ query: "Shadow Slave", candidates, tabId: 7 });

  assert.equal(storage.nu_7.novelId, 5, "the search must be matched back to the library novel");
  assert.ok(chrome.calls.badge.includes("?"), "the popup needs a badge to open on");
  assertAuthed(calls, "background.js (NU search)");

  // Confirming a candidate records the choice against that series URL
  const result = await ctx.handleNuConfirm(7, candidates[1].url);
  assert.deepEqual({ ...result }, { ok: true });
  assert.equal(storage[`nu_match:${candidates[1].url}`], 5, "the chosen series must point at the novel");
  assert.equal(storage.nu_7, undefined, "the choice is no longer pending once confirmed");
  assert.deepEqual(chrome.calls.tabs, [{ id: 7, url: candidates[1].url }], "the series page must open in that tab");
  console.log("\u2713 background.js asks which NU series it is, then opens the chosen one");

  // A search for something the library doesn't have stays silent
  chrome.calls.badge.length = 0;
  await ctx.handleNuSearch({ query: "Some Other Novel", candidates, tabId: 7 });
  assert.equal(storage.nu_7, undefined, "an unknown search must not queue a prompt");
  assert.equal(chrome.calls.badge.length, 0);
  console.log("\u2713 background.js ignores NU searches for novels it doesn't have");

  // The confirmed series wins over a fuzzy title match on the series page
  calls.length = 0;
  await ctx.handleMetadataDetection({
    title: "Shadow Slave 2",
    author: null,
    tags: ["LitRPG"],
    source: "nu",
    url: candidates[1].url,
  });
  assert.equal(calls.find((c) => c.url.endsWith("/metadata"))?.body.novel_id, 5, "the chosen series must win");
  assert.ok(
    calls.some((c) => c.url.endsWith("/tag-vocabulary")),
    "NU's tag names are canonical, so the series page also teaches the vocabulary"
  );
  console.log("\u2713 background.js files the confirmed series' tags against the right novel");
}

// ── 17. popup.js: the candidate list is clickable and confirms the choice ────
{
  const storage = {};
  const nuPending = {
    novelId: 5,
    novelTitle: "Shadow Slave",
    query: "Shadow Slave",
    candidates: [
      { title: "Shadow Slave", url: "https://www.novelupdates.com/series/shadow-slave/" },
      { title: "Shadow Slave 2", url: "https://www.novelupdates.com/series/shadow-slave-2/" },
    ],
    tabId: 7,
  };
  const chrome = makeChrome(storage, { badge: "?", nuPending });
  const { fetchStub } = makeFetch([]);
  const { el, document } = makeDom();

  const ctx = vm.createContext({ chrome, document, window: { close() {} }, fetch: fetchStub, AbortSignal, console: silent, setTimeout: (fn) => { fn(); return 0; }, Promise });
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  await tick();

  assert.match(el("body").innerHTML, /Which series is it\?/, "the popup must ask which series it is");
  assert.match(el("body").innerHTML, /Shadow Slave 2/, "every candidate must be listed");
  assert.equal(typeof el("candidate-1").onclick, "function", "candidates must be clickable");

  await el("candidate-1").onclick();
  await tick();

  const confirm = chrome.calls.messages.find((m) => m.type === "NU_CONFIRM");
  assert.deepEqual({ ...confirm.payload }, { candidateUrl: nuPending.candidates[1].url, tabId: 7 });
  assert.match(el("body").innerHTML, /Opening that series/);
  console.log("\u2713 popup.js lists the NU candidates and confirms the one the user picked");
}

// ── 17. content.js: results are recognised even when the URL says nothing ────
{
  const anchors = [
    { href: "https://www.novelupdates.com/series/shadow-slave/", textContent: "Shadow Slave" },
  ];
  const box = { value: "Shadow Slave" };
  const location = {
    href: "https://www.novelupdates.com/what/ever/nu/uses/now",
    hostname: "www.novelupdates.com",
    pathname: "/what/ever/nu/uses/now",
    search: "",
    hash: "",
  };

  const chrome = makeChrome({});
  const document = {
    title: "Search - Novel Updates",
    querySelector: (sel) => (sel.includes("input[name='s']") ? box : null),
    querySelectorAll: (sel) => (sel.includes("/series/") ? anchors : []),
    addEventListener: () => {},
  };

  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  const msg = chrome.calls.messages.find((m) => m.type === "NU_SEARCH_DETECTED");
  assert.ok(msg, "the query in NU's search box is enough to spot a results page");
  assert.equal(msg.payload.query, "Shadow Slave");
  console.log("\u2713 content.js spots NU results without depending on the results URL");
}

// ── 18. content.js: the app's parked query runs NU's own search ──────────────
{
  let submitted = 0;
  const box = { value: "", form: { requestSubmit: () => { submitted += 1; } } };
  let clearedTo = null;
  const location = {
    href: "https://www.novelupdates.com/#noveltrackr=Shadow%20Slave",
    hostname: "www.novelupdates.com",
    pathname: "/",
    search: "",
    hash: "#noveltrackr=Shadow%20Slave",
  };

  const chrome = makeChrome({});
  const document = {
    title: "Novel Updates",
    querySelector: (sel) => (sel.includes("input[name='s']") ? box : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const ctx = vm.createContext({
    chrome,
    document,
    window: { location, history: { replaceState: (_state, _title, url) => { clearedTo = url; } } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  assert.equal(box.value, "Shadow Slave", "the parked query must land in NU's own search box");
  assert.equal(submitted, 1, "NU's search form must be submitted");
  assert.equal(clearedTo, "/", "the marker must be dropped so a reload can't search again");
  assert.equal(chrome.calls.messages.length, 0, "the search request itself has nothing to report");
  console.log("\u2713 content.js runs NU's own search for the query the app parked");
}

console.log("\nAll extension self-checks passed.");
