const API = "http://127.0.0.1:39172";
// let pendingDetection = null;

console.log("[Noveltrackr] background service worker started");

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

// Helper to save detection
async function setPending(data) {
  await chrome.storage.local.set({ pendingDetection: data });
}

// Helper to clear detection  
async function clearPending() {
  await chrome.storage.local.remove("pendingDetection");
  chrome.action.setBadgeText({ text: "" });
}

// Helper to get detection
async function getPending() {
  const result = await chrome.storage.local.get("pendingDetection");
  return result.pendingDetection || null;
}

async function getKnownMapping(domain, detectedTitle) {
  const key = `mapping:${domain}:${normalise(detectedTitle)}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

async function saveLocalMapping(domain, detectedTitle, novelId) {
  const key = `mapping:${domain}:${normalise(detectedTitle)}`;
  await chrome.storage.local.set({ [key]: novelId });
}

async function handleDetection({ title, chapter, url, domain, tabId }) {
  const running = await isAppRunning();

  if (!running) {
    await setPending({ title, chapter, url, domain, appOffline: true });
    chrome.action.setBadgeText({ text: "!", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#555", tabId });
    return;
  }

  const knownNovelId = await getKnownMapping(domain, title);

  if (knownNovelId) {
    await setPending({ title, chapter, url, domain, novelId: knownNovelId, known: true });
    chrome.action.setBadgeText({ text: "↑", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#60a5fa", tabId });
  } else {
    try {
      const novels = await getNovels();
      const matches = findMatches(title, novels);
      await setPending({ title, chapter, url, domain, matches, known: false });
      chrome.action.setBadgeText({ text: "?", tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#facc15", tabId });
    } catch {
      return;
    }
  }
}

// ── Single consolidated message listener ─────────────────────────────────────
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
    getPending().then(data => {
        console.log("[Noveltrackr] GET_PENDING:", data);
        sendResponse(data);
    });
    return true; // ← must be true now since it's async
    }

  if (message.type === "CONFIRM_UPDATE") {
    const { novelId, chapter, url, domain, detectedTitle } = message.payload;

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
        // Novel likely deleted — clear stale local mapping
        const key = `mapping:${domain}:${normalise(detectedTitle)}`;
        await chrome.storage.local.remove(key);
        await clearPending();
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
      await clearPending();
      sendResponse({ ok: true });
    })
    .catch(e => sendResponse({ error: e.message }));

    return true;
  }

if (message.type === "CLEAR_PENDING") {
  clearPending().then(() => sendResponse({ ok: true }));
  return true;
}
});