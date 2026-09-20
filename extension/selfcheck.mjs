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
  return {
    calls,
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
      onRemoved: { addListener() {} },
    },
    action: {
      getBadgeText: async () => badge,
      setBadgeText: async (o) => calls.badge.push(o.text),
      setBadgeBackgroundColor: async () => {},
    },
  };
}

// fetch stub — records every call, serves /status and /novels, ok+id for writes
function makeFetch(novels) {
  const calls = [];
  const fetchStub = async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.endsWith("/status")) return { ok: true, json: async () => ({ running: true }) };
    if (url.endsWith("/novels")) return { ok: true, json: async () => novels };
    return { ok: true, json: async () => ({ ok: true, id: 42 }) };
  };
  return { calls, fetchStub };
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
  const { fetchStub } = makeFetch(novels);
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

  const nodes = new Map();
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: "", className: "", dataset: {}, onclick: null });
    return nodes.get(id);
  };
  const document = { getElementById: el, querySelectorAll: () => [] };
  const window = { close() {} };

  const ctx = vm.createContext({ chrome, document, window, fetch: fetchStub, AbortSignal, console: silent, setTimeout: () => {}, Promise });
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
  console.log("\u2713 popup.js adds the novel, saves its cover and caches the mapping");
}

// ── 4. selector guard: NovelUpdates markup matches what content.js looks for ──
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

