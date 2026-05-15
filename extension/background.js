const API = "http://127.0.0.1:39172";

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

// ── App check ─────────────────────────────────────────────────────────────────
async function isAppRunning() {
  try {
    const res = await fetch(`${API}/status`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getNovels() {
  const res = await fetch(`${API}/novels`);
  return res.json();
}

// ── Fuzzy matching ────────────────────────────────────────────────────────────
function normalise(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  let matches = 0, bi = 0;
  for (let ai = 0; ai < na.length && bi < nb.length; ai++) {
    if (na[ai] === nb[bi]) { matches++; bi++; }
  }
  return (matches * 2) / (na.length + nb.length);
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
      headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
});

// ── Clean up storage when a tab closes ───────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`pending_${tabId}`);
});