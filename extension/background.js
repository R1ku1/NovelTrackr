const API = "http://127.0.0.1:39172";

// The app's local server rejects anything without this header. It is not
// CORS-safelisted, so no other website can reach the API without a preflight
// that the server's CORS headers never satisfy.
const API_HEADERS = { "Content-Type": "application/json", "X-Noveltrackr": "1" };

console.log("[Noveltrackr] background service worker started");

// ── Storage helpers — keyed by tabId ─────────────────────────────────────────
async function setPending(tabId, data) {
  await chrome.storage.local.set({ [`pending_${tabId}`]: data });
}

async function getPending(tabId) {
  const result = await chrome.storage.local.get(`pending_${tabId}`);
  return result[`pending_${tabId}`] || null;
}

async function clearPending(tabId) {
  await chrome.storage.local.remove(`pending_${tabId}`);
  chrome.action.setBadgeText({ text: "", tabId });
}

async function setCoverPending(tabId, data) {
  await chrome.storage.local.set({ [`cover_${tabId}`]: data });
}

async function getCoverPending(tabId) {
  const result = await chrome.storage.local.get(`cover_${tabId}`);
  return result[`cover_${tabId}`] || null;
}

async function clearCoverPending(tabId) {
  await chrome.storage.local.remove(`cover_${tabId}`);
  chrome.action.setBadgeText({ text: "", tabId });
}

// ── NU search state ──────────────────────────────────────────────────────────
// Keyed by tab while the user is choosing, then by series URL once chosen, so
// the choice survives the navigation that loads the series page.
async function setNuPending(tabId, data) {
  await chrome.storage.local.set({ [`nu_${tabId}`]: data });
}

async function getNuPending(tabId) {
  const result = await chrome.storage.local.get(`nu_${tabId}`);
  return result[`nu_${tabId}`] || null;
}

async function clearNuPending(tabId) {
  await chrome.storage.local.remove(`nu_${tabId}`);
  chrome.action.setBadgeText({ text: "", tabId });
}

// NU's newest release, offered to the user rather than written: it belongs to one
// group's numbering, so the popup asks before the app is told anything
async function setNuRelease(tabId, data) {
  await chrome.storage.local.set({ [`nu_release_${tabId}`]: data });
}

async function getNuRelease(tabId) {
  const result = await chrome.storage.local.get(`nu_release_${tabId}`);
  return result[`nu_release_${tabId}`] || null;
}

async function clearNuRelease(tabId) {
  await chrome.storage.local.remove(`nu_release_${tabId}`);
}

async function getNuSeriesNovel(url) {
  if (!url) return null;
  const result = await chrome.storage.local.get(`nu_match:${url}`);
  return result[`nu_match:${url}`] ?? null;
}

// What the NU flow captured for this tab, so the popup can say so instead of
// offering an unrelated action
async function setNuSaved(tabId, data) {
  await chrome.storage.local.set({ [`nu_saved_${tabId}`]: data });
}

async function getNuSaved(tabId) {
  const result = await chrome.storage.local.get(`nu_saved_${tabId}`);
  return result[`nu_saved_${tabId}`] || null;
}

/// Same image, not merely a similar one: any difference at all is offered, so the
/// extension never skips a cover on a guess. A novel with no cover (the app stores
/// an empty string for one) always gets the offer.
function sameCover(current, detected) {
  if (!current || !detected) return false;
  return String(current).trim() === String(detected).trim();
}

