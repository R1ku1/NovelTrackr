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

async function handleCoverDetection({ title, coverUrl, domain, tabId }) {
  const running = await isAppRunning();
  if (!running) {
    console.log("[Noveltrackr] app not running, skipping cover");
    return;
  }

  try {
    const novels = await getNovels();
    console.log("[Noveltrackr] searching for:", title, "in", novels.length, "novels");
    const matches = findMatches(title, novels);
    console.log("[Noveltrackr] cover matches:", matches);

    if (matches.length === 0) {
      console.log("[Noveltrackr] no match found for cover, novel not in library");
      return;
    }

    await setCoverPending(tabId, {
      title,
      coverUrl,
      domain,
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

if (message.type === "COVER_DETECTED") {
  const { title, coverUrl, domain } = message.payload;
  const tabId = sender.tab?.id;

  if (tabId) {
    handleCoverDetection({ title, coverUrl, domain, tabId })
      .catch(console.error);
  }

  sendResponse({ ok: true });
  return false;
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
    const { novelId, coverUrl, tabId } = message.payload;
    
    fetch(`${API}/cover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ novel_id: novelId, cover_url: coverUrl }),
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
      if (tabId) await clearCoverPending(tabId);
      sendResponse({ ok: true });
    });
    return true;
  }
});

// ── Clean up storage when a tab closes ───────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`pending_${tabId}`);
  chrome.storage.local.remove(`cover_${tabId}`);
});