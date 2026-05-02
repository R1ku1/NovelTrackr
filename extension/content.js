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



function run() {
  console.log("[Noveltrackr] run() called");
  

  const result = extractGeneric();
  console.log("[Noveltrackr] extraction result:", result);
  
  if (!result || !result.chapter || !result.title) {
    console.log("[Noveltrackr] bailing — missing title or chapter:", result);
    return;
  }

  if (!/\d/.test(result.chapter)) {
    console.log("[Noveltrackr] bailing — chapter has no number:", result.chapter);
    return;
  }

  console.log("[Noveltrackr] sending message to background");
  
  chrome.runtime.sendMessage({
    type: "CHAPTER_DETECTED",
    payload: {
      title: result.title,
      chapter: result.chapter,
      url: window.location.href,
      domain: window.location.hostname.replace("www.", ""),
    }
  }).then(() => {
    console.log("[Noveltrackr] message sent successfully");
  }).catch((e) => {
    console.log("[Noveltrackr] sendMessage failed:", e);
  });
}

// Run on load, also re-run on navigation for SPA sites
run();
document.addEventListener("turbo:load", run);
document.addEventListener("pjax:end", run);