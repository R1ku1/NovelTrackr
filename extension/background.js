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

async function handleCoverDetection({ title, coverUrl, domain, tabId, author, tags, source }) {
  const running = await isAppRunning();
  if (!running) {
    console.log("[Noveltrackr] app not running, skipping cover");
    return;
  }

  // Only what the page actually offered — missing keys stay missing, so the
  // popup can tell "nothing detected" from an empty value
  const meta = tags?.length ? { author, tags, source } : author ? { author } : {};

  try {
    const novels = await getNovels();
    console.log("[Noveltrackr] searching for:", title, "in", novels.length, "novels");
    const matches = findMatches(title, novels);
    console.log("[Noveltrackr] cover matches:", matches);

    if (matches.length === 0) {
      // Not in the library — offer to add it (cover included) instead
      console.log("[Noveltrackr] novel not in library, offering to add:", title);
      await setCoverPending(tabId, {
        title,
        coverUrl,
        domain,
        ...meta,
        type: "add",
        tabId,
      });

      chrome.action.setBadgeText({ text: "+", tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#a78bfa", tabId });
      return;
    }

    await setCoverPending(tabId, {
      title,
      coverUrl,
      domain,
      ...meta,
      novelId: matches[0].id,
      novelTitle: matches[0].canonical_title,
      type: "cover",
      tabId,
    });

    console.log("[Noveltrackr] cover pending set for tab", tabId);
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
  if (!running) {
    console.log("[Noveltrackr] app not running, skipping vocabulary");
    return;
  }

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

    console.log("[Noveltrackr] tag vocabulary saved:", tags.length);
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
  if (!running) {
    console.log("[Noveltrackr] app not running, skipping NU search");
    return;
  }

  try {
    const novels = await getNovels();
    const matches = findMatches(query, novels);
    if (matches.length === 0) {
      console.log("[Noveltrackr] NU search for a novel we don't have, ignoring:", query);
      return;
    }

    await setNuPending(tabId, {
      novelId: matches[0].id,
      novelTitle: matches[0].canonical_title,
      query,
      candidates,
      tabId,
    });

    chrome.action.setBadgeText({ text: "?", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#60a5fa", tabId });
    console.log("[Noveltrackr] NU candidates ready for tab", tabId);
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
async function handleMetadataDetection({ title, author, tags, source, url, tabId }) {
  const hasTags = Boolean(tags && tags.length);
  if (!author && !hasTags) return;

  const running = await isAppRunning();
  if (!running) {
    console.log("[Noveltrackr] app not running, skipping metadata");
    return;
  }

  try {
    const novels = await getNovels();
    const matches = findMatches(title, novels);
    // A series the user picked in the NU flow beats a fuzzy title match
    const confirmed = await getNuSeriesNovel(url);
    const novelId = confirmed ?? matches[0]?.id ?? null;

    if (!novelId) {
      console.log("[Noveltrackr] metadata for unknown novel, ignoring:", title);
      return;
    }

    const res = await fetch(`${API}/metadata`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        novel_id: novelId,
        author,
        tags: hasTags ? tags : null,
        source: hasTags ? source : null,
      }),
    });

    if (!res.ok) {
      console.error("[Noveltrackr] metadata write rejected:", await res.text());
      return;
    }

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

// ── Main detection handler ────────────────────────────────────────────────────
async function handleDetection({ title, chapter, url, domain, tabId }) {
  const running = await isAppRunning();

  if (!running) {
    await setPending(tabId, { title, chapter, url, domain, appOffline: true });
    chrome.action.setBadgeText({ text: "!", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#555", tabId });
    return;
  }

  const knownNovelId = await getKnownMapping(domain, title);

  if (knownNovelId) {
    await setPending(tabId, { title, chapter, url, domain, novelId: knownNovelId, known: true, tabId });
    chrome.action.setBadgeText({ text: "↑", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#60a5fa", tabId });
  } else {
    try {
      const novels = await getNovels();
      const matches = findMatches(title, novels);
      await setPending(tabId, { title, chapter, url, domain, matches, known: false, tabId });
      chrome.action.setBadgeText({ text: "?", tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#facc15", tabId });
    } catch {
      return;
    }
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Noveltrackr] message received:", message.type);

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
      console.log("[Noveltrackr] GET_PENDING for tab", tabId, ":", data);
      sendResponse(data);
    });
    return true; // async
  }

  if (message.type === "CONFIRM_UPDATE") {
    const { novelId, chapter, url, domain, detectedTitle, tabId } = message.payload;

    fetch(`${API}/progress`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        novel_id: novelId,
        chapter_raw: chapter,
        source_url: url,
        domain,
      }),
    })
    .then(async (res) => {
      const data = await res.json();

      if (!res.ok || data.error) {
        // Stale mapping — clear it
        const key = `mapping:${domain}:${normalise(detectedTitle)}`;
        await chrome.storage.local.remove(key);
        if (tabId) await clearPending(tabId);
        sendResponse({ error: "stale_mapping" });
        return;
      }

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
      if (tabId) await clearPending(tabId);
      sendResponse({ ok: true });
    })
    .catch(e => sendResponse({ error: e.message }));

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
});