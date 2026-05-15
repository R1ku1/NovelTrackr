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
    ".seriesediting img",
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

function run() {
  console.log("[Noveltrackr] run() called on:", window.location.href);

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
        domain: window.location.hostname.replace("www.", ""),
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

  setTimeout(() => {
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
        domain: window.location.hostname.replace("www.", ""),
      }
    }).catch((e) => console.log("[Noveltrackr] cover message failed:", e));
  }, 1000);
}

// Run on load, also re-run on navigation for SPA sites
run();
document.addEventListener("turbo:load", run);
document.addEventListener("pjax:end", run);