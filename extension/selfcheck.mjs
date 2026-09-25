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

function makeChrome(storage = {}, { badge = "", coverPending = null, nuPending = null, nuSaved = null, nuRelease = null } = {}) {
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
        if (msg.type === "GET_NU_SAVED") return nuSaved;
        if (msg.type === "GET_NU_RELEASE") return nuRelease;
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

  // A NovelUpdates page queues its cover check and nothing else: its release list is
  // other sites' numbering, so there is no chapter count to wait for (check 31)
  assert.equal(timers.length, 1, "the cover check is the only work this page queues");

  // A second run() (turbo/pjax navigation) must replace the pending cover timer,
  // not add a second one
  ctx.run();
  assert.equal(timers[0], null, "re-running must cancel the previous cover timer");
  assert.equal(timers.filter(Boolean).length, 1, "only one cover check may be pending");

  // Firing it finds the cover and reports this page once
  timers.filter(Boolean).at(-1)();
  const sent = chrome.calls.messages;
  assert.equal(sent.length, 1, "a found cover must be sent once");
  assert.equal(sent[0].type, "COVER_DETECTED");
  assert.equal(sent[0].payload.coverUrl, cover.src);
  assert.equal(sent[0].payload.domain, "novelupdates.com");

  // If the page navigates in-page while we wait, the stale title must not be sent
  ctx.run();
  location.href = "https://www.novelupdates.com/series/something-else/";
  timers.filter(Boolean).at(-1)();
  assert.equal(chrome.calls.messages.length, 1, "a page change must drop the pending detection");

  console.log("\u2713 content.js keeps one pending cover check and drops it when the page changes");
}

