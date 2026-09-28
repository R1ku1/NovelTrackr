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
    if (!badge || badge === "+" || badge === "?") {
      return null; // cover, NU search or nothing — skip chapter retry
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

async function getNuPending() {
  return chrome.runtime.sendMessage({ type: "GET_NU_PENDING" });
}

async function getNuSaved() {
  return chrome.runtime.sendMessage({ type: "GET_NU_SAVED" });
}

async function getNuRelease() {
  return chrome.runtime.sendMessage({ type: "GET_NU_RELEASE" });
}

// ── The page's offers ─────────────────────────────────────────────────────────
// The popup is a list: one card per thing this page has that the app doesn't, each
// with the single click that accepts it, and one way out below the lot.
//
// The body is composed in ONE assignment and wired afterwards. Appending card by card
// (`innerHTML += …`) throws away the elements that are already there, click handlers
// included — so the second card kills the first one's button. That is exactly what
// happened: "Save as Cover" and "Use this number" did nothing on screen, and only Done
// (wired last) worked.

// A section is { id, html, wire? }. An id makes it a card, no id leaves it plain
// content. wire() runs once the whole body is in the document, and is handed the card
// (or null) so a click knows where to report itself.
function renderPage(body, sections) {
  body.innerHTML = sections
    .map(({ id, html }) => (id ? `<div class="card" id="${id}">${html}</div>` : html))
    .join("");

  for (const section of sections) {
    if (section.wire) section.wire(section.id ? document.getElementById(section.id) : null, body);
  }
}

// A click has to do something visible before the app has answered, or it reads as
// broken. False means there was no card to report in and the caller falls back.
function reportInCard(card, html) {
  if (!card) return false;
  card.innerHTML = html;
  return true;
}

function headerSection(label, title, line) {
  return {
    id: null,
    html: `
      <div class="detection-label">${esc(label)}</div>
      <div class="detected-title">${esc(title)}</div>
      ${line ? `<div class="detected-chapter">${esc(line)}</div>` : ""}
    `,
  };
}

// The one way out. Dismissing clears this page's offers — the cover and the tag summary
// alike — and closes the popup.
function footerSection() {
  return {
    id: "footer",
    html: `<button class="btn-ignore" id="btnDone">Done</button>`,
    wire: () => {
      document.getElementById("btnDone").onclick = () => {
        chrome.runtime.sendMessage({ type: "DISMISS_COVER" });
        window.close();
      };
    },
  };
}

// A cover the page has and the novel doesn't: background.js never offers the one already
// stored, so whenever this card appears the image would change something
function coverSection(cover, { preview = false } = {}) {
  return {
    id: "coverCard",
    html: `
      <div class="detection-label">Cover Image Found</div>
      ${preview
        ? `<div style="margin:10px 0; text-align:center">
             <img src="${esc(cover.coverUrl)}" alt="Cover"
               style="max-width:120px;max-height:180px;border-radius:6px;border:1px solid #2a2a35;object-fit:cover"
               onerror="this.style.display='none';document.getElementById('coverError').style.display='block'" />
             <div id="coverError" style="display:none;font-size:11px;color:#555;margin-top:8px">Could not load image preview</div>
           </div>`
        : ""}
      <div class="detected-chapter" style="margin-bottom:0">${cover.replacesCover
        ? "A different image from the one in your library"
        : "This novel has no cover yet"}</div>
      <button class="btn-update" id="btnSaveCover" style="margin-top:10px">Save as Cover</button>
    `,
    wire: (card, body) => {
      const button = document.getElementById("btnSaveCover");
      if (!button) return;

      button.onclick = async () => {
        button.disabled = true;
        reportInCard(card, `<div class="state-busy">Saving cover…</div>`);

        const result = await chrome.runtime.sendMessage({
          type: "SAVE_COVER",
          payload: {
            novelId: cover.novelId,
            coverUrl: cover.coverUrl,
            author: cover.author,
            tabId: cover.tabId,
          },
        });

        const html = result?.ok
          ? `<div class="success">✓ Cover saved</div>`
          : `<div class="state-offline">Failed to save cover.</div>`;

        if (!reportInCard(card, html)) body.innerHTML = html;
        if (result?.ok) setTimeout(window.close, 900);
      };
    },
  };
}

// NovelUpdates' newest release is offered here, and only written if the user says so: the
// number belongs to whichever group released it, so it goes in as a lower bound they have
// explicitly accepted rather than as a silent guess.
function releaseSection(release) {
  return {
    id: "releaseCard",
    html: `
      <div class="detection-label">NovelUpdates' newest release</div>
      <div class="detected-chapter" style="margin-bottom:0">${esc(release.group ? `${release.group} · ` : "")}${esc(release.token)} — another group's numbering, so it is recorded as a lower bound</div>
      <button class="btn-update" id="btnUseNuRelease" style="margin-top:10px">Use this number</button>
    `,
    wire: (card, body) => {
      const button = document.getElementById("btnUseNuRelease");
      if (!button) return;

      button.onclick = async () => {
        button.disabled = true;
        reportInCard(card, `<div class="state-busy">Recording ${esc(release.token)}…</div>`);

        const result = await chrome.runtime.sendMessage({ type: "USE_NU_RELEASE", payload: release });

        const html = result?.ok
          ? `<div class="success">✓ ${esc(release.token)} recorded</div>`
          : `<div class="state-offline">Couldn't record it (${esc(String(result?.error || "unknown"))})</div>`;

        if (!reportInCard(card, html)) body.innerHTML = html;

        // Both confirmations close the popup on success, a beat after answering, the way
        // adding a novel does. Any other offer that was on screen is still there on the
        // next open: its pending state is untouched until it is used or dismissed.
        if (result?.ok) setTimeout(window.close, 900);
      };
    },
  };
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
    // Nothing is waiting on a decision. A page can still have filed tags the user
    // wants to see — that is why they opened the popup — so answer that much, and
    // only say "nothing here" when there is genuinely nothing.
    const saved = await getNuSaved();
    const release = await getNuRelease();
    if (!saved && !release) {
      body.innerHTML = `<div class="state-idle">No chapter detected on this page.</div>`;
      return;
    }
  }

  // Badge is set — check what's pending
  const detection = await getPendingWithRetry();
  if (detection) {
    if (detection.known) renderKnown(body, detection);
    else renderUnknown(body, detection);
    return;
  }

  const nu = await getNuPending();
  if (nu) {
    renderNuCandidates(body, nu);
    return;
  }

  // A series the user just picked: say what was saved, and keep the cover offer
  const saved = await getNuSaved();
  const cover = await chrome.runtime.sendMessage({ type: "GET_COVER_PENDING" });
  if (saved) {
    await renderNuSaved(body, saved, cover);
    return;
  }
  if (cover) {
    await renderCoverPrompt(body, cover);
    return;
  }

  // Badge was set but data not ready yet — poll
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;

    if (attempts > 15) {
      clearInterval(poll);
      body.innerHTML = `<div class="state-idle">No chapter detected on this page.</div>`;
      await appendNuReleaseOffer(body);
      return;
    }

    const d = await chrome.runtime.sendMessage({ type: "GET_PENDING" });
    if (d) {
      clearInterval(poll);
      if (d.known) renderKnown(body, d);
      else renderUnknown(body, d);
      return;
    }

    const n = await getNuPending();
    if (n) {
      clearInterval(poll);
      renderNuCandidates(body, n);
      return;
    }

    const s = await getNuSaved();
    const c = await chrome.runtime.sendMessage({ type: "GET_COVER_PENDING" });
    if (s) {
      clearInterval(poll);
      await renderNuSaved(body, s, c);
      return;
    }
    if (c) {
      clearInterval(poll);
      await renderCoverPrompt(body, c);
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
    <div class="not-in-library" id="btnSearch" style="margin-top:12px">Not the right novel — pick another</div>
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
        latest: detection.latest,
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

  document.getElementById("btnSearch").onclick = () => {
    renderLibrarySearch(body, detection, () => renderKnown(body, detection));
  };

  document.getElementById("btnIgnore").onclick = () => {
    chrome.runtime.sendMessage({ type: "CLEAR_PENDING" });
    window.close();
  };
}

// ── Finding the novel by name ─────────────────────────────────────────────────
// For the pages this exists for: a site whose novel name never reaches the DOM, so the
// popup has nothing to match and "Add to Library" would file the page's furniture as a
// novel. The user says which novel it is instead, and — because the page's address is
// what a hand-made link is remembered against — every later chapter of it resolves on
// its own (see background.js urlScope).
//
// The whole view is re-rendered per keystroke so every row is markup the popup can
// wire, which means the input is new each time: its focus and caret are handed back, and
// a keystroke mid-composition (IME) is left alone rather than thrown away.
const MAX_SEARCH_RESULTS = 8;

let libraryCache = null;

async function getLibrary() {
  if (libraryCache) return libraryCache;
  try {
    const res = await fetch(`${API}/novels`, { headers: API_HEADERS });
    libraryCache = res.ok ? await res.json() : [];
  } catch {
    libraryCache = [];
  }
  return libraryCache;
}

// The novels already linked from this site, newest first: the panel's opening list, so
// the second novel on a site is a click rather than a hunt. Ids only — the names come
// from the library that was just fetched, so a novel since deleted drops out.
async function recentOn(domain, library) {
  const key = `recent:${domain}`;
  const result = await chrome.storage.local.get(key);
  const ids = Array.isArray(result[key]) ? result[key] : [];
  return ids.map((id) => library.find((novel) => novel.id === id)).filter(Boolean);
}

function libraryRow(novel) {
  return `
    <div class="candidate" id="result-${novel.id}">
      <div class="candidate-title">${esc(novel.canonical_title)}</div>
      ${novel.current_chapter_raw
        ? `<div class="candidate-chapter">${esc(novel.current_chapter_raw)}</div>`
        : ""}
    </div>
  `;
}

// context — the page being linked: { title, chapter, url, domain, tabId, latest }
// back    — re-renders what the popup was showing before
async function renderLibrarySearch(body, context, back, query = "") {
  const library = await getLibrary();
  const typed = query.trim().toLowerCase();

  const matches = typed
    ? library.filter((novel) =>
        [novel.canonical_title, ...(novel.aliases || [])]
          .join(" ")
          .toLowerCase()
          .includes(typed),
      )
    : [];

  const shown = typed ? matches.slice(0, MAX_SEARCH_RESULTS) : await recentOn(context.domain, library);

  const label = !typed
    ? shown.length ? "Recently linked on this site" : ""
    : !matches.length
      ? "Nothing in your library matches that"
      : `${matches.length} match${matches.length === 1 ? "" : "es"}${
          matches.length > shown.length ? ` — showing the first ${shown.length}` : ""
        }`;

  // Nothing recent and nothing typed: the field alone says what to do, so the empty
  // card (and its divider) is left out
  const listed = label || shown.length;

  const link = async (novel) => {
    const result = await chrome.runtime.sendMessage({
      type: "LINK_PAGE",
      payload: {
        novelId: novel.id,
        chapter: context.chapter || "",
        url: context.url,
        domain: context.domain,
        tabId: context.tabId,
        latest: context.latest,
      },
    });

    body.innerHTML = !result?.ok
      ? `<div class="state-offline">Couldn't link this page. Is the app still running?</div>`
      : `
        <div class="success">✓ Linked to ${esc(novel.canonical_title)}</div>
        ${result.saved === false
          ? `<div class="state-offline">Your chapter couldn't be saved — reopen this page to retry.</div>`
          : ""}
        ${result.scoped
          ? `<div class="candidate-label" style="color:#555">Chapters under ${esc(context.domain)}${esc(result.scope)} are filed here from now on.</div>`
          : `<div class="state-offline">This page's address doesn't name one novel, so you'll have to pick it again next time.</div>`}
      `;

    if (result?.ok) setTimeout(window.close, 1800);
  };

  renderPage(body, [
    headerSection("Link this page", context.title, context.chapter),
    {
      id: null,
      html: `<input class="search-input" id="searchInput" type="text" placeholder="Search your library" />`,
      wire: () => {
        const input = document.getElementById("searchInput");
        if (!input) return;

        input.value = query;
        input.oninput = (event) => {
          if (event?.isComposing) return;
          renderLibrarySearch(body, context, back, input.value || "");
        };

        // New element, same typing: focus and caret go back where they were
        input.focus?.();
        input.setSelectionRange?.(input.value.length, input.value.length);
      },
    },
    listed ? {
      id: "results",
      html: `
        ${label ? `<div class="candidate-label" ${shown.length ? "" : `style="color:#444"`}>${esc(label)}</div>` : ""}
        ${shown.map(libraryRow).join("")}
      `,
      wire: () => {
        for (const novel of shown) {
          const row = document.getElementById(`result-${novel.id}`);
          if (row) row.onclick = () => link(novel);
        }
      },
    } : null,
    {
      id: "back",
      html: `<div class="not-in-library" id="btnBack">Back</div>`,
      wire: () => {
        const button = document.getElementById("btnBack");
        if (button) button.onclick = back;
      },
    },
  ].filter(Boolean));
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

  if (matches.length === 0) {
    body.innerHTML = `
      <div class="detection-label">Detected</div>
      <div class="detected-title">${esc(detection.title)}</div>
      <div class="detected-chapter">${esc(detection.chapter)}</div>
      <div class="candidate-label" style="margin-top:12px; color: #555">
        Not found in your library. Pick it by name instead.
      </div>
      <button class="btn-update" id="btnAdd" style="margin-top:12px">
        Add to Library
      </button>
      <button class="btn-ignore" id="btnSearch" style="margin-top:8px">
        Search my library
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

    document.getElementById("btnSearch").onclick = () => {
      renderLibrarySearch(body, detection, () => renderUnknown(body, detection));
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
    <div class="not-in-library" id="btnSearch" style="margin-top:10px">None of these — search my library</div>
    <div class="not-in-library" id="btnIgnore">Not in my library — ignore</div>
  `;

  document.getElementById("btnSearch").onclick = () => {
    renderLibrarySearch(body, detection, () => renderUnknown(body, detection));
  };

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
          latest: detection.latest,
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

// The app asked NU's search for this novel — the user says which series it is
function renderNuCandidates(body, pending) {
  const candidates = pending.candidates || [];

  body.innerHTML = `
    <div class="detection-label">NovelUpdates search</div>
    <div class="detected-title">${esc(pending.novelTitle)}</div>
    <div class="candidate-label" style="margin-top:14px">Which series is it?</div>
    ${candidates.map((c, i) => `
      <div class="candidate" id="candidate-${i}">
        <div class="candidate-title">${esc(c.title)}</div>
      </div>
    `).join("")}
    <div class="not-in-library" id="btnNoMatch">None of these — ignore</div>
  `;

  candidates.forEach((candidate, i) => {
    const el = document.getElementById(`candidate-${i}`);
    if (!el) return;

    el.onclick = async () => {
      const result = await chrome.runtime.sendMessage({
        type: "NU_CONFIRM",
        payload: { candidateUrl: candidate.url, tabId: pending.tabId },
      });

      body.innerHTML = result?.ok
        ? `<div class="success">✓ Opening that series — its tags save on arrival</div>`
        : `<div class="state-offline">Couldn't open that series. Try again from the app.</div>`;
    };
  });

  document.getElementById("btnNoMatch").onclick = () => {
    chrome.runtime.sendMessage({ type: "DISMISS_NU" });
    window.close();
  };
}

