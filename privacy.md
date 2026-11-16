# Noveltrackr Privacy Policy

**Last updated: 16 November 2026**

This policy covers the Noveltrackr Chrome extension and the Noveltrackr desktop app.

Noveltrackr is local-first. It has no accounts, no cloud sync, no analytics, no ads, and no telemetry. Reading data stays on your machine.

## What the extension reads

The extension runs on pages you visit so it can tell whether a page is a chapter you are reading. It reads:

- the page title and URL
- the chapter number or chapter link
- on novel pages, the author, tags and cover image URL
- the site's own latest chapter and chapter count, when the page shows them

It does not read or store the chapter text.

## How that data is used

Only to track your reading progress: to match a page to a novel in your library, update your chapter, and fill in metadata such as the author, tags and cover. Nothing is used for advertising, profiling, analytics or any other purpose.

## Where data is stored

- **Desktop app:** in a local SQLite database at `%APPDATA%\com.aweso.noveltrackr\noveltrackr.db`, with automatic snapshots in `%APPDATA%\com.aweso.noveltrackr\backups\`.
- **Chrome extension:** in the extension's own local storage (`chrome.storage.local`) — page-to-novel mappings, pending page detections and cached tag names.

All of it is on your device. No data is sent to any server, and nothing is sold or shared with anyone.

## Network activity

The extension's only network request is to the desktop app on your own machine at `http://127.0.0.1:39172`. It makes no requests to remote servers and never fetches pages in the background.

The desktop app loads cover images from the URLs you have saved, from the sites that host them; those image requests contain no library data. Your browser loads the reading sites you visit as it normally would, and NovelUpdates searches are run by you in your browser when you choose to use them.

## No tracking, ads or accounts

There are no analytics, crash reporters, advertising SDKs, tracking pixels, accounts or sign-ins. Noveltrackr does not sell or share data, and it does not use it for any purpose other than tracking your reading.

## Deleting your data

1. **Extension:** open `chrome://extensions`, find Noveltrackr and click **Remove**. This deletes the extension's local storage, including its page-to-novel mappings.
2. **Desktop app:** uninstall Noveltrackr, then delete the `%APPDATA%\com.aweso.noveltrackr` folder. That folder contains the database and every backup snapshot, so deleting it removes all remaining data.

If you want a copy of your library before deleting it, use **Export Data** in the app.

## Contact

Questions or concerns? Open an issue at <https://github.com/R1ku1/NovelTrackr/issues>.