async function handleCoverDetection({ title, coverUrl, url, domain, tabId, author, tags, source }) {
  const running = await isAppRunning();
  if (!running) return;

  // Only what the page actually offered — missing keys stay missing, so the
  // popup can tell "nothing detected" from an empty value
  const meta = tags?.length ? { author, tags, source } : author ? { author } : {};

  try {
    const novels = await getNovels();
    const linked = await novelLinkedTo(url, novels);
    const matches = linked ? [linked] : findMatches(title, novels);

    if (matches.length === 0) {
      // Not in the library — offer to add it (cover included) instead
      await setCoverPending(tabId, {
        title,
        coverUrl,
        url,
        domain,
        ...meta,
        type: "add",
        tabId,
      });

      chrome.action.setBadgeText({ text: "+", tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#a78bfa", tabId });
      return;
    }

    // The page's image is the one this novel already has: nothing to offer. Anything
    // else the page carried — tags, a release — is reported on its own.
    if (sameCover(matches[0].cover_url, coverUrl)) return;

    await setCoverPending(tabId, {
      title,
      coverUrl,
      url,
      domain,
      ...meta,
      novelId: matches[0].id,
      novelTitle: matches[0].canonical_title,
      // So the popup can say which of the two reasons this offer exists: an image
      // that differs from the stored one, or a novel that has none yet
      replacesCover: Boolean(matches[0].cover_url),
      type: "cover",
      tabId,
    });

    chrome.action.setBadgeText({ text: "+", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#a78bfa", tabId });
  } catch (e) {
    console.error("[Noveltrackr] handleCoverDetection failed:", e);
  }
}

// ── Tag vocabulary ───────────────────────────────────────────────────────────
// NU's own tag names are the canonical list (plan §4.2.2), so they are what the
// app normalises every other site's spelling against. Silent on purpose: the app
// shows how many tags it knows, which is the feedback that the capture worked.
async function postVocabulary(tags) {
  if (!tags || tags.length === 0) return;

  const running = await isAppRunning();
  if (!running) return;

  try {
    const res = await fetch(`${API}/tag-vocabulary`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({ tags }),
    });

    if (!res.ok) {
      console.error("[Noveltrackr] vocabulary write rejected:", await res.text());
      return;
    }
  } catch (e) {
    console.error("[Noveltrackr] postVocabulary failed:", e);
  }
}

// ── NovelUpdates search: the user picks the series ───────────────────────────
// The app opened NU's search for a novel it tracks. Match the query back to the
// library, then let the user say which result is the right series (plan §4.2.1).
async function handleNuSearch({ query, candidates, tabId }) {
  if (!query || !candidates || candidates.length === 0 || !tabId) return;

  const running = await isAppRunning();
  if (!running) return;

  try {
    const novels = await getNovels();
    const matches = findMatches(query, novels);
    if (matches.length === 0) return;

    await setNuPending(tabId, {
      novelId: matches[0].id,
      novelTitle: matches[0].canonical_title,
      query,
      candidates,
      tabId,
    });

    chrome.action.setBadgeText({ text: "?", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#60a5fa", tabId });
  } catch (e) {
    console.error("[Noveltrackr] handleNuSearch failed:", e);
  }
}

/// Remembers which novel the chosen series belongs to, then opens it so the
/// page's tags come back through the normal metadata path
async function handleNuConfirm(tabId, candidateUrl) {
  const pending = await getNuPending(tabId);
  if (!pending || !candidateUrl) return { error: "no_pending" };

  await chrome.storage.local.set({ [`nu_match:${candidateUrl}`]: pending.novelId });
  await clearNuPending(tabId);

  try {
    await chrome.tabs.update(tabId, { url: candidateUrl });
  } catch (e) {
    console.error("[Noveltrackr] could not open the series page:", e);
    return { error: "open_failed" };
  }

  return { ok: true };
}

// ── Metadata from a page we already track ─────────────────────────────────────
// Silent on purpose: no badge, no prompt. The page is evidence for a novel the
// user already has; if it isn't in the library, the cover flow offers to add it.
// The app fills only empty fields, so this can never overwrite a manual edit.
async function handleMetadataDetection({ title, author, tags, source, url, tabId, latest }) {
  const hasTags = Boolean(tags && tags.length);
  const observed = latestFields(latest);

  // Nothing to say about this page at all — no author, no tags, no count
  if (!author && !hasTags && Object.keys(observed).length === 0) return;

  const running = await isAppRunning();
  if (!running) return;

  try {
    const novels = await getNovels();
    const matches = findMatches(title, novels);
    // The series the user picked in the NU flow, then a page linked by hand by its
    // address, then a fuzzy title match
    const confirmed = await getNuSeriesNovel(url);
    const novelId = confirmed
      ?? (await novelLinkedTo(url, novels))?.id
      ?? matches[0]?.id
      ?? null;

    if (!novelId) return;

    const res = await fetch(`${API}/metadata`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        novel_id: novelId,
        author,
        tags: hasTags ? tags : null,
        source: hasTags ? source : null,
        ...observed,
      }),
    });

    if (!res.ok) {
      console.error("[Noveltrackr] metadata write rejected:", await res.text());
      return;
    }

    // The one log that answers "the page detected it, so why is my library
    // unchanged?" — service worker console, not the page's
    console.log("[Noveltrackr] page reported to the app:", {
      novel: matches[0]?.canonical_title ?? title,
      author: author ?? null,
      tags: hasTags ? tags.length : 0,
      ...observed,
    });

    // The popup reports what the NU flow captured, so a cover offer on the same
    // page is not the only thing the user sees
    if (source === "nu" && tabId && hasTags) {
      await setNuSaved(tabId, { novelTitle: title, count: tags.length });
    }

    // NU tag names are canonical, so a series page also teaches the vocabulary
    if (source === "nu") await postVocabulary(tags);
  } catch (e) {
    console.error("[Noveltrackr] handleMetadataDetection failed:", e);
  }
}

// ── NovelUpdates releases, on the user's say-so ───────────────────────────────
// The page offered NU's newest release. It is one group's numbering, so it is
// written only when the user confirms it in the popup, and then as a lower bound:
// it can raise the app's number but never weaken or lower it, and the app ignores
// anything below the chapter they have already read.
async function useNuRelease({ title, latest_chapter, tabId }) {
  const running = await isAppRunning();
  if (!running) return { error: "app_not_running" };

  try {
    const novels = await getNovels();
    const matches = findMatches(title, novels);
    const novelId = matches[0]?.id ?? null;
    if (!novelId) return { error: "not_in_library" };

    const res = await fetch(`${API}/metadata`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        novel_id: novelId,
        latest_chapter,
        latest_chapter_confidence: "lower_bound",
      }),
    });

    if (!res.ok) return { error: await res.text() };

    if (tabId) await clearNuRelease(tabId);

    const novelTitle = matches[0]?.canonical_title ?? title;
    return { ok: true, title: novelTitle };
  } catch (e) {
    return { error: e.message };
  }
}

