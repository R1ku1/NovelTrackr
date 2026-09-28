# Noveltrackr

A local-first desktop application for tracking web novel, light novel, and manhwa reading progress — paired with a Chrome extension that automatically detects and updates your progress while you read.

## Features

### Desktop App
- Library view with list, grid, and compact display modes
- Add, edit, and delete novels from your personal library
- Track reading status — Reading, Planned, Paused, Completed, Dropped
- Quick chapter update without opening the full edit panel
- Alias support for alternate titles and abbreviations
- Cover image display via URL
- Author captured from the site you read on, or entered by hand
- Tags captured from the site you read on, or added by hand
- Tag suggestions from NovelUpdates' tag list, and tags normalised to its spelling
- "Find on NU" — search NovelUpdates for a novel, pick the right series, and its tags come back
- Search across titles, aliases, authors and notes with instant clear
- Filter by status, tag and author; sort by last updated, title, or chapter number
- Reading log — every status change and chapter update is recorded locally and permanently, with each novel's own history and 30-day chapter total shown in its edit panel
- Stats view — completion rate, reading pace, streaks, drop points and reasons, a year-long activity heatmap, per-tag insights with rating averages, plus where you read, what you are reading now and how old the backlog is
- Rate novels 1–5 and record why you dropped one; both feed the stats rather than sitting unused
- Export the full library to JSON, and restore it — one transaction, so a bad file changes nothing
- Automatic database snapshots — one a day plus one before every restore, next to the database in `backups/`
- "N new" badge, per-novel progress bar and an unread headline — built from the site's own chapter count, filled in as you browse and left unknown when no page has said
- Runs in system tray — close the window without closing the app

### Browser Extension (Chrome)
- Automatically detects novel title and chapter number on supported reading sites
- One-click progress update from the extension popup
- Prompts to add unrecognised novels directly to your library
- Search your library from the popup when a page's own title is just the site's furniture — pick which novel the page is, and the address is remembered so that novel's later chapters report themselves
- Remembers confirmed title-to-novel mappings so future visits are automatic
- Detects cover images on novel index pages and offers to save them, and ignores a site's own "no cover" placeholder image rather than saving it
- Reads the author off a novel page and fills it in for novels already in your library
- Reads tags off Royal Road, ScribbleHub and NovelFire novel pages and files them with their source
- Learns NovelUpdates tag names from the series pages you visit, so the app can suggest tags and match their spelling
- Turns a NovelUpdates search into a pick-list and captures the series you choose
- Reads the site's own latest chapter and chapter count off pages you are already on — a chapter menu, the last chapter of a series, or a table of contents — and reports nothing at all when a page doesn't say
- Offers NovelUpdates' newest release in the popup for confirmation rather than using it silently: it is another group's numbering, so it is filed as a lower bound, and the app ignores any number below the chapter you have already read
- Works generically across most reading sites with site-specific support for Royal Road, ScribbleHub, NovelFire and NovelUpdates

## Installation

### Desktop App
Download and run the installer from the assets below.

### Browser Extension
The extension is not on the Chrome Web Store. To install:
1. Download and extract `extension.zip` from the assets below
2. Open `chrome://extensions`
3. Enable Developer Mode (top right)
4. Click Load unpacked and select the extracted folder

The desktop app must be running (in tray is fine) for the extension to communicate with it.

## Notes
- All data is stored locally on your machine
- Database location: `%APPDATA%\com.aweso.noveltrackr\noveltrackr.db`
- Backups: `%APPDATA%\com.aweso.noveltrackr\backups\` — the last 7 daily snapshots, plus the 5 most recent copies taken before a restore. Any of them can be restored with `Restore Backup` on the stats page, or opened directly with a SQLite viewer.
- NovelUpdates sits behind Cloudflare, so the extension only ever fills its search box and lets you run the search — no request is made that you didn't make
- The latest chapter the app knows about is whatever the extension last saw on a page you visited. It is never fetched in the background, and a novel nobody has browsed shows no badge rather than "0 new" — the stats say how many novels they actually have data for
- These numbers only ever go up: a page can add information, but it can never lower your progress, lower a chapter total, or replace a count read off a table of contents with a weaker one
- The library shows the end of the novel next to your chapter: `/ 492` with a progress bar when a real total is known, and `/ ≥273` when all the site has given is a floor — a bar is never drawn from a guess
- The popup stacks one card per offer — tags, cover, NovelUpdates' release — with a single *Done* below all of them. Each click answers immediately ("Saving cover…", then "✓ Cover saved") and the popup closes once the app has confirmed; a cover the library already has is never offered again, so a page that only has news uploads says exactly that
- A page's tags are filed silently, because the app fills empty fields only and never overwrites something you typed
- A page the extension can't name — its title is the site's own furniture, so nothing matches — offers *Search my library* instead of only *Add to Library*, which would file that furniture as a novel. Picking a novel saves your chapter and remembers the page's **address**, with the chapter cut out of it (`url:/novel/shadow-slave` in `site_mappings`), so the next chapter of that novel resolves on its own. The cut is the first path segment that names a chapter, a last segment that is nothing but the chapter number, and any query holding that number; an address that leaves nothing but the site gets no link at all and the popup says so, because a link that broad would point every novel on the site at one novel. A different novel on the same site is a different address and still asks
- The panel opens on the novels already linked from that site, newest first — filled only by a pick you made, never by the page's own guess — so the second novel on a site is a click rather than a hunt. A page already linked to the wrong novel offers *Not the right novel* from the same panel, and its chapter is still saved either way
- The extension's silent page-to-app writes log to its service worker console (`chrome://extensions` → Noveltrackr → *service worker*), which is where to look when a page seems to have reported nothing
- A five-star novel's cover is foil-stamped: a permanent gold gradient frame, with a highlight that sweeps across it while you point at the cover or anywhere on its row or card (or tab to it), repeating every few seconds for as long as you stay. Hover and focus only, so an idle library is perfectly still, and reduced-motion users get the frame without the sweep. There is no tooltip; the rating is announced instead ("Rated 5 out of 5 stars"), so it never depends on movement or colour alone. The paused status is amber so it can't be mistaken for the gold
- Covers load lazily (`loading="lazy"`), so opening the library fetches only the ones on screen and the webview's own cache answers the rest — nothing is stored twice, and nothing is downloaded ahead of being looked at
- The library's filter and sort run when the library or a filter changes, not on every render, and a keystroke in the search box redraws only the rows that change
- This is a personal tool — no accounts, no cloud sync, no telemetry
