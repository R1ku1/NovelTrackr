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
- Search across titles and aliases with instant clear
- Filter by status, sort by last updated, title, or chapter number
- Export full library to JSON backup
- Runs in system tray — close the window without closing the app

### Browser Extension (Chrome)
- Automatically detects novel title and chapter number on supported reading sites
- One-click progress update from the extension popup
- Prompts to add unrecognised novels directly to your library
- Remembers confirmed title-to-novel mappings so future visits are automatic
- Detects cover images on novel index pages and offers to save them
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
- This is a personal tool — no accounts, no cloud sync, no telemetry