// ── 8. selector guard: NovelUpdates markup matches what content.js looks for ──
{
  const ref = path.join(dir, "..", "novelupdate.txt");
  if (existsSync(ref)) {
    const html = readFileSync(ref, "utf8");
    // A saved page with no links and no images is a shell (head only, body still
    // to be built by the site's scripts), so there is no markup to compare with
    const rendered = html.includes("<a ") || html.includes("<img");
    if (!rendered) {
      console.log("– skipped markup check (novelupdate.txt has no rendered body — save the loaded page)");
    } else {
      assert.ok(html.includes('class="serieseditimg"'), "page markup changed — re-check cover selectors");
      assert.ok(read("content.js").includes('".serieseditimg img"'), "content.js must use the real NovelUpdates class");
      console.log("\u2713 content.js cover selectors match the saved NovelUpdates markup");
    }
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

  // The cover check is queued after the look-again for a chapter list, so it is
  // the last timer this page put in the queue
  timers.filter(Boolean).at(-1)();
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

// ── 18. content.js: fills NU's search box and leaves the search to the user ──
{
  let submitted = 0;
  let appended = 0;
  let hint = null;
  const box = { value: "", focus: () => {}, form: { requestSubmit: () => { submitted += 1; } } };
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
    createElement: () => {
      hint = { style: {}, textContent: "", href: "", appendChild: () => {}, remove: () => {} };
      return hint;
    },
    body: { appendChild: () => { appended += 1; } },
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
  assert.equal(submitted, 0, "the extension must not submit the form itself — that is what Cloudflare blocks");
  assert.equal(appended, 1, "the user must be told what to do next");
  assert.match(hint.textContent, /press Enter/, "the hint must say to press Enter");
  assert.equal(clearedTo, "/", "the marker must be dropped so a reload can't re-offer the query");
  assert.equal(chrome.calls.messages.length, 0, "filling a box must not talk to NU");
  console.log("\u2713 content.js hands the query to NU's own search box and waits for the user");
}

// ── 19. content.js: no search box → a link, never an automatic navigation ────
{
  let appended = 0;
  let anchor = null;
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
    querySelector: () => null, // no search box we recognise
    querySelectorAll: () => [],
    createElement: () => {
      anchor = { style: {}, textContent: "", href: "", appendChild: () => {}, remove: () => {} };
      return anchor;
    },
    body: { appendChild: () => { appended += 1; } },
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

  assert.equal(appended, 1, "the user must be offered something to click");
  assert.equal(
    anchor.href, "https://www.novelupdates.com/?s=Shadow%20Slave",
    "the offer must be NU's own search URL, for the user to click"
  );
  assert.equal(chrome.calls.messages.length, 0, "nothing may navigate or search behind the user's back");
  assert.equal(clearedTo, "/", "the marker must still be dropped");
  console.log("\u2713 content.js offers NU's search as a link when there is no search box");
}

// ── 20. content.js: a Cloudflare block is reported, never searched into ──────
{
  let clearedTo = null;
  const blockEl = { id: "cf-error-details" };
  const location = {
    href: "https://www.novelupdates.com/#noveltrackr=Shadow%20Slave",
    hostname: "www.novelupdates.com",
    pathname: "/",
    search: "",
    hash: "#noveltrackr=Shadow%20Slave",
  };

  const timers = [];
  const chrome = makeChrome({});
  const document = {
    title: "Attention Required! | Cloudflare",
    querySelector: (sel) => (sel.includes("cf-error-details") ? blockEl : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const ctx = vm.createContext({
    chrome,
    document,
    window: { location, history: { replaceState: (_state, _title, url) => { clearedTo = url; } } },
    setTimeout: (fn) => timers.push(fn) - 1,
    clearTimeout: () => {},
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  assert.equal(chrome.calls.messages.length, 0, "a blocked page must not start a search");
  assert.equal(clearedTo, "/", "the parked query must be dropped while blocked");
  assert.equal(timers.length, 0, "and nothing may be scheduled on it");
  console.log("\u2713 content.js stands down when Cloudflare blocks NovelUpdates");
}

// ── 21. background.js + popup.js: the NU flow reports what it captured ──────
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

  await ctx.handleMetadataDetection({
    title: "Shadow Slave",
    author: null,
    tags: ["LitRPG", "Weak to Strong"],
    source: "nu",
    tabId: 7,
  });

  assert.equal(storage.nu_saved_7.count, 2, "the tags captured for this tab must be remembered");
  assert.equal(storage.nu_saved_7.novelTitle, "Shadow Slave");
  console.log("\u2713 background.js remembers what the NU flow captured for the tab");
}

// ── 22. popup.js: the tag report leads, the cover offer stays available ─────
{
  const storage = {};
  const saved = { novelTitle: "Shadow Slave", count: 61 };
  const cover = {
    novelId: 5,
    novelTitle: "Shadow Slave",
    coverUrl: "https://cdn.novelupdates.com/images/cover.jpg",
    type: "cover",
    tabId: 7,
  };
  const chrome = makeChrome(storage, { badge: "+", coverPending: cover, nuSaved: saved });
  const { calls, fetchStub } = makeFetch([]);
  const { el, document } = makeDom();

  const ctx = vm.createContext({ chrome, document, window: { close() {} }, fetch: fetchStub, AbortSignal, console: silent, setTimeout: (fn) => { fn(); return 0; }, Promise });
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  await tick();

  assert.match(el("body").innerHTML, /61 tags filed/, "the popup must say what the NU flow filed");
  assert.match(el("body").innerHTML, /NovelUpdates/, "and where it came from");
  assert.equal(typeof el("btnSaveCover").onclick, "function", "the cover offer must survive");

  await el("btnSaveCover").onclick();
  await tick();

  const sent = chrome.calls.messages.find((m) => m.type === "SAVE_COVER");
  assert.deepEqual(
    { ...sent?.payload },
    { novelId: 5, coverUrl: cover.coverUrl, author: undefined, tabId: 7 },
    "the cover save must be requested with the cover this page had"
  );
  assert.match(el("coverCard").innerHTML, /Cover saved/, "the cover card reports itself");
  assert.equal(typeof el("btnDone").onclick, "function", "and the way out is still there");
  console.log("\u2713 popup.js reports the filed tags and keeps the cover offer");
}

// ── 23. the whole way: the page's tags reach an add that a cover offered ──────
// Every half above passes on its own; this is the seam between them. The cover
// message used to lose the page's tags on its way to the popup, so a fresh novel
// was added bare — the tags only appeared on a second visit, by which time the
// novel is in the library and the metadata route writes them.
{
  const tags = [{ textContent: "LitRPG" }, { textContent: " Progression Fantasy " }];
  const cover = {
    src: "https://cdn.novelupdates.com/images/2026/01/shadow-slave.jpg",
    complete: true,
    naturalWidth: 400,
    naturalHeight: 600,
  };
  const location = {
    href: "https://www.novelupdates.com/series/shadow-slave/",
    hostname: "www.novelupdates.com",
    pathname: "/series/shadow-slave/",
  };

  // 1. The page — a NU series page with tags and a cover, as content.js sees it
  const pageTimers = [];
  const pageChrome = makeChrome({});
  const pageDoc = {
    title: "Shadow Slave | Novel Updates",
    querySelector: (sel) => (sel.includes("img") ? cover : null),
    querySelectorAll: (sel) => (sel.includes("showtag") ? tags : []),
    addEventListener: () => {},
  };
  const pageCtx = vm.createContext({
    chrome: pageChrome,
    document: pageDoc,
    window: { location },
    setTimeout: (fn) => pageTimers.push(fn) - 1,
    clearTimeout: (id) => { if (id !== null && id !== undefined) pageTimers[id] = null; },
    console: silent,
  });
  vm.runInContext(read("content.js"), pageCtx, { filename: "content.js" });

  // The cover check is the last timer an index page queues (the look-again for a
  // chapter list comes first)
  pageTimers.filter(Boolean).at(-1)();
  const reported = pageChrome.calls.messages.find((m) => m.type === "COVER_DETECTED");
  assert.ok(reported, "an index page with a cover must report it");
  assert.equal(reported.payload.title, "Shadow Slave", "the series title must be resolved");
  assert.deepEqual([...reported.payload.tags], ["LitRPG", "Progression Fantasy"], "the page's tags must be reported");

  // 2. The worker — hand it that message exactly as the page sent it
  const storage = {};
  const chrome = makeChrome(storage);
  const { fetchStub } = makeFetch([]); // empty library: nothing matches
  const ctx = vm.createContext({ chrome, fetch: fetchStub, AbortSignal, console: silent, setTimeout, Promise });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

  chrome.listeners.message({ type: "COVER_DETECTED", payload: reported.payload }, { tab: { id: 7 } }, () => {});
  for (let i = 0; i < 10 && !storage.cover_7; i++) await tick();

  assert.equal(storage.cover_7?.type, "add", "an unknown novel must still be offered as an add");
  assert.deepEqual([...(storage.cover_7?.tags ?? [])], ["LitRPG", "Progression Fantasy"], "the add offer must carry the tags");
  assert.equal(storage.cover_7.source, "nu", "and the site they were read from");

  // 3. The popup — what the user clicks, with no refresh in between
  const popupChrome = makeChrome(storage, { badge: "+", coverPending: { ...storage.cover_7 } });
  const { calls, fetchStub: popupFetch } = makeFetch([]);
  const { el, document } = makeDom();
  const popupCtx = vm.createContext({
    chrome: popupChrome,
    document,
    window: { close() {} },
    fetch: popupFetch,
    AbortSignal,
    console: silent,
    setTimeout: (fn) => { fn(); return 0; },
    Promise,
  });
  vm.runInContext(read("popup.js"), popupCtx, { filename: "popup.js" });
  await tick();

  assert.match(el("body").innerHTML, /2 tags come with it/, "the add prompt must say what it is about to save");

  await el("btnAdd").onclick();
  await tick();

  const quickAdd = calls.find((c) => c.url.endsWith("/quick-add"));
  assert.deepEqual(quickAdd?.body, {
    title: "Shadow Slave",
    chapter_raw: "",
    tags: ["LitRPG", "Progression Fantasy"],
    source: "nu",
  }, "the first add must carry the page's tags, with no refresh");
  assertAuthed(calls, "popup.js (add with tags)");
  console.log("\u2713 a page's tags reach the app on the first add, with no refresh");
}


// ── 24. content.js: a chapter menu says how far the site has got ──────────────
{
  const location = {
    href: "https://www.royalroad.com/fiction/99/shadow-slave/chapter-3",
    hostname: "www.royalroad.com",
    pathname: "/fiction/99/shadow-slave/chapter-3",
  };
  const select = {
    options: [1, 2, 3, 4, 5].map((n) => ({ textContent: `Chapter ${n}`, value: `chapter-${n}` })),
  };

  const chrome = makeChrome({});
  const document = {
    title: "Chapter 3 - Shadow Slave | Royal Road",
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === "select" ? [select] : []),
    addEventListener: () => {},
  };

  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: () => 0,
    clearTimeout,
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  const detected = chrome.calls.messages.find((m) => m.type === "CHAPTER_DETECTED");
  assert.ok(detected, "a chapter page must still be reported");
  assert.equal(detected.payload.chapter, "Chapter 3", "the chapter being read is untouched");
  assert.deepEqual(
    { ...detected.payload.latest },
    { latest_chapter: 5, confidence: "exact" },
    "the highest option, exact only because the menu holds the chapter being read",
  );
  assert.equal(
    detected.payload.latest.total_chapters,
    undefined,
    "a menu is not a table of contents, so it carries no total",
  );
  console.log("\u2713 content.js reads the site's latest chapter off the chapter menu");
}

// ── 25. content.js: a page that says nothing reports nothing ──────────────────
{
  const location = {
    href: "https://www.royalroad.com/fiction/99/shadow-slave/chapter-3",
    hostname: "www.royalroad.com",
    pathname: "/fiction/99/shadow-slave/chapter-3",
  };

  const chrome = makeChrome({});
  const document = {
    title: "Chapter 3 - Shadow Slave | Royal Road",
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: () => 0,
    clearTimeout,
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  const detected = chrome.calls.messages.find((m) => m.type === "CHAPTER_DETECTED");
  assert.ok(detected, "the chapter itself is still worth reporting");
  assert.equal(
    detected.payload.latest,
    null,
    "no evidence must arrive as no value — a blank page is not 'up to date'",
  );
  console.log("\u2713 content.js reports no latest chapter when the page does not say");
}

// ── 26. content.js: a table of contents gives the count as well ───────────────
{
  const location = {
    href: "https://www.royalroad.com/fiction/99/shadow-slave",
    hostname: "www.royalroad.com",
    pathname: "/fiction/99/shadow-slave",
  };
  const toc = Array.from({ length: 40 }, (_, i) => ({
    tagName: "A",
    textContent: `Chapter ${i + 1}`,
    className: "",
    getAttribute: (name) => (name === "href" ? "/chapter" : null),
    hasAttribute: () => false,
  }));

  const chrome = makeChrome({});
  const document = {
    title: "Shadow Slave | Royal Road",
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === "a" ? toc : []),
    addEventListener: () => {},
  };

  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: () => 0,
    clearTimeout,
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  const metadata = chrome.calls.messages.find((m) => m.type === "METADATA_DETECTED");
  assert.ok(metadata, "an index page lists chapters, so it must report them");
  assert.deepEqual(
    { ...metadata.payload.latest },
    { latest_chapter: 40, confidence: "exact", total_chapters: 40 },
    "a list running from one is a whole table of contents: newest chapter and count",
  );
  console.log("\u2713 content.js reads the latest chapter and the total off a table of contents");
}


// ── 27. background.js: the observation rides the writes the app already takes ─
{
  const storage = { "mapping:royalroad.com:shadow slave": 5 };
  const chrome = makeChrome(storage);
  const { calls, fetchStub } = makeFetch([
    { id: 5, canonical_title: "Shadow Slave", aliases: [], current_chapter_raw: "Chapter 3" },
  ]);
  const ctx = vm.createContext({ chrome, fetch: fetchStub, AbortSignal, console: silent, setTimeout, Promise });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

  const chapterPage = (latest) => ({
    type: "CHAPTER_DETECTED",
    payload: {
      title: "Shadow Slave",
      chapter: "Chapter 3",
      url: "https://www.royalroad.com/fiction/99/shadow-slave/chapter-3",
      domain: "royalroad.com",
      latest,
    },
  });

  // A novel the user already reads: browsing a chapter is enough, no click needed
  chrome.listeners.message(
    chapterPage({ latest_chapter: 40, confidence: "exact" }),
    { tab: { id: 7 } },
    () => {},
  );
  for (let i = 0; i < 10 && !calls.some((c) => c.url.endsWith("/metadata")); i++) await tick();

  const metadata = calls.find((c) => c.url.endsWith("/metadata"));
  assert.deepEqual(
    metadata?.body,
    { novel_id: 5, latest_chapter: 40, latest_chapter_confidence: "exact" },
    "a known novel is told where the site is, silently",
  );

  // A page with nothing to say must not write anything at all
  const before = calls.filter((c) => c.url.endsWith("/metadata")).length;
  chrome.listeners.message(chapterPage(null), { tab: { id: 8 } }, () => {});
  await tick();

  assert.equal(
    calls.filter((c) => c.url.endsWith("/metadata")).length,
    before,
    "no evidence means no request, so a guess can never overwrite a good number",
  );

  // And the confirmed update carries it too, on the route the popup uses
  chrome.listeners.message(
    {
      type: "CONFIRM_UPDATE",
      payload: {
        novelId: 5,
        chapter: "Chapter 41",
        url: "https://www.royalroad.com/fiction/99/shadow-slave/chapter-41",
        domain: "royalroad.com",
        detectedTitle: "Shadow Slave",
        tabId: 9,
        latest: { latest_chapter: 41, confidence: "caught_up", total_chapters: 41 },
      },
    },
    { tab: { id: 9 } },
    () => {},
  );
  for (let i = 0; i < 10 && !calls.some((c) => c.url.endsWith("/progress")); i++) await tick();

  const progress = calls.find((c) => c.url.endsWith("/progress"));
  assert.deepEqual(
    progress?.body,
    {
      novel_id: 5,
      chapter_raw: "Chapter 41",
      source_url: "https://www.royalroad.com/fiction/99/shadow-slave/chapter-41",
      domain: "royalroad.com",
      latest_chapter: 41,
      latest_chapter_confidence: "caught_up",
      total_chapters: 41,
    },
    "the progress write carries what the page said",
  );
  assertAuthed(calls, "background.js (latest chapter)");
  console.log("\u2713 background.js passes the observation to the routes, and only when there is one");
}


// ── 28. content.js: a chapter list the page renders after load ────────────────
{
  // Royal Road logs "Loading volumes" and fills its table of contents in
  // afterwards, so one scan at document_idle sees an empty page and reports
  // nothing. The page is the user's, so looking again is allowed — the fix is not
  // to guess, it is to wait a moment and look again.
  const location = {
    href: "https://www.royalroad.com/fiction/21220/mother-of-learning",
    hostname: "www.royalroad.com",
    pathname: "/fiction/21220/mother-of-learning",
  };

  let rendered = false;
  const toc = Array.from({ length: 106 }, (_, i) => ({
    tagName: "A",
    textContent: `Chapter ${i + 1}: A Chapter Title Long Enough To Matter`,
    className: "",
    getAttribute: (name) => (name === "href" ? "/chapter" : null),
    hasAttribute: () => false,
  }));

  const chrome = makeChrome({});
  const document = {
    title: "Mother of Learning | Royal Road",
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === "a" && rendered ? toc : []),
    addEventListener: () => {},
  };

  const timers = [];
  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: (fn) => timers.push(fn) - 1,
    clearTimeout: () => {},
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  assert.equal(
    chrome.calls.messages.filter((m) => m.type === "METADATA_DETECTED").length,
    0,
    "an empty page must not be reported as anything at all",
  );

  // The site finishes drawing the list
  rendered = true;
  while (timers.length > 0) {
    const fn = timers.shift();
    if (fn) fn();
  }

  const metadata = chrome.calls.messages.find((m) => m.type === "METADATA_DETECTED");
  assert.ok(metadata, "a list that appears late must still be reported");
  assert.deepEqual(
    { ...metadata.payload.latest },
    { latest_chapter: 106, confidence: "exact", total_chapters: 106 },
    "and it reads as a whole table of contents, long chapter titles included",
  );
  console.log("\u2713 content.js waits for a chapter list the page renders late");
}


// ── 29. content.js: Royal Road's real table of contents ───────────────────────
{
  const fixture = path.join(dir, "..", "royalroaddom.txt");
  if (existsSync(fixture)) {
    const html = readFileSync(fixture, "utf8");
    const anchors = [...html.matchAll(/<a[^>]*href="([^"]*chapter\/[^"]*)"[^>]*>([\s\S]{0,60}?)<\/a>/g)].map(
      (m) => ({
        tagName: "A",
        textContent: m[2].replace(/\s+/g, " ").trim(),
        className: "",
        getAttribute: (name) => (name === "href" ? m[1] : null),
        hasAttribute: () => false,
      }),
    );

    assert.ok(anchors.length > 50, "the fixture should carry the whole chapter list");

    const location = {
      href: "https://www.royalroad.com/fiction/21220/mother-of-learning",
      hostname: "www.royalroad.com",
      pathname: "/fiction/21220/mother-of-learning",
    };
    const chrome = makeChrome({});
    const document = {
      title: "Mother of Learning | Royal Road",
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === "a" ? anchors : []),
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

    const metadata = chrome.calls.messages.find((m) => m.type === "METADATA_DETECTED");
    assert.ok(metadata, "the real page must report its chapter list");
    assert.deepEqual(
      { ...metadata.payload.latest },
      { latest_chapter: 100, confidence: "exact", total_chapters: 100 },
      "Royal Road writes \"1. Good Morning Brother\", so the numbered text and the URL both have to be read — and its unnumbered Afterword link must stay out",
    );
    console.log("\u2713 content.js reads Royal Road's own table of contents");
  } else {
    console.log("\u2013 skipped Royal Road fixture check (royalroaddom.txt not present)");
  }
}

// ── 30. content.js: a stub list the page later replaces ───────────────────────
{
  // What Mother of Learning served up first: a handful of chapters, then "Loading
  // volumes" replaced them with all 100. A single scan reports the stub, and it
  // passes every shape check — that is exactly how it fooled the first version.
  const entry = (number) => ({
    tagName: "A",
    textContent: `${number}. Chapter ${number}`,
    className: "",
    getAttribute: (name) =>
      name === "href" ? `/fiction/21220/mother-of-learning/chapter/30177${number}/${number}-chapter-${number}` : null,
    hasAttribute: () => false,
  });
  const stub = [1, 2, 3, 4, 5].map(entry);
  const full = Array.from({ length: 100 }, (_, i) => entry(i + 1));

  let rendered = false;
  const location = {
    href: "https://www.royalroad.com/fiction/21220/mother-of-learning",
    hostname: "www.royalroad.com",
    pathname: "/fiction/21220/mother-of-learning",
  };
  const chrome = makeChrome({});
  const document = {
    title: "Mother of Learning | Royal Road",
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === "a" && rendered ? full : sel === "a" ? stub : []),
    addEventListener: () => {},
  };

  const timers = [];
  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: (fn) => timers.push(fn) - 1,
    clearTimeout: () => {},
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  const sent = () => chrome.calls.messages.filter((m) => m.type === "METADATA_DETECTED");
  assert.deepEqual(
    { ...sent()[0]?.payload.latest },
    { latest_chapter: 5, confidence: "exact", total_chapters: 5 },
    "the stub reads as a complete list — five chapters running up from one",
  );

  // The site finishes drawing the real list
  rendered = true;
  while (timers.length > 0) {
    const fn = timers.shift();
    if (fn) fn();
  }

  assert.equal(sent().length, 2, "the fuller list must be reported as well");
  assert.deepEqual(
    { ...sent()[1].payload.latest },
    { latest_chapter: 100, confidence: "exact", total_chapters: 100 },
    "and it must carry the real numbers, because the app only ever raises these",
  );
  console.log("\u2713 content.js reports a fuller chapter list over the stub it was served first");
}


// ── 31. content.js: NovelUpdates is a database, not a chapter list ────────────
{
  // Its releases read "c273" (another group's numbering), its "Status in COO" is the
  // original's length, and its own reviews carry "Status: c140". None of those can be
  // compared with the chapter number you read on the site you actually read on, and
  // the app only ever raises that number, so a wrong one would stick.
  const anchor = (text, href) => ({
    tagName: "A",
    textContent: text,
    className: "",
    getAttribute: (name) => (name === "href" ? href : null),
    hasAttribute: () => false,
  });
  const page = [
    anchor("c273", "https://kjtranslations.com/semi-coercive-imperialist/chapter-273"),
    anchor("c272", "https://kjtranslations.com/semi-coercive-imperialist/chapter-272"),
    anchor("Status: c140", "https://www.novelupdates.com/review/1234"),
  ];
  const tags = [{ textContent: "Action" }, { textContent: " Drama " }];

  const location = {
    href: "https://www.novelupdates.com/series/semi-coercive-imperialist/",
    hostname: "www.novelupdates.com",
    pathname: "/series/semi-coercive-imperialist/",
  };
  const chrome = makeChrome({});
  const document = {
    title: "Semi-Coercive Imperialist - Novel Updates",
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes("showtag") ? tags : sel === "a" ? page : []),
    addEventListener: () => {},
  };

  const timers = [];
  const ctx = vm.createContext({
    chrome,
    document,
    window: { location },
    setTimeout: (fn) => timers.push(fn) - 1,
    clearTimeout: () => {},
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  const metadata = chrome.calls.messages.find((m) => m.type === "METADATA_DETECTED");
  assert.ok(metadata, "NovelUpdates' own job — tags — must still ride along");
  assert.deepEqual([...metadata.payload.tags], ["Action", "Drama"], "the page's tags are reported");
  assert.equal(
    metadata.payload.latest,
    null,
    "another group's release numbers are not this novel's chapter count",
  );
  assert.equal(
    timers.filter(Boolean).length,
    1,
    "only the cover check is pending: there is no chapter list here to wait for",
  );
  console.log("\u2713 content.js takes NovelUpdates' tags and leaves its chapter numbers alone");
}


// ── 32. content.js: NovelUpdates' release table, offered not written ──────────
{
  const fixture = path.join(dir, "..", "novelupdate.txt");
  if (existsSync(fixture)) {
    const html = readFileSync(fixture, "utf8");
    // Each row is "date | group | release", with the release as a.chp-release.
    // Attribute order is whatever the site felt like, so the title is read out of
    // the matched tag rather than assumed.
    const rows = [
      ...html.matchAll(
        /<a href="https:\/\/www\.novelupdates\.com\/group\/[^"]*">([^<]{1,60})<\/a>[\s\S]{0,400}?(<a[^>]*class="chp-release"[^>]*>)/g,
      ),
    ]
      .map((m) => ({ group: m[1].trim(), token: m[2].match(/title="([^"]+)"/)?.[1] }))
      .filter((row) => row.token);

    assert.ok(rows.length > 5, "the fixture should carry the release window");

    const anchors = rows.map(({ group, token }) => ({
      tagName: "A",
      textContent: token,
      className: "chp-release",
      getAttribute: (name) => (name === "href" ? "//www.novelupdates.com/extnu/1/" : null),
      hasAttribute: () => false,
      // The group sits in the middle cell of the same row
      closest: (sel) =>
        sel === "tr" ? { querySelector: (s) => (s.includes("nth-child(2)") ? { textContent: group } : null) } : null,
    }));

    const location = {
      href: "https://www.novelupdates.com/series/semi-coercive-imperialist/",
      hostname: "www.novelupdates.com",
      pathname: "/series/semi-coercive-imperialist/",
    };
    const chrome = makeChrome({});
    const document = {
      title: "Semi-Coercive Imperialist - Novel Updates",
      // The series page carries its own title element, which is what resolves first
      querySelector: (sel) => (sel.includes("seriestitlenu") ? { textContent: "Semi-Coercive Imperialist" } : null),
      querySelectorAll: (sel) => (sel === "a.chp-release" ? anchors : []),
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

    const offer = chrome.calls.messages.find((m) => m.type === "NU_RELEASE_DETECTED");
    assert.ok(offer, "the release table must be offered to the popup");
    assert.deepEqual(
      { ...offer.payload },
      {
        title: "Semi-Coercive Imperialist",
        latest_chapter: 273,
        confidence: "lower_bound",
        token: "c273",
        group: "KJ Translations",
      },
      "the newest release and its group, and never as anything stronger than a lower bound",
    );
    assert.equal(
      chrome.calls.messages.filter((m) => m.type === "METADATA_DETECTED").length,
      0,
      "nothing is written from the page — this is an offer",
    );
    console.log("\u2713 content.js offers NovelUpdates' newest release instead of writing it");
  } else {
    console.log("\u2013 skipped NovelUpdates release check (novelupdate.txt not present)");
  }
}


// ── 33. popup.js: NU's release is offered, and only written when confirmed ────
{
  const release = {
    title: "Semi-Coercive Imperialist",
    latest_chapter: 273,
    confidence: "lower_bound",
    token: "c273",
    group: "KJ Translations",
  };
  const cover = {
    type: "cover",
    novelId: 5,
    coverUrl: "https://cdn.novelupdates.com/images/2025/12/SemiCoercive-Imperialist.jpg",
    tabId: 7,
  };

  const chrome = makeChrome({}, { badge: "+", coverPending: cover, nuRelease: release });
  const { el, document } = makeDom();
  // close() is handed to setTimeout unbound, the way the popup does it, so it must not
  // depend on its receiver
  let closed = false;
  const window = { get closed() { return closed; }, close() { closed = true; } };

  const ctx = vm.createContext({
    chrome,
    document,
    window,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    AbortSignal,
    console: silent,
    setTimeout: (fn) => { fn(); return 0; },
    Promise,
  });
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  await tick();

  assert.match(el("body").innerHTML, /NovelUpdates' newest release/, "the offer must be shown");
  assert.match(el("body").innerHTML, /KJ Translations/, "and say whose numbering it is");
  assert.match(el("body").innerHTML, /c273/, "and what the number is");
  assert.equal(
    chrome.calls.messages.filter((m) => m.type === "USE_NU_RELEASE").length,
    0,
    "showing it must not write it",
  );

  await el("btnUseNuRelease").onclick();
  await tick();

  const sent = chrome.calls.messages.find((m) => m.type === "USE_NU_RELEASE");
  assert.deepEqual({ ...sent?.payload }, release, "confirming sends exactly what was offered");
  assert.match(el("releaseCard").innerHTML, /recorded/, "and the popup says it landed");
  assert.equal(window.closed, true, "and then it gets out of the way");
  console.log("\u2713 popup.js offers NovelUpdates' newest release, writes on confirmation, and closes");
}

// ── 34. background.js: the confirmed release goes in as a lower bound ─────────
{
  const storage = {};
  const chrome = makeChrome(storage);
  const { calls, fetchStub } = makeFetch([
    { id: 5, canonical_title: "Semi-Coercive Imperialist", aliases: [], current_chapter_raw: "Chapter 10" },
  ]);
  const ctx = vm.createContext({ chrome, fetch: fetchStub, AbortSignal, console: silent, setTimeout, Promise });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

  // The page offered it — remembered for the popup, and nothing written
  chrome.listeners.message(
    {
      type: "NU_RELEASE_DETECTED",
      payload: {
        title: "Semi-Coercive Imperialist",
        latest_chapter: 273,
        confidence: "lower_bound",
        token: "c273",
        group: "KJ Translations",
      },
    },
    { tab: { id: 7 } },
    () => {},
  );
  await tick();

  assert.ok(storage["nu_release_7"], "the offer is remembered for the popup");
  assert.equal(calls.filter((c) => c.url.endsWith("/metadata")).length, 0, "and nothing is written yet");

  let answer = null;
  chrome.listeners.message(
    { type: "USE_NU_RELEASE", payload: storage["nu_release_7"] },
    { tab: { id: 7 } },
    (r) => { answer = r; },
  );
  for (let i = 0; i < 10 && !calls.some((c) => c.url.endsWith("/metadata")); i++) await tick();

  const metadata = calls.find((c) => c.url.endsWith("/metadata"));
  assert.deepEqual(
    metadata?.body,
    { novel_id: 5, latest_chapter: 273, latest_chapter_confidence: "lower_bound" },
    "the confirmed number, and never as an exact read",
  );
  assert.equal(answer?.ok, true, "the popup is told it landed");
  assert.equal(storage["nu_release_7"], undefined, "and the offer is cleared once used");
  assertAuthed(calls, "background.js (NU release)");
  console.log("\u2713 background.js writes the confirmed release as a lower bound, once");
}


// ── 35. content.js: page numbers are not chapters ─────────────────────────────
{
  // Live report: NovelUpdates' own review-page links read "1", "2", "3", and the
  // bare-number rule a chapter *menu* needs ("41") turned that furniture into a
  // three-chapter table of contents — reported as an exact read. It also won the
  // branch, so the release offer below never ran.
  const furniture = [1, 2, 3].map((n) => ({
    tagName: "A",
    textContent: `${n}`,
    className: "",
    getAttribute: (name) =>
      name === "href" ? `https://www.royalroad.com/fiction/9/shadow-slave/?page=${n}` : null,
    hasAttribute: () => false,
  }));

  const load = (links, title) => {
    const timers = [];
    const chrome = makeChrome({});
    const ctx = vm.createContext({
      chrome,
      document: {
        title,
        querySelector: () => null,
        querySelectorAll: (sel) => (sel === "a" ? links : []),
        addEventListener: () => {},
      },
      window: {
        location: {
          href: "https://www.royalroad.com/fiction/9/shadow-slave",
          hostname: "www.royalroad.com",
          pathname: "/fiction/9/shadow-slave",
        },
      },
      setTimeout: (fn) => timers.push(fn) - 1,
      clearTimeout: () => {},
      console: silent,
    });
    vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

    // Everything the page queued, the cover look and the late rescans included
    while (timers.length > 0) {
      const fn = timers.shift();
      if (fn) fn();
    }
    return chrome.calls.messages;
  };

  assert.equal(
    load(furniture, "Shadow Slave | Royal Road").length,
    0,
    "three page links must not read as a chapter list",
  );

  // The other direction still has to work: Royal Road numbers the chapter in the URL,
  // so a link whose text is only "4" is a chapter there
  const realChapters = [
    { n: 3, slug: "chapter/122/3-the-other" },
    { n: 4, slug: "chapter/123/4-the-title" },
  ].map(({ n, slug }) => ({
    tagName: "A",
    textContent: `${n}`,
    className: "",
    getAttribute: (name) => (name === "href" ? `/fiction/9/shadow-slave/${slug}` : null),
    hasAttribute: () => false,
  }));

  const reported = load(realChapters, "Shadow Slave | Royal Road").find(
    (m) => m.type === "METADATA_DETECTED",
  );
  assert.deepEqual(
    { ...reported?.payload?.latest },
    { latest_chapter: 4, confidence: "exact" },
    "a link the URL marks as a chapter is still read, bare number or not",
  );
  console.log("\u2713 content.js only reads numbers the page links as chapters");
}


// ── 36. content.js: NovelUpdates' page furniture is never a chapter list ──────
{
  // The other half of the same report: on the failing page the release table was
  // never even looked at, because the ToC branch had already returned a number.
  const furniture = [
    ...[1, 2, 3].map((n) => ({
      tagName: "A",
      textContent: `${n}`,
      className: "",
      getAttribute: (name) =>
        name === "href" ? `//www.novelupdates.com/series/i-was-betrayed/?page=${n}&sort=date` : null,
      hasAttribute: () => false,
    })),
    // Even a chapter-shaped link is furniture here: NU lists other sites' chapters
    {
      tagName: "A",
      textContent: "2",
      className: "",
      getAttribute: (name) => (name === "href" ? "https://other-site.com/chapter/7/2-x" : null),
      hasAttribute: () => false,
    },
  ];

  const releases = [
    { token: "c272", group: "Some Other Group" },
    { token: "c273", group: "KJ Translations" },
  ].map(({ token, group }) => ({
    tagName: "A",
    textContent: token,
    className: "chp-release",
    getAttribute: () => "//www.novelupdates.com/extnu/1/",
    hasAttribute: () => false,
    closest: (sel) =>
      sel === "tr"
        ? { querySelector: (s) => (s.includes("nth-child(2)") ? { textContent: group } : null) }
        : null,
  }));

  const title =
    "I Was Betrayed by a Childhood Friend I Liked and a Junior Who Loved Me, so I Became Distrustful of Women";
  const slug =
    "/series/i-was-betrayed-by-a-childhood-friend-i-liked-and-a-junior-who-loved-me-so-i-became-distrustful-of-women/";

  const timers = [];
  const chrome = makeChrome({});
  const ctx = vm.createContext({
    chrome,
    document: {
      title: `${title} - Novel Updates`,
      querySelector: (sel) => (sel.includes("seriestitlenu") ? { textContent: title } : null),
      querySelectorAll: (sel) => (sel === "a" ? furniture : sel === "a.chp-release" ? releases : []),
      addEventListener: () => {},
    },
    window: {
      location: {
        href: `https://www.novelupdates.com${slug}`,
        hostname: "www.novelupdates.com",
        pathname: slug,
      },
    },
    setTimeout: (fn) => timers.push(fn) - 1,
    clearTimeout: () => {},
    console: silent,
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  assert.equal(
    chrome.calls.messages.filter((m) => m.type === "METADATA_DETECTED").length,
    0,
    "NU's page furniture must never be written as a chapter count",
  );

  const offer = chrome.calls.messages.find((m) => m.type === "NU_RELEASE_DETECTED");
  assert.ok(offer, "and the release table must still be offered");
  assert.deepEqual(
    { ...offer.payload },
    {
      title,
      latest_chapter: 273,
      confidence: "lower_bound",
      token: "c273",
      group: "KJ Translations",
    },
    "the newest release and its group, unchanged by the furniture around it",
  );
  console.log("\u2713 content.js reads NovelUpdates' release table, not its page furniture");
}


// ── 37. content.js: a placeholder image is never offered as a cover ───────────
{
  // NovelUpdates answers "no cover" with /img/noimagefound.jpg, and that URL is
  // exactly what the popup offered to save — a broken cover in the library.
  const placeholder = { src: "https://www.novelupdates.com/img/noimagefound.jpg" };
  const logs = [];
  const timers = [];
  const chrome = makeChrome({});

  const ctx = vm.createContext({
    chrome,
    document: {
      title: "No Cover Novel - Novel Updates",
      querySelector: (sel) => (sel.includes("serieseditimg") ? placeholder : null),
      querySelectorAll: (sel) => (sel === "img" ? [placeholder] : []),
      addEventListener: () => {},
    },
    window: {
      location: {
        href: "https://www.novelupdates.com/series/no-cover-novel/",
        hostname: "www.novelupdates.com",
        pathname: "/series/no-cover-novel/",
      },
    },
    setTimeout: (fn) => timers.push(fn) - 1,
    clearTimeout: () => {},
    console: { log: (...a) => logs.push(a.join(" ")), error: () => {}, warn: () => {} },
  });
  vm.runInContext(read("content.js"), ctx, { filename: "content.js" });

  while (timers.length > 0) {
    const fn = timers.shift();
    if (fn) fn();
  }

  assert.equal(
    chrome.calls.messages.filter((m) => m.type === "COVER_DETECTED").length,
    0,
    "a placeholder must not be offered as a cover",
  );
  assert.ok(
    logs.some((line) => line.includes("placeholder")),
    "and the console must say why the page's image was passed over",
  );
  console.log("\u2713 content.js ignores a site's \"no cover\" placeholder");
}


// ── 38. popup.js: every offer is its own card, and Done is below all of them ──
{
  // The complaint: the way out sat between the offers, so the release number was
  // offered *underneath* it. One footer, always last, and one card per offer.
  const saved = { novelTitle: "Shadow Slave", count: 61 };
  const cover = {
    type: "cover",
    novelId: 5,
    novelTitle: "Shadow Slave",
    coverUrl: "https://cdn.novelupdates.com/images/cover.jpg",
    replacesCover: true,
    tabId: 7,
  };
  const release = {
    title: "Shadow Slave",
    latest_chapter: 273,
    confidence: "lower_bound",
    token: "c273",
    group: "KJ Translations",
  };

  const chrome = makeChrome({}, { badge: "+", coverPending: cover, nuSaved: saved, nuRelease: release });
  const { el, document } = makeDom();
  const ctx = vm.createContext({
    chrome,
    document,
    window: { close() {} },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    AbortSignal,
    console: silent,
    setTimeout: (fn) => { fn(); return 0; },
    Promise,
  });
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  await tick();

  const html = el("body").innerHTML;
  const at = (needle) => {
    const i = html.indexOf(needle);
    assert.ok(i >= 0, `the popup is missing ${needle}`);
    return i;
  };

  assert.ok(at("btnSaveCover") < at("btnUseNuRelease"), "the cover offer must come first");
  assert.ok(at("btnUseNuRelease") < at("btnDone"), "Done must be below every offer, not between them");
  assert.match(html, /A different image from the one in your library/, "the cover card must say why it is offered");
  assert.equal((html.match(/class="card"/g) || []).length, 3, "two offers and the footer, each its own card");
  console.log("\u2713 popup.js stacks its offers and puts Done under all of them");
}

// ── 39. background.js: a cover the library already has is not offered ────────
{
  const coverUrl = "https://cdn.novelupdates.com/images/cover.jpg";
  const novels = [{
    id: 5,
    canonical_title: "Shadow Slave",
    aliases: [],
    current_chapter_raw: "Chapter 12",
    cover_url: coverUrl,
  }];

  const storage = {};
  const chrome = makeChrome(storage);
  const { calls, fetchStub } = makeFetch(novels);
  const ctx = vm.createContext({ chrome, fetch: fetchStub, AbortSignal, console: silent, setTimeout, Promise });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });

  await ctx.handleCoverDetection({ title: "Shadow Slave", coverUrl, domain: "novelupdates.com", tabId: 7 });

  assert.equal(storage.cover_7, undefined, "the image the novel already has must not be offered");
  assert.equal(chrome.calls.badge.length, 0, "and it must not raise a badge for nothing");

  // A different image on the same novel is still offered, and says which case it is
  const other = "https://cdn.novelupdates.com/images/2026/01/shadow-slave-new.jpg";
  await ctx.handleCoverDetection({ title: "Shadow Slave", coverUrl: other, domain: "novelupdates.com", tabId: 7 });

  assert.equal(storage.cover_7?.coverUrl, other, "an image that differs is still worth offering");
  assert.equal(storage.cover_7?.replacesCover, true, "and it replaces one that exists");
  assert.ok(chrome.calls.badge.includes("+"), "which the badge announces");
  console.log("\u2713 background.js only offers a cover the library doesn't already have");
}

// ── 40. popup.js: a page that only filed tags still says so ──────────────────
{
  // Tags are filed silently and need no confirmation, so they set no badge — but the
  // popup is where the user asks what happened, so it answers instead of claiming
  // there was nothing on the page.
  const saved = { novelTitle: "Shadow Slave", count: 61 };
  const chrome = makeChrome({}, { badge: "", nuSaved: saved });
  const { el, document } = makeDom();
  const ctx = vm.createContext({
    chrome,
    document,
    window: { close() {} },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    AbortSignal,
    console: silent,
    setTimeout: (fn) => { fn(); return 0; },
    Promise,
  });
  vm.runInContext(read("popup.js"), ctx, { filename: "popup.js" });
  await tick();

  assert.match(el("body").innerHTML, /61 tags filed/, "a tags-only page must name what it filed");
  assert.equal(typeof el("btnDone").onclick, "function", "with the same one way out");
  assert.ok(!/No chapter detected/.test(el("body").innerHTML), "and must not claim there was nothing");
  console.log("\u2713 popup.js still reports a page that only filed tags");
}


console.log("\nAll extension self-checks passed.");