// ── App check ─────────────────────────────────────────────────────────────────
async function isAppRunning() {
  try {
    const res = await fetch(`${API}/status`, { headers: API_HEADERS, signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getNovels() {
  const res = await fetch(`${API}/novels`, { headers: API_HEADERS });
  return res.json();
}

// ── Fuzzy matching ────────────────────────────────────────────────────────────
function normalise(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => 
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i-1] === b[j-1]) {
        dp[i][j] = dp[i-1][j-1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - (dist / maxLen);
}

function findMatches(detectedTitle, novels) {
  return novels
    .map(n => {
      const titleScore = similarity(detectedTitle, n.canonical_title);
      const aliasScore = n.aliases.length
        ? Math.max(...n.aliases.map(a => similarity(detectedTitle, a)))
        : 0;
      return { novel: n, score: Math.max(titleScore, aliasScore) };
    })
    .filter(({ score }) => score >= 0.75)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ novel }) => novel);
}

// ── Mapping cache ─────────────────────────────────────────────────────────────
async function getKnownMapping(domain, detectedTitle) {
  const key = `mapping:${domain}:${normalise(detectedTitle)}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

async function saveLocalMapping(domain, detectedTitle, novelId) {
  const key = `mapping:${domain}:${normalise(detectedTitle)}`;
  await chrome.storage.local.set({ [key]: novelId });
}

// ── The page's address as a key ───────────────────────────────────────────────
// A site that draws its novel name in JavaScript leaves nothing to match on — but its
// addresses still name the novel, so a page the user identified by hand is remembered
// against the address with the chapter cut out of it. Both ends of that cut matter:
// cut too little and every novel on the site shares one link, cut too much and the
// next chapter of the same novel misses it and the user is asked all over again.
//
// The cut is the first path segment that names a chapter ("chapter-12.html", a bare
// "/chapter/" whose id follows), or a last segment that is nothing but the chapter
// number the page reported. Query parameters holding that number go with it. A URL
// that keeps nothing names only the site, so it gets no link at all rather than a
// link that would claim every novel on it.
//
// ponytail: the fragment is dropped whole. A reader that keeps its route in the hash
// ("/reader#/novel/x/chapter/5") is scoped to "/reader"; the popup names the address
// it saved, and the upgrade is to run these same segment rules over the hash.
const SCOPE_PREFIX = "url:";
const CHAPTER_WORD = /^(?:chapter|chap|ch|episode|ep)s?$/i;
const CHAPTER_NAMED = /(?:^|[^a-z])(?:chapter|chap|ch|episode|ep)s?[^a-z]*\d/i;
const CHAPTER_ALONE = /^v?\d+(?:[.\-_]\w+)?$/;

/// Does the text carry this number as a number of its own ("12", "chapter-12") and not
/// as part of a longer one ("112", "12.5")?
function holdsNumber(text, number) {
  const escaped = String(number).replace(/\./g, "\\.");
  return new RegExp(`(?:^|[^0-9.])${escaped}(?![0-9.])`).test(String(text || ""));
}

function urlScope(href, chapter) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const number = String(chapter ?? "").match(/\d+(?:\.\d+)?/)?.[0] ?? null;
  const segments = url.pathname.split("/").filter(Boolean);

  let cut = segments.findIndex((segment) => CHAPTER_NAMED.test(segment));
  if (cut === -1) {
    // A chapter word on its own: the number in the segment after it is the chapter's
    // id rather than its number (Royal Road writes both)
    cut = segments.findIndex(
      (segment, i) => CHAPTER_WORD.test(segment) && i < segments.length - 1,
    );
  }
  if (cut === -1 && number) {
    const last = segments.at(-1);
    if (last && CHAPTER_ALONE.test(last) && holdsNumber(last, number)) cut = segments.length - 1;
  }

  const path = segments.slice(0, cut === -1 ? segments.length : cut).join("/");
  if (!path) return null;

  const kept = [...url.searchParams]
    .filter(([, value]) => !(number && holdsNumber(value, number)))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  return `/${path}${kept ? `?${kept}` : ""}`;
}

/// The local key for an address — the domain is part of it, because the same path on
/// two sites is two different novels
function scopeKey(domain, scope) {
  return `scope:${domain}:${scope}`;
}

/// The host of an address, spelled the way the content script spells it
function hostOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/// The novel a page is already linked to by its address, if any — see urlScope. Everything
/// that identifies a page asks this first, because a hand-made link is the user's word and
/// the page's title is exactly what could not be trusted when it was made. An index page
/// carries no chapter, and urlScope's cut for a chapter page lands on the same address, so
/// a link made on either one answers for both.
async function novelLinkedTo(url, novels) {
  const host = hostOf(url);
  const scope = urlScope(url, null);
  if (!host || !scope) return null;

  const novelId = await getScopeMapping(host, scope);
  return novels.find((novel) => novel.id === novelId) ?? null;
}

async function getScopeMapping(domain, scope) {
  if (!scope) return null;
  const key = scopeKey(domain, scope);
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

/// Remembers a link against the address. The app's row is the durable record; the local
/// key is what lets the next chapter resolve after one visit.
async function saveScopeMapping(domain, scope, novelId) {
  await chrome.storage.local.set({ [scopeKey(domain, scope)]: novelId });

  try {
    const res = await fetch(`${API}/mappings`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        domain,
        detected_title: `${SCOPE_PREFIX}${scope}`,
        novel_id: novelId,
      }),
    });
    if (!res.ok) console.error("[Noveltrackr] address link rejected:", await res.text());
  } catch (e) {
    console.error("[Noveltrackr] could not record the address link:", e.message);
  }
}

// ── Novels linked on a site ───────────────────────────────────────────────────
// What the search panel opens with, so a second novel on a site is a click rather than
// a hunt. Only ever filled by a pick the user made: the page's own guess must not seed
// it, or the list would offer whatever was mis-detected last.
const RECENT_LIMIT = 5;

async function rememberRecent(domain, novelId) {
  const key = `recent:${domain}`;
  const result = await chrome.storage.local.get(key);
  const ids = Array.isArray(result[key]) ? result[key] : [];

  await chrome.storage.local.set({
    [key]: [novelId, ...ids.filter((id) => id !== novelId)].slice(0, RECENT_LIMIT),
  });
}

// ── Linking a page by hand ────────────────────────────────────────────────────
// The page's title told us nothing — no match, and often no name at all — so the user
// says which novel it is. The chapter goes in either way, because that write is the one
// that must not be lost. The link itself is remembered against the address only, never
// against the title that failed: that is what keeps one site's furniture from claiming
// a whole library.
async function linkPage({ novelId, chapter, url, domain, tabId, latest }) {
  const scope = urlScope(url, chapter);
  const result = { ok: true, scoped: Boolean(scope) };

  if (chapter) {
    try {
      const res = await fetch(`${API}/progress`, {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({
          novel_id: novelId,
          chapter_raw: chapter,
          source_url: url,
          domain,
          ...latestFields(latest),
        }),
      });
      result.saved = res.ok;
    } catch {
      result.saved = false;
    }
  }

  if (scope) {
    await saveScopeMapping(domain, scope, novelId);
    await rememberRecent(domain, novelId);
    result.scope = scope;
  }

  // The offer this page raised has been answered by hand, so it goes: the novel it was
  // going to add is already in the library
  if (tabId) {
    await clearPending(tabId);
    await clearCoverPending(tabId);
  }

  return result;
}

// ── Latest chapter (best effort) ──────────────────────────────────────────────
// The page said how far the site has got, if it said anything at all. A missing
// field means "no observation" to the app, so a page without evidence contributes
// nothing rather than a guess.
function latestFields(latest) {
  if (!latest || typeof latest.latest_chapter !== "number") return {};

  const fields = {
    latest_chapter: latest.latest_chapter,
    latest_chapter_confidence: latest.confidence,
  };
  if (typeof latest.total_chapters === "number") fields.total_chapters = latest.total_chapters;
  return fields;
}

// Silent: the page is evidence for a novel the user already reads, so no badge and
// no prompt. Only ever called once the novel is actually known.
async function reportLatest(novelId, observed) {
  if (Object.keys(observed).length === 0) return;

  try {
    await fetch(`${API}/metadata`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({ novel_id: novelId, ...observed }),
    });
  } catch (e) {
    console.error("[Noveltrackr] latest chapter not reported:", e.message);
  }
}

// ── Main detection handler ────────────────────────────────────────────────────
async function handleDetection({ title, chapter, url, domain, tabId, latest }) {
  const observed = latestFields(latest);
  const running = await isAppRunning();

  if (!running) {
    await setPending(tabId, { title, chapter, url, domain, latest, appOffline: true });
    chrome.action.setBadgeText({ text: "!", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#555", tabId });
    return;
  }

  // The address first: a page the user linked by hand is linked on purpose, and its
  // title is exactly what could not be trusted to find it in the first place
  const scope = urlScope(url, chapter);
  const knownNovelId = (scope ? await getScopeMapping(domain, scope) : null)
    ?? await getKnownMapping(domain, title);

  if (knownNovelId) {
    await setPending(
      tabId,
      { title, chapter, url, domain, latest, novelId: knownNovelId, known: true, tabId },
    );
    chrome.action.setBadgeText({ text: "↑", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#60a5fa", tabId });

    // No click needed: reading a chapter is enough to keep the number current
    await reportLatest(knownNovelId, observed);
  } else {
    try {
      const novels = await getNovels();
      const matches = findMatches(title, novels);
      await setPending(tabId, { title, chapter, url, domain, latest, matches, known: false, tabId });
      chrome.action.setBadgeText({ text: "?", tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#facc15", tabId });
    } catch {
      return;
    }
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHAPTER_DETECTED") {
    handleDetection({
      ...message.payload,
      tabId: sender.tab?.id,
    }).catch(console.error);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_PENDING") {
    // Get detection for the tab that the popup is associated with
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { sendResponse(null); return; }
      const data = await getPending(tabId);
      sendResponse(data);
    });
    return true; // async
  }

  if (message.type === "CONFIRM_UPDATE") {
    const { novelId, chapter, url, domain, detectedTitle, tabId, latest } = message.payload;
    const scope = urlScope(url, chapter);

    fetch(`${API}/progress`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        novel_id: novelId,
        chapter_raw: chapter,
        source_url: url,
        domain,
        ...latestFields(latest),
      }),
    })
    .then(async (res) => {
      const data = await res.json();

      if (!res.ok || data.error) {
        // Stale mapping — clear it
        const key = scope ? scopeKey(domain, scope) : `mapping:${domain}:${normalise(detectedTitle)}`;
        await chrome.storage.local.remove(key);
        if (tabId) await clearPending(tabId);
        sendResponse({ error: "stale_mapping" });
        return;
      }

      // A page whose address names its novel is linked by address; a title is what is
      // left when the address says nothing (see urlScope)
      if (scope) {
        await saveScopeMapping(domain, scope, novelId);
      } else {
        await saveLocalMapping(domain, detectedTitle, novelId);
        await fetch(`${API}/mappings`, {
          method: "POST",
          headers: API_HEADERS,
          body: JSON.stringify({
            domain,
            detected_title: detectedTitle,
            novel_id: novelId,
          }),
        });
      }
      await rememberRecent(domain, novelId);
      if (tabId) await clearPending(tabId);
      sendResponse({ ok: true });
    })
    .catch(e => sendResponse({ error: e.message }));

    return true; // async
  }

  // The user found the novel by name because the page's own title told us nothing
  if (message.type === "LINK_PAGE") {
    linkPage(message.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true; // async
  }

  if (message.type === "CLEAR_PENDING") {
    // Clear only the current active tab's pending detection
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) await clearPending(tabId);
      sendResponse({ ok: true });
    });
    return true; // async
  }

if (message.type === "COVER_DETECTED") {
  // The whole payload rides along: the page's author and tags are part of the
  // offer to add, and handleCoverDetection decides which of them are worth
  // keeping. Naming them here is how they got dropped on the way to the popup.
  const tabId = sender.tab?.id;

  if (tabId) {
    handleCoverDetection({ ...message.payload, tabId })
      .catch(console.error);
  }

  sendResponse({ ok: true });
  return false;
}

  if (message.type === "VOCABULARY_DETECTED") {
    postVocabulary(message.payload.tags).catch(console.error);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "METADATA_DETECTED") {
    handleMetadataDetection({ ...message.payload, url: sender.tab?.url, tabId: sender.tab?.id })
      .catch(console.error);
    sendResponse({ ok: true });
    return false;
  }

  // NU's release table: remembered for the popup to offer, never written from here
  if (message.type === "NU_RELEASE_DETECTED") {
    const tabId = sender.tab?.id;
    if (tabId) setNuRelease(tabId, { ...message.payload, tabId }).catch(console.error);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_NU_RELEASE") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) {
        sendResponse(null);
        return;
      }
      sendResponse(await getNuRelease(tabId));
    });
    return true;
  }

  // The user confirmed the offered number in the popup
  if (message.type === "USE_NU_RELEASE") {
    useNuRelease(message.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (message.type === "NU_SEARCH_DETECTED") {
    handleNuSearch({ ...message.payload, tabId: sender.tab?.id }).catch(console.error);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_NU_SAVED") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { sendResponse(null); return; }
      sendResponse(await getNuSaved(tabId));
    });
    return true;
  }

  if (message.type === "GET_NU_PENDING") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { sendResponse(null); return; }
      sendResponse(await getNuPending(tabId));
    });
    return true;
  }

  if (message.type === "NU_CONFIRM") {
    handleNuConfirm(message.payload.tabId, message.payload.candidateUrl)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (message.type === "DISMISS_NU") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) await clearNuPending(tabId);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "GET_COVER_PENDING") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { sendResponse(null); return; }
      const data = await getCoverPending(tabId);
      sendResponse(data);
    });
    return true;
  }

  if (message.type === "SAVE_COVER") {
    const { novelId, coverUrl, author, tabId } = message.payload;
    
    fetch(`${API}/cover`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({ novel_id: novelId, cover_url: coverUrl, author: author ?? null }),
    })
    .then(async (res) => {
      const data = await res.json();
      if (tabId) await clearCoverPending(tabId);
      sendResponse(data.ok ? { ok: true } : { error: data.error });
    })
    .catch(e => sendResponse({ error: e.message }));

    return true;
  }

  if (message.type === "DISMISS_COVER") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) {
        await clearCoverPending(tabId);
        await chrome.storage.local.remove(`nu_saved_${tabId}`);
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});

// ── Clean up storage when a tab closes ───────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`pending_${tabId}`);
  chrome.storage.local.remove(`cover_${tabId}`);
  chrome.storage.local.remove(`nu_${tabId}`);
  chrome.storage.local.remove(`nu_saved_${tabId}`);
  chrome.storage.local.remove(`nu_release_${tabId}`);
});

// ── Navigating away invalidates whatever was detected on the previous page ────
// Otherwise the badge and popup keep offering to update a page you already left.
// The NU choice is kept on purpose: confirming it moves the tab to the series
// page, and the app's search URL can redirect before the user answers.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  clearPending(tabId);
  clearCoverPending(tabId);
  // The tag summary belongs to the page it was captured on
  chrome.storage.local.remove(`nu_saved_${tabId}`);
  // And so does the release row that page offered
  chrome.storage.local.remove(`nu_release_${tabId}`);
});