const API = "http://127.0.0.1:39172";

// Required by the app's local server — see background.js
const API_HEADERS = { "Content-Type": "application/json", "X-Noveltrackr": "1" };

async function isAppRunning() {
  try {
    const res = await fetch(`${API}/status`, { headers: API_HEADERS, signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getPendingWithRetry(maxAttempts = 5, delayMs = 200) {
  // Check badge first — if empty, no point retrying
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId) {
    const badge = await chrome.action.getBadgeText({ tabId });
    // Only badges set by chapter detection are worth retrying for
    if (!badge || badge === "+") {
      return null; // cover or nothing — skip chapter retry
    }
  }

  for (let i = 0; i < maxAttempts; i++) {
    const detection = await chrome.runtime.sendMessage({ type: "GET_PENDING" });
    if (detection) return detection;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return null;
}

async function getCoverPending() {
  return chrome.runtime.sendMessage({ type: "GET_COVER_PENDING" });
}
async function init() {
  const dot = document.getElementById("statusDot");
  const body = document.getElementById("body");

  const running = await isAppRunning();
  dot.className = `status-dot ${running ? "online" : "offline"}`;

  if (!running) {
    body.innerHTML = `<div class="state-offline">Noveltrackr is not running.<br>Open the desktop app first.</div>`;
    return;
  }

  // Check badge first — if empty, nothing is pending, show idle immediately
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  let badge = tabId ? await chrome.action.getBadgeText({ tabId }) : "";

  // The background only sets the badge after it has talked to the app (~1s after
  // page load), so give it a moment instead of falsely reporting "nothing here".
  for (let i = 0; !badge && tabId && i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    badge = await chrome.action.getBadgeText({ tabId });
  }

  if (!badge) {
    body.innerHTML = `<div class="state-idle">No chapter detected on this page.</div>`;
    return;
  }

  // Badge is set — check what's pending
  const detection = await getPendingWithRetry();
  if (detection) {
    if (detection.known) renderKnown(body, detection);
    else renderUnknown(body, detection);
    return;
  }

  const cover = await chrome.runtime.sendMessage({ type: "GET_COVER_PENDING" });
  if (cover) {
    renderCoverPrompt(body, cover);
    return;
  }

  // Badge was set but data not ready yet — poll
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;

    if (attempts > 15) {
      clearInterval(poll);
      body.innerHTML = `<div class="state-idle">No chapter detected on this page.</div>`;
      return;
    }

    const d = await chrome.runtime.sendMessage({ type: "GET_PENDING" });
    if (d) {
      clearInterval(poll);
      if (d.known) renderKnown(body, d);
      else renderUnknown(body, d);
      return;
    }

    const c = await chrome.runtime.sendMessage({ type: "GET_COVER_PENDING" });
    if (c) {
      clearInterval(poll);
      renderCoverPrompt(body, c);
      return;
    }
  }, 200);
}

function renderKnown(body, detection) {
  body.innerHTML = `
    <div class="detection-label">Detected</div>
    <div class="detected-title">${esc(detection.title)}</div>
    <div class="detected-chapter">${esc(detection.chapter)}</div>
    <button class="btn-update" id="btnUpdate">Update Progress</button>
    <button class="btn-ignore" id="btnIgnore">Ignore</button>
  `;

document.getElementById("btnUpdate").onclick = async () => {
  const result = await chrome.runtime.sendMessage({
      type: "CONFIRM_UPDATE",
      payload: {
        novelId: detection.novelId,
        chapter: detection.chapter,
        url: detection.url,
        domain: detection.domain,
        detectedTitle: detection.title,
        tabId: detection.tabId,
      }
    });

    if (result?.error === "stale_mapping") {
      // Mapping was stale — reload popup to show fresh unknown state
      body.innerHTML = `<div class="state-idle">Novel was deleted. Refresh the to re-link.</div>`;
      return;
    }

    body.innerHTML = `<div class="success">✓ Progress updated</div>`;
    setTimeout(window.close, 800);
  };

  document.getElementById("btnIgnore").onclick = () => {
    chrome.runtime.sendMessage({ type: "CLEAR_PENDING" });
    window.close();
  };
}

function mappingKey(domain, title) {
  const norm = title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  return `mapping:${domain}:${norm}`;
}

// Cache the domain→novel link locally and persist it in the app's DB.
// Returns false if the app rejected it, so callers never claim a link that isn't there.
async function cacheMapping(domain, title, novelId) {
  await chrome.storage.local.set({ [mappingKey(domain, title)]: novelId });
  try {
    const res = await fetch(`${API}/mappings`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        domain,
        detected_title: title,
        novel_id: novelId,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Progress is the write that must not be lost, so its result is reported back
async function saveProgress(novelId, detection) {
  try {
    const res = await fetch(`${API}/progress`, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        novel_id: novelId,
        chapter_raw: detection.chapter,
        source_url: detection.url,
        domain: detection.domain,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function renderUnknown(body, detection) {
  const matches = detection.matches || [];
  console.log("[Noveltrackr] renderUnknown called, matches:", matches.length, matches);

  if (matches.length === 0) {
    body.innerHTML = `
      <div class="detection-label">Detected</div>
      <div class="detected-title">${esc(detection.title)}</div>
      <div class="detected-chapter">${esc(detection.chapter)}</div>
      <div class="candidate-label" style="margin-top:12px; color: #555">
        Not found in your library.
      </div>
      <button class="btn-update" id="btnAdd" style="margin-top:12px">
        Add to Library
      </button>
      <button class="btn-ignore" id="btnIgnore" style="margin-top:8px">
        Ignore
      </button>
    `;

    document.getElementById("btnAdd").onclick = async () => {
      try {
        const res = await fetch(`${API}/quick-add`, {
          method: "POST",
          headers: API_HEADERS,
          body: JSON.stringify({
            title: detection.title,
            chapter_raw: detection.chapter,
          }),
        });
        const data = await res.json();

        // The app refuses to add a novel it thinks you already have
        if (data.error === "duplicate" && data.novel_id) {
          renderDuplicatePrompt(body, detection, data);
          return;
        }

        if (!data.ok) {
          body.innerHTML = `<div class="state-offline">Error: ${esc(data.error)}</div>`;
          return;
        }

        const saved = await saveProgress(data.id, detection);
        const linked = await cacheMapping(detection.domain, detection.title, data.id);

        if (!saved) {
          body.innerHTML = `<div class="state-offline">Added to the library, but your chapter couldn't be saved. Is the app still running?</div>`;
          return;
        }

        chrome.runtime.sendMessage({ type: "CLEAR_PENDING" });
        body.innerHTML = linked
          ? `<div class="success">✓ Added to library</div>`
          : `<div class="success">✓ Added to library</div>
             <div class="state-offline">Couldn't save the site link — reopen this page to retry.</div>`;
        setTimeout(window.close, 900);
      } catch (e) {
        body.innerHTML = `<div class="state-offline">Failed to connect to app.</div>`;
      }
    };

    document.getElementById("btnIgnore").onclick = () => {
      chrome.runtime.sendMessage({ type: "CLEAR_PENDING" });
      window.close();
    };
    return;
  }

  // Has candidates
  const candidatesHtml = matches.map(n => `
    <div class="candidate" data-id="${n.id}">
      <div class="candidate-title">${esc(n.canonical_title)}</div>
      ${n.current_chapter_raw
        ? `<div class="candidate-chapter">${esc(n.current_chapter_raw)}</div>`
        : ""}
    </div>
  `).join("");

  body.innerHTML = `
    <div class="detection-label">Detected</div>
    <div class="detected-title">${esc(detection.title)}</div>
    <div class="detected-chapter">${esc(detection.chapter)}</div>
    <div class="candidate-label" style="margin-top:14px">Which novel is this?</div>
    ${candidatesHtml}
    <div class="not-in-library" id="btnIgnore">Not in my library — ignore</div>
  `;

  document.querySelectorAll(".candidate").forEach(el => {
    el.onclick = async () => {
      const novelId = parseInt(el.dataset.id);
      await chrome.runtime.sendMessage({
        type: "CONFIRM_UPDATE",
        payload: {
          novelId,
          chapter: detection.chapter,
          url: detection.url,
          domain: detection.domain,
          detectedTitle: detection.title,
          tabId: detection.tabId,
        }
      });
      body.innerHTML = `<div class="success">✓ Progress updated</div>`;
      setTimeout(window.close, 800);
    };
  });

  document.getElementById("btnIgnore").onclick = () => {
    chrome.runtime.sendMessage({ type: "CLEAR_PENDING" });
    window.close();
  };
}

function renderCoverPrompt(body, cover) {
  if (cover.type === "add") {
    renderAddPrompt(body, cover);
    return;
  }

  body.innerHTML = `
    <div class="detection-label">Cover Image Found</div>
    <div class="detected-title">${esc(cover.novelTitle)}</div>
    
    <div style="margin: 12px 0; text-align: center;">
      <img 
        src="${esc(cover.coverUrl)}" 
        alt="Cover"
        style="max-width: 120px; max-height: 180px; border-radius: 6px; border: 1px solid #2a2a35; object-fit: cover;"
        onerror="this.style.display='none'; document.getElementById('coverError').style.display='block';"
      />
      <div id="coverError" style="display:none; font-size:11px; color:#555; margin-top:8px;">
        Could not load image preview
      </div>
    </div>

    <button class="btn-update" id="btnSaveCover">Save as Cover</button>
    <button class="btn-ignore" id="btnDismissCover" style="margin-top: 8px;">Ignore</button>
  `;

  document.getElementById("btnSaveCover").onclick = async () => {
    const result = await chrome.runtime.sendMessage({
      type: "SAVE_COVER",
      payload: {
        novelId: cover.novelId,
        coverUrl: cover.coverUrl,
        author: cover.author,
        tabId: cover.tabId,
      }
    });

    if (result?.ok) {
      body.innerHTML = `<div class="success">✓ Cover saved</div>`;
      setTimeout(window.close, 800);
    } else {
      body.innerHTML = `<div class="state-offline">Failed to save cover.</div>`;
    }
  };

  document.getElementById("btnDismissCover").onclick = () => {
    chrome.runtime.sendMessage({ type: "DISMISS_COVER" });
    window.close();
  };
}

// Page metadata rides along with the add, but only when the page offered it
function pageMetadata(source) {
  const fields = {};
  if (source?.author) fields.author = source.author;
  if (source?.tags?.length) {
    fields.tags = source.tags;
    fields.source = source.source;
  }
  return fields;
}

// Novel page whose title isn't in the library yet — add it (with its cover)
function renderAddPrompt(body, cover) {
  body.innerHTML = `
    <div class="detection-label">Novel Found</div>
    <div class="detected-title">${esc(cover.title)}</div>
    ${cover.coverUrl ? `
    <div style="margin: 12px 0; text-align: center;">
      <img
        src="${esc(cover.coverUrl)}"
        alt="Cover"
        style="max-width: 120px; max-height: 180px; border-radius: 6px; border: 1px solid #2a2a35; object-fit: cover;"
        onerror="this.style.display='none'"
      />
    </div>` : ""}
    <div class="candidate-label" style="color:#555">Not in your library.</div>
    <button class="btn-update" id="btnAdd" style="margin-top:12px">Add to Library</button>
    <button class="btn-ignore" id="btnDismissCover" style="margin-top:8px">Ignore</button>
  `;

  document.getElementById("btnAdd").onclick = async () => {
    try {
      const res = await fetch(`${API}/quick-add`, {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({
          title: cover.title,
          chapter_raw: "",
          ...pageMetadata(cover),
        }),
      });
      const data = await res.json();

      // The app refuses to add a novel it thinks you already have
      if (data.error === "duplicate" && data.novel_id) {
        renderDuplicatePrompt(body, cover, data);
        return;
      }

      if (!data.ok) {
        body.innerHTML = `<div class="state-offline">Error: ${esc(data.error)}</div>`;
        return;
      }

      let coverSaved = true;
      if (cover.coverUrl) {
        const coverRes = await fetch(`${API}/cover`, {
          method: "POST",
          headers: API_HEADERS,
          body: JSON.stringify({ novel_id: data.id, cover_url: cover.coverUrl }),
        });
        coverSaved = coverRes.ok;
      }
      const linked = await cacheMapping(cover.domain, cover.title, data.id);

      chrome.runtime.sendMessage({ type: "DISMISS_COVER" });
      const missed = [!coverSaved && "cover", !linked && "site link"].filter(Boolean);
      body.innerHTML = missed.length
        ? `<div class="success">✓ Added to library</div>
           <div class="state-offline">Couldn't save the ${esc(missed.join(" and "))} — try again from this page.</div>`
        : `<div class="success">✓ Added to library</div>`;
      setTimeout(window.close, 900);
    } catch {
      body.innerHTML = `<div class="state-offline">Failed to connect to app.</div>`;
    }
  };

  document.getElementById("btnDismissCover").onclick = () => {
    chrome.runtime.sendMessage({ type: "DISMISS_COVER" });
    window.close();
  };
}

// The title matched something already in the library, so nothing new was created
function renderDuplicatePrompt(body, pending, duplicate) {
  const hasChapter = Boolean(pending.chapter);

  body.innerHTML = `
    <div class="detection-label">Already in your library</div>
    <div class="detected-title">${esc(duplicate.novel_title)}</div>
    ${hasChapter
      ? `<div class="detected-chapter">${esc(pending.chapter)}</div>`
      : ""}
    <div class="candidate-label" style="margin-top:12px; color:#555">
      "${esc(pending.title)}" matched this novel, so nothing new was added.
    </div>
    <button class="btn-update" id="btnLink" style="margin-top:12px">
      ${hasChapter ? "Link &amp; save progress" : "Link this page to it"}
    </button>
    <button class="btn-ignore" id="btnIgnore" style="margin-top:8px">Ignore</button>
  `;

  document.getElementById("btnLink").onclick = async () => {
    const linked = await cacheMapping(pending.domain, pending.title, duplicate.novel_id);

    if (!linked) {
      body.innerHTML = `<div class="state-offline">Couldn't save the link. Is the app still running?</div>`;
      return;
    }

    if (hasChapter) {
      await saveProgress(duplicate.novel_id, pending);
    }

    chrome.runtime.sendMessage({ type: hasChapter ? "CLEAR_PENDING" : "DISMISS_COVER" });
    body.innerHTML = `<div class="success">✓ Linked to ${esc(duplicate.novel_title)}</div>`;
    setTimeout(window.close, 900);
  };

  document.getElementById("btnIgnore").onclick = () => {
    chrome.runtime.sendMessage({ type: hasChapter ? "CLEAR_PENDING" : "DISMISS_COVER" });
    window.close();
  };
}

function esc(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

init();