function extract() {
  const docTitle = document.title;
  
  // Pattern 1: "Novel Title - Chapter N"
  // Pattern 2: "Chapter N - Novel Title"  
  // Pattern 3: "Novel Title | Chapter N"
  // Pattern 4: "Novel Title – Chapter N – Site Name"

  const patterns = [
    /^(.+?)\s*[-–|]\s*(chapter\s*[\d.]+[^-|]*?)(?:\s*[-–|].*)?$/i,
    /^(chapter\s*[\d.]+[^-|]*?)\s*[-–|]\s*(.+?)(?:\s*[-–|].*)?$/i,
  ];

  for (const pattern of patterns) {
    const match = docTitle.match(pattern);
    if (match) {
      const a = match[1].trim();
      const b = match[2].trim();
      
      // Figure out which part is the chapter
      const aIsChapter = /^chapter/i.test(a) || /^episode/i.test(a);
      
      return {
        title: aIsChapter ? b : a,
        chapter: aIsChapter ? a : b,
      };
    }
  }

  // Last resort: grab first h1 and hope for the best
  const h1 = document.querySelector("h1");
  if (h1) {
    return { title: h1.textContent.trim(), chapter: null };
  }

  return null;
}