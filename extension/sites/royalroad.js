function extract() {
  const titleEl = document.querySelector(".fic-title h1, .fiction-title h1");
  const chapterEl = document.querySelector(".chapter-title h1, .chapter-content h1");
  
  if (!titleEl) return null;
  
  const title = titleEl.textContent.trim();
  
  // Try chapter from heading first
  let chapter = null;
  if (chapterEl) {
    chapter = chapterEl.textContent.trim();
  }
  
  // Fallback: parse from document title
  // RR format: "Chapter Name - Novel Title | Royal Road"
  if (!chapter) {
    const parts = document.title.split(" | ")[0].split(" - ");
    if (parts.length >= 2) chapter = parts[0].trim();
  }
  
  return { title, chapter };
}