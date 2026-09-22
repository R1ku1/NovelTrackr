// Runs on every page — detects novel/chapter and messages the background worker
console.log("[Noveltrackr] content script loaded on:", window.location.href);


function extractGeneric() {
  const docTitle = document.title;
  
  // Strip site name suffix first — everything after last " | "
  const withoutSite = docTitle.includes(" | ")
    ? docTitle.substring(0, docTitle.lastIndexOf(" | "))
    : docTitle;

  // Now we have something like:
  // "Chapter 1: The Hero's Requiem. - The Demon Queen Wants To Live. [Progression]"
  // "The Demon Queen - Chapter 1"
  // "Chapter 221 - Shadow Slave"

  // Find the LAST " - " as the split point
  // This handles "Chapter 1: Subtitle - Novel Title" correctly
  const lastDash = withoutSite.lastIndexOf(" - ");
  
  if (lastDash !== -1) {
    const left = withoutSite.substring(0, lastDash).trim();
    const right = withoutSite.substring(lastDash + 3).trim();
    
    const leftIsChapter = /^chapter\s*\d/i.test(left) || /^episode\s*\d/i.test(left);
    const rightIsChapter = /^chapter\s*\d/i.test(right) || /^episode\s*\d/i.test(right);
    
    if (leftIsChapter) {
      // "Chapter 1: Hero's Requiem - Novel Title"
      // Extract just "Chapter 1" from the left part
      const chapterNum = left.match(/^(chapter\s*[\d.]+)/i)?.[1] ?? left;
      return { title: right, chapter: chapterNum };
    }
    
    if (rightIsChapter) {
      // "Novel Title - Chapter 1"
      const chapterNum = right.match(/^(chapter\s*[\d.]+)/i)?.[1] ?? right;
      return { title: left, chapter: chapterNum };
    }
  }

  // Fallback — try to find any chapter mention anywhere in the title
  const chapterMatch = withoutSite.match(/chapter\s*([\d.]+)/i);
  if (chapterMatch) {
    // Remove the chapter part to get the novel title
    const chapter = `Chapter ${chapterMatch[1]}`;
    const title = withoutSite
      .replace(/[-–|]\s*chapter\s*[\d.]+.*/i, "")
      .replace(/chapter\s*[\d.]+.*?[-–|]\s*/i, "")
      .trim();
    if (title) return { title, chapter };
  }

  return null;
}

// ── Metadata (plan §4.1) ──────────────────────────────────────────────────────
// Per-site author selectors, tried in order — the first one with text wins.
// Nothing is guessed: no match means the field stays empty.
const SITE_AUTHOR = {
  "royalroad.com":   ["a[href*='/profile/']", ".fic-title .author", ".author"],
  "scribblehub.com": ["a[href*='/profile/']", ".series-author", ".author"],
  "novelfire.net":   [".novel-detail .author a", ".author a", ".author"],
};

// Sites that aren't listed here still get the standard hints
const GENERIC_AUTHOR = ["[rel='author']"];

function hostName() {
  return window.location.hostname.replace(/^www\./, "");
}

function firstText(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const text = el?.textContent?.trim();
    if (text) return text;
  }
  return null;
}

function extractAuthor() {
  const host = hostName();
  const site = Object.keys(SITE_AUTHOR).find((k) => host === k || host.endsWith("." + k));

  const author =
    firstText(site ? SITE_AUTHOR[site] : []) ??
    firstText(GENERIC_AUTHOR) ??
    document.querySelector("meta[name='author']")?.getAttribute("content")?.trim() ??
    null;

  // Author blocks commonly read "by Name"
  return author ? author.replace(/^by\s+/i, "").trim() || null : null;
}

// Per-site tag selectors, tried in order — the first selector that yields
// anything wins, so a site's navigation can't get mixed in with its tags.
// These match each site's own tag links; verify against the live DOM when a
// site changes (plan §4.2.4).
const SITE_TAGS = {
  "royalroad.com": {
    source: "royalroad",
    selectors: ["a[href*='tagsAdd=']", ".tags a", ".fiction-tag"],
  },
  "scribblehub.com": {
    source: "scribblehub",
    selectors: ["a[href*='series-finder/?sf=']", ".series-tags a", ".tags a"],
  },
  "novelfire.net": {
    source: "novelfire",
    selectors: ["a[href*='/genre/']", ".novel-tags a", ".tags a"],
  },
};