// The series the user picked: what the page filed, then whatever else it has to offer.
// Tags need no confirmation — the app fills empty fields only, so nothing the user typed
// is at stake — but they still get their own card, so a page that merely filed tags says
// exactly that instead of looking like a cover prompt that found nothing.
async function renderNuSaved(body, saved, cover) {
  const release = await getNuRelease();
  const found = saved.count === 1 ? "1 tag filed" : `${saved.count} tags filed`;

  renderPage(body, [
    headerSection("NovelUpdates · Tags", saved.novelTitle, `${found} with this novel`),
    cover && cover.type === "cover" ? coverSection(cover) : null,
    release ? releaseSection(release) : null,
    footerSection(),
  ].filter(Boolean));
}

async function renderCoverPrompt(body, cover) {
  if (cover.type === "add") {
    renderAddPrompt(body, cover);
    return;
  }

  const release = await getNuRelease();

  renderPage(body, [
    headerSection("Cover Image Found", cover.novelTitle),
    coverSection(cover, { preview: true }),
    release ? releaseSection(release) : null,
    footerSection(),
  ].filter(Boolean));
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
  // The same fields the Add button posts — say what rides along, so a page whose
  // tags didn't come through is visible before the click
  const carried = [
    cover.author ? "author" : null,
    cover.tags?.length ? `${cover.tags.length} ${cover.tags.length === 1 ? "tag" : "tags"}` : null,
  ].filter(Boolean);

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
    <div class="candidate-label" style="color:#555">
      Not in your library.${carried.length ? ` Its ${carried.join(" and ")} come with it.` : ""}
    </div>
    <button class="btn-update" id="btnAdd" style="margin-top:12px">Add to Library</button>
    <button class="btn-ignore" id="btnSearch" style="margin-top:8px">Search my library</button>
    <button class="btn-ignore" id="btnDismissCover" style="margin-top:8px">Ignore</button>
  `;

  document.getElementById("btnSearch").onclick = () => {
    renderLibrarySearch(body, cover, () => renderAddPrompt(body, cover));
  };

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