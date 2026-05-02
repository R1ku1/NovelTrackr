function extract() {
  const titleEl = document.querySelector(".chp_raw .wi_fic_title, .chapter-title");
  const chapterEl = document.querySelector(".chapter-title");
  
  // ScribbleHub format: "Chapter 221 - Novel Title"
  const docTitle = document.title;
  const match = docTitle.match(/^(.+?)\s*[-–]\s*(.+?)(\s*\||\s*-\s*Scribble)?$/);
  
  if (match) {
    return {
      chapter: match[1].trim(),
      title: match[2].trim(),
    };
  }
  
  return null;
}