const MAX_TAGS = 40;
const MAX_VOCABULARY = 1000;

// Tags differ in case and punctuation between sites — "Lit-rpg" and "LitRPG"
// are the same tag (plan §4.2.2)
function tagKey(tag) {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Trimmed, de-duplicated, capped text of every element a selector matches
function textsFrom(selector, max) {
  return [...document.querySelectorAll(selector)]
    .map((el) => el.textContent.trim())
    // A tag is a short label; anything longer is a chapter or a title
    .filter((t) => t && t.length <= 60)
    .filter((t, i, all) => all.findIndex((o) => tagKey(o) === tagKey(t)) === i)
    .slice(0, max);
}

// First selector that yields anything wins, so a site's navigation can't get
// mixed in with its tags
function firstTags(selectors, max) {
  for (const selector of selectors) {
    const tags = textsFrom(selector, max);
    if (tags.length > 0) return tags;
  }
  return [];
}

// NovelUpdates tags come from its own search flow (plan §4.2.1 Path B), and
// every other site falls back to manual entry — nothing is ever guessed.
function extractTags() {
  const host = hostName();
  const site = Object.keys(SITE_TAGS).find((k) => host === k || host.endsWith("." + k));
  if (!site) return { source: null, tags: [] };

  return { source: SITE_TAGS[site].source, tags: firstTags(SITE_TAGS[site].selectors, MAX_TAGS) };
}

// ── NovelUpdates tag vocabulary (plan §4.2.2) ─────────────────────────────────
// A single visit to NU's Series Tags page fills the app's tag list, which powers
// tag suggestions and the canonical spelling of tags captured elsewhere.
const NU_HOST = "novelupdates.com";
const NU_TAGS_PATH = "/series-tags";

// Every tag listed there is a filter link; the later selectors catch markup that
// keeps the links but moves them
const NU_VOCABULARY_SELECTORS = [
  "#main a[href*='series-finder']",
  ".series-tags a",
  "a[href*='series-finder']",
];

function isNuPage(pathPrefix) {
  const host = hostName();
  const onNu = host === NU_HOST || host.endsWith("." + NU_HOST);
  return onNu && window.location.pathname.startsWith(pathPrefix);
}

// Add this helper to detect if we're on an index/ToC page
function isIndexPage() {
  const url = window.location.href.toLowerCase();
  // If URL contains chapter indicators it's a chapter page
  const chapterIndicators = [
    "/chapter-", "/chapter/", "/ch-", "/ch/",
    "/episode-", "/episode/", "chapter=", "?ch="
  ];
  return !chapterIndicators.some(p => url.includes(p));
}

// Extract cover image from page
function extractCoverImage() {
  const selectors = [
    "figure.cover img",
    ".fixed-img img",
    "img.thumbnail",
    ".cover-art img",
    ".fiction-cover img",
    ".fic_image img",
    "img.cover",
    "img.novel-cover",
    "img.book-cover",
    ".cover img",
    ".novel-cover img",
    ".book-cover img",
    // NovelUpdates
    ".serieseditimg img",
    "div.wpb_wrapper img",
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el?.src && el.src.startsWith("http")) {
      console.log("[Noveltrackr] cover found via selector:", selector, el.src);
      return el.src;
    }
  }

  // ── CSS background-image fallback ─────────────────────────────────────────
  const bgSelectors = [
    ".cover",
    ".hero-media .cover",
    ".novel-cover",
    ".book-cover",
    ".cover-image",
    "[class*='cover']",
  ];

  for (const selector of bgSelectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const style = el.getAttribute("style") || window.getComputedStyle(el).backgroundImage;
    const match = style.match(/url\(['"]?(https?[^'")\s]+)['"]?\)/);
    if (match) {
      console.log("[Noveltrackr] cover found via background-image:", selector, match[1]);
      return match[1];
    }
  }

  // ── Largest portrait img fallback ─────────────────────────────────────────
  const images = Array.from(document.querySelectorAll("img"))
    .filter(img => img.src && img.src.startsWith("http"))
    .filter(img => img.complete && img.naturalWidth > 80 && img.naturalHeight > 80)
    .filter(img => img.naturalHeight > img.naturalWidth)
    .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));

  if (images[0]) {
    console.log("[Noveltrackr] cover found via img fallback:", images[0].src);
    return images[0].src;
  }

  return null;
}

