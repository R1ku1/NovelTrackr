# Technical notes

The [README](../README.md) is the short version. This page keeps the details that matter when something does not behave as expected.

## How progress detection works

- The latest chapter the app knows about is whatever the extension last saw on a page you visited. It is never fetched in the background, and a novel nobody has browsed shows no badge rather than "0 new" — the stats say how many novels they actually have data for.
- These numbers only ever go up: a page can add information, but it can never lower your progress, lower a chapter total, or replace a count read off a table of contents with a weaker one.
- The library shows the end of the novel next to your chapter: `/ 492` with a progress bar when a real total is known, and `/ ≥273` when all the site has given is a floor — a bar is never drawn from a guess.
- NovelUpdates sits behind Cloudflare, so the extension only ever fills its search box and lets you run the search — no request is made that you did not make.
- The extension's silent page-to-app writes log to its service worker console (`chrome://extensions` → Noveltrackr → *service worker*), which is where to look when a page seems to have reported nothing.

## Page-to-novel matching (`site_mappings`)

- A page the extension cannot name — its title is the site's own furniture, so nothing matches — offers *Search my library* instead of only *Add to Library*, which would file that furniture as a novel. Picking a novel saves your chapter and remembers the page's **address**, with the chapter cut out of it (`url:/novel/shadow-slave` in `site_mappings`), so the next chapter of that novel resolves on its own. The cut is the first path segment that names a chapter, a last segment that is nothing but the chapter number, and any query holding that number; an address that leaves nothing but the site gets no link at all and the popup says so, because a link that broad would point every novel on the site at one novel. A different novel on the same site is a different address and still asks.
- The panel opens on the novels already linked from that site, newest first — filled only by a pick you made, never by the page's own guess — so the second novel on a site is a click rather than a hunt. A page already linked to the wrong novel offers *Not the right novel* from the same panel, and its chapter is still saved either way. What such a page will update is named from the library rather than from the page — the page's own title is the thing that failed — and a novel deleted since the link was made falls back to the page's title so the click still reports the stale link instead of updating nothing.

## Popup offers

- The popup stacks one card per offer — tags, cover, NovelUpdates' release — with a single *Done* below all of them. Each click answers immediately ("Saving cover…", then "✓ Cover saved") and the popup closes once the app has confirmed; a cover the library already has is never offered again, so a page that only has news uploads says exactly that.
- The popup names the novel it is about to update before the click, read from your library rather than from the page, so a wrong link is visible beforehand and *Not the right novel* sits beside it.
- A page's tags are filed silently, because the app fills empty fields only and never overwrites something you typed.

## NovelUpdates

- NovelUpdates has no chapter pages to read, so the extension learns its tag names from series pages you visit, letting the app suggest tags and match their spelling. It also turns a NovelUpdates search into a pick-list and captures the series you choose.
- NovelUpdates' newest release is offered in the popup for confirmation rather than used silently: it is another group's numbering, so it is filed as a lower bound, and the app ignores any number below the chapter you have already read.

## Interface details

- **Foil stamp:** a five-star novel's cover is foil-stamped: a permanent gold gradient frame, with a highlight that sweeps across it while you point at the cover or anywhere on its row or card (or tab to it), repeating every few seconds for as long as you stay. Hover and focus only, so an idle library is perfectly still, and reduced-motion users get the frame without the sweep. There is no tooltip; the rating is announced instead ("Rated 5 out of 5 stars"), so it never depends on movement or colour alone. The paused status is amber so it cannot be mistaken for the gold.
- **Covers:** covers load lazily (`loading="lazy"`), so opening the library fetches only the ones on screen and the webview's own cache answers the rest — nothing is stored twice, and nothing is downloaded ahead of being looked at.
- **Performance:** the library's filter and sort run when the library or a filter changes, not on every render, and a keystroke in the search box redraws only the rows that change.
