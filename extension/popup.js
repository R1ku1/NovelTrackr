const API = "http://127.0.0.1:39172";

async function isAppRunning() {
  try {
    const res = await fetch(`${API}/status`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
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

  // Ask background for current detection
  const detection = await chrome.runtime.sendMessage({ type: "GET_PENDING" });

  if (!detection) {
    body.innerHTML = `<div class="state-idle">No chapter detected on this page.</div>`;
    return;
  }

  if (detection.known) {
    renderKnown(body, detection);
  } else {
    renderUnknown(body, detection);
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
    await chrome.runtime.sendMessage({
      type: "CONFIRM_UPDATE",
      payload: {
        novelId: detection.novelId,
        chapter: detection.chapter,
        url: detection.url,
        domain: detection.domain,
        detectedTitle: detection.title,
      }
    });
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

  if (matches.length === 0) {
    body.innerHTML = `
      <div class="detection-label">Detected</div>
      <div class="detected-title">${esc(detection.title)}</div>
      <div class="detected-chapter">${esc(detection.chapter)}</div>
      <div class="candidate-label" style="margin-top:12px">Not in your library</div>
      <div class="not-in-library" id="btnIgnore">Ignore</div>
    `;
    document.getElementById("btnIgnore").onclick = () => {
      chrome.runtime.sendMessage({ type: "CLEAR_PENDING" });
      window.close();
    };
    return;
  }

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

function esc(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

init();