// Only one cover extraction may be pending — re-running run() (turbo/pjax, or a
// second load event) must not leave a stale timer pointing at the previous page.
let coverTimer = null;

function scheduleCoverDetection(indexTitle, meta = {}) {
  clearTimeout(coverTimer);

  const scheduledHref = window.location.href;

  coverTimer = setTimeout(() => {
    coverTimer = null;

    // The site navigated in-page while we waited; the title above is stale now
    if (window.location.href !== scheduledHref) {
      console.log("[Noveltrackr] page changed before cover extraction, skipping");
      return;
    }

    const coverUrl = extractCoverImage();
    if (!coverUrl) {
      console.log("[Noveltrackr] no cover image found on index page");
      return;
    }

    console.log("[Noveltrackr] sending COVER_DETECTED:", indexTitle, coverUrl);

    chrome.runtime.sendMessage({
      type: "COVER_DETECTED",
      payload: {
        title: indexTitle,
        coverUrl,
        domain: hostName(),
        ...meta,
      }
    }).catch((e) => console.log("[Noveltrackr] cover message failed:", e));
  }, 1000);
}

function run() {
  console.log("[Noveltrackr] run() called on:", window.location.href);

  // NU's Series Tags page is the app's tag vocabulary (plan §4.2.2)
  if (isNuPage(NU_TAGS_PATH)) {
    const tags = firstTags(NU_VOCABULARY_SELECTORS, MAX_VOCABULARY);
    console.log("[Noveltrackr] tag vocabulary page — tags found:", tags.length);

    if (tags.length > 0) {
      chrome.runtime.sendMessage({
        type: "VOCABULARY_DETECTED",
        payload: { tags },
      }).catch((e) => console.log("[Noveltrackr] vocabulary message failed:", e));
    }
    return;
  }

  const result = extractGeneric();

  // ── Chapter page ──────────────────────────────────────────────────────────
  if (result && result.chapter && result.title && /\d/.test(result.chapter)) {
    console.log("[Noveltrackr] chapter page:", result);
    chrome.runtime.sendMessage({
      type: "CHAPTER_DETECTED",
      payload: {
        title: result.title,
        chapter: result.chapter,
        url: window.location.href,
        domain: hostName(),
      }
    }).catch((e) => console.log("[Noveltrackr] sendMessage failed:", e));
    return;
  }

  // ── Index page ────────────────────────────────────────────────────────────
  if (!isIndexPage()) return;

  let indexTitle = result?.title || null;

  // NovelUpdates specific — must come before generic fallbacks
  if (!indexTitle) {
    const nuTitle = document.querySelector(".seriestitlenu");
    if (nuTitle) indexTitle = nuTitle.textContent.trim();
  }

  if (!indexTitle) {
    const h1 = document.querySelector("h1");
    if (h1) indexTitle = h1.textContent.trim();
  }

  if (!indexTitle) {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) indexTitle = ogTitle.getAttribute("content")?.trim() || null;
  }

  if (!indexTitle) {
    const raw = document.title;
    indexTitle = raw.includes(" | ")
      ? raw.substring(0, raw.lastIndexOf(" | ")).trim()
      : raw.trim();
  }

  if (!indexTitle) {
    console.log("[Noveltrackr] index page but could not extract title");
    return;
  }

  console.log("[Noveltrackr] index page, title:", indexTitle);

  // Report what the page shows. The app only accepts this for a novel it
  // already tracks, so no badge or prompt is involved (plan §4.1).
  const author = extractAuthor();
  const { source, tags } = extractTags();

  if (author || tags.length > 0) {
    chrome.runtime.sendMessage({
      type: "METADATA_DETECTED",
      payload: { title: indexTitle, author, tags, source },
    }).catch((e) => console.log("[Noveltrackr] metadata message failed:", e));
  }

  scheduleCoverDetection(indexTitle, tags.length > 0 ? { author, tags, source } : { author });
}

// Run on load, also re-run on navigation for SPA sites
run();
document.addEventListener("turbo:load", run);
document.addEventListener("pjax:end", run);