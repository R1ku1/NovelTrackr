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
- Search across titles and aliases with instant clear
- Filter by status, sort by last updated, title, or chapter number
- Reading log — every status change and chapter update is recorded locally and permanently, with each novel's own history and 30-day chapter total shown in its edit panel
- Stats view — completion rate, reading pace, streaks, drop points, a year-long activity heatmap, plus tag-based insights
- Export the full library to JSON, and restore it — one transaction, so a bad file changes nothing
- Automatic database snapshots — one a day plus one before every restore, next to the database in `backups/`
- Runs in system tray — close the window without closing the app

### Browser Extension (Chrome)
- Automatically detects novel title and chapter number on supported reading sites
- One-click progress update from the extension popup
- Prompts to add unrecognised novels directly to your library
- Remembers confirmed title-to-novel mappings so future visits are automatic
- Detects cover images on novel index pages and offers to save them
- Reads the author off a novel page and fills it in for novels already in your library
- Reads tags off Royal Road, ScribbleHub and NovelFire novel pages and files them with their source
- Learns NovelUpdates tag names from the series pages you visit, so the app can suggest tags and match their spelling
- Turns a NovelUpdates search into a pick-list and captures the series you choose
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
- This is a personal tool — no accounts, no cloud sync, no telemetry
