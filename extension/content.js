// Runs on every page — detects novel/chapter and messages the background worker

const SITE_EXTRACTORS = {
  "royalroad.com": extractRoyalRoad,
  "scribblehub.com": extractScribbleHub,
};

function extractRoyalRoad() {
  const titleEl = document.querySelector(".fic-title h1, .fiction-title h1");
  if (!titleEl) return null;
  const title = titleEl.textContent.trim();
  let chapter = null;
  const chapterEl = document.querySelector(".chapter-title h1");
  if (chapterEl) chapter = chapterEl.textContent.trim();
  if (!chapter) {
    const parts = document.title.split(" | ")[0].split(" - ");
    if (parts.length >= 2) chapter = parts[0].trim();
  }
  return title && chapter ? { title, chapter } : null;
}

function extractScribbleHub() {
  const match = document.title.match(
    /^(.+?)\s*[-–]\s*(.+?)(\s*\||\s*-\s*Scribble)?$/
  );
  if (match) {
    const a = match[1].trim();
    const b = match[2].trim();
    const aIsChapter = /^chapter/i.test(a);
    return {
      title: aIsChapter ? b : a,
      chapter: aIsChapter ? a : b,
    };
  }
  return null;
}

function extractGeneric() {
  const docTitle = document.title;
  const patterns = [
    /^(.+?)\s*[-–|]\s*(chapter\s*[\d.]+[^-|]*?)(?:\s*[-–|].*)?$/i,
    /^(chapter\s*[\d.]+[^-|]*?)\s*[-–|]\s*(.+?)(?:\s*[-–|].*)?$/i,
  ];
  for (const pattern of patterns) {
    const match = docTitle.match(pattern);
    if (match) {
      const a = match[1].trim();
      const b = match[2].trim();
      const aIsChapter = /^chapter/i.test(a);
      return { title: aIsChapter ? b : a, chapter: aIsChapter ? a : b };
    }
  }
  return null;
}

function getExtractor() {
  const hostname = window.location.hostname.replace("www.", "");
  return SITE_EXTRACTORS[hostname] || extractGeneric;
}

function run() {
  // Only fire on actual chapter pages — must have a chapter number
  const extractor = getExtractor();
  const result = extractor();
  
  if (!result || !result.chapter || !result.title) return;
  
  // Check chapter looks real — must contain a number
  if (!/\d/.test(result.chapter)) return;

  chrome.runtime.sendMessage({
    type: "CHAPTER_DETECTED",
    payload: {
      title: result.title,
      chapter: result.chapter,
      url: window.location.href,
      domain: window.location.hostname.replace("www.", ""),
    }
  });
}

// Run on load, also re-run on navigation for SPA sites
run();
document.addEventListener("turbo:load", run);
document.addEventListener("pjax:end", run);