const API = "http://127.0.0.1:39172";
let pendingDetection = null;

// Check if app is running
async function isAppRunning() {
  try {
    const res = await fetch(`${API}/status`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Fetch all novels for matching
async function getNovels() {
  const res = await fetch(`${API}/novels`);
  return res.json();
}

// Fuzzy match title against library
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
      const aliasScore = Math.max(0, ...n.aliases.map(a => similarity(detectedTitle, a)));
      return { novel: n, score: Math.max(titleScore, aliasScore) };
    })
    .filter(({ score }) => score >= 0.75)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ novel }) => novel);
}

// Check site_mappings first for known matches
async function getKnownMapping(domain, detectedTitle) {
  // We store mappings locally in extension storage for speed
  const key = `mapping:${domain}:${normalise(detectedTitle)}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

async function saveLocalMapping(domain, detectedTitle, novelId) {
  const key = `mapping:${domain}:${normalise(detectedTitle)}`;
  await chrome.storage.local.set({ [key]: novelId });
}

// Main handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "CHAPTER_DETECTED") return;
  
  const { title, chapter, url, domain } = message.payload;
  
  handleDetection({ title, chapter, url, domain, tabId: sender.tab.id });
});

async function handleDetection({ title, chapter, url, domain, tabId }) {
  const running = await isAppRunning();
  
  if (!running) {
    // Store pending but don't annoy user — only show badge
    chrome.action.setBadgeText({ text: "!", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#555", tabId });
    pendingDetection = { title, chapter, url, domain };
    return;
  }

  // Check local mapping cache first
  const knownNovelId = await getKnownMapping(domain, title);
  
  if (knownNovelId) {
    // Known novel — store detection, show update badge
    pendingDetection = { title, chapter, url, domain, novelId: knownNovelId, known: true };
    chrome.action.setBadgeText({ text: "↑", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#60a5fa", tabId });
  } else {
    // Unknown — fetch novels and fuzzy match
    try {
      const novels = await getNovels();
      const matches = findMatches(title, novels);
      pendingDetection = { title, chapter, url, domain, matches, known: false };
      chrome.action.setBadgeText({ text: "?", tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#facc15", tabId });
    } catch {
      return; // app running but query failed, silent
    }
  }

  // Send to popup if it's open
  chrome.runtime.sendMessage({ type: "DETECTION_READY", payload: pendingDetection })
    .catch(() => {}); // popup might not be open, that's fine
}

// Popup requests current detection
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_PENDING") {
    sendResponse(pendingDetection);
  }
  
  if (message.type === "CONFIRM_UPDATE") {
    const { novelId, chapter, url, domain, detectedTitle } = message.payload;
    
    // POST to local API
    fetch(`${API}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        novel_id: novelId,
        chapter_raw: chapter,
        source_url: url,
        domain,
      })
    })
    .then(async () => {
      // Save mapping so we don't ask again
      await saveLocalMapping(domain, detectedTitle, novelId);
      
      // Also tell the API to save mapping
      await fetch(`${API}/mappings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, detected_title: detectedTitle, novel_id: novelId }),
      });
      
      pendingDetection = null;
      chrome.action.setBadgeText({ text: "" });
      sendResponse({ ok: true });
    })
    .catch(e => sendResponse({ error: e.message }));
    
    return true; // async response
  }
  
  if (message.type === "CLEAR_PENDING") {
    pendingDetection = null;
    chrome.action.setBadgeText({ text: "" });
  }
});