const API = "http://127.0.0.1:39172";

async function isAppRunning() {
  try {
    const res = await fetch(`${API}/status`, { signal: AbortSignal.timeout(1000) });
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
    if (!badge || badge === "+" || badge === "img") {
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

  // Check chapter detection first
  const detection = await getPendingWithRetry();
  if (detection) {
    if (detection.known) renderKnown(body, detection);
    else renderUnknown(body, detection);
    return;
  }

  // Then check cover detection — no retry needed, it's instant
  const cover = await getCoverPending();
  console.log("[Noveltrackr] cover pending:", cover);
  if (cover) {
    renderCoverPrompt(body, cover);
    return;
  }

  body.innerHTML = `<div class="state-idle">No chapter detected on this page.</div>`;

  if (!detection && !cover) {
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      if (attempts > 15) {
        clearInterval(poll);
        // Give up — show idle state
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
      }
    }, 200);
  }
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: detection.title,
            chapter_raw: detection.chapter,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          const key = `mapping:${detection.domain}:${detection.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim()}`;
          await chrome.storage.local.set({ [key]: data.id });
          await fetch(`${API}/progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              novel_id: data.id,
              chapter_raw: detection.chapter,
              source_url: detection.url,
              domain: detection.domain,
            }),
          });
          await fetch(`${API}/mappings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              domain: detection.domain,
              detected_title: detection.title,
              novel_id: data.id,
            }),
          });
          chrome.runtime.sendMessage({ type: "CLEAR_PENDING" });
          body.innerHTML = `<div class="success">✓ Added to library</div>`;
          setTimeout(window.close, 800);
        } else {
          body.innerHTML = `<div class="state-offline">Error: ${esc(data.error)}</div>`;
        }
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

function esc(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

init();