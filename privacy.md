# Noveltrackr Privacy Policy

**Last updated: 21 November 2026**

This policy covers the Noveltrackr Chrome extension and the Noveltrackr desktop app.

Noveltrackr is local-first. It has no accounts, no cloud sync, no analytics, no ads, and no telemetry. Reading data stays on your machine.

## Who is responsible

Noveltrackr is developed and operated by R1ku1, an individual developer.

For privacy questions or requests, email **awesomeagent80@gmail.com** or open an issue at <https://github.com/R1ku1/NovelTrackr/issues>.

If you email us, we receive your address and message and use them only to reply. We keep that correspondence only as long as needed to answer, on the basis of our legitimate interest in responding (Article 6(1)(f) GDPR). Correspondence is handled through Gmail (Google) and, for issues, GitHub. Both are US-based providers and process it under their own privacy policies and transfer safeguards.

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

## Third parties and transfers

We do not use a backend, cloud database, analytics service, crash reporter, advertising network, AI service or payment processor, and we do not receive your library or reading data.

Two things are worth knowing:

- **Cover images** are loaded by the desktop app directly from the addresses you have saved. The site hosting an image sees that request, including your IP address, just as it would if you opened the image in a browser. No library data is sent with it.
- **Downloads** of the desktop app are served by GitHub and the extension by the Chrome Web Store. Those services process download and store requests under their own privacy policies.

Because we do not receive personal data from the app, we do not transfer any app data internationally.

## No tracking, ads or accounts

There are no analytics, crash reporters, advertising SDKs, tracking pixels, accounts or sign-ins. Noveltrackr does not sell or share data, and it does not use it for any purpose other than tracking your reading.

## Your rights

If you are in the EU or UK, you have rights under the GDPR and UK GDPR: access, correction, erasure, restriction, objection and portability, and the right to complain to your supervisory authority.

Because everything the app stores is on your device and never reaches us, you exercise most of these rights directly:

- **Access and portability:** use **Export Data** in the app to get a JSON copy of your library.
- **Correction:** edit any novel, chapter, note or rating in the app.
- **Erasure:** see [Deleting your data](#deleting-your-data).

For an email you have sent us, you can ask us to access, correct or delete it using the contact details above. Where the GDPR applies, we will answer within one month.

## Deleting your data

1. **Extension:** open `chrome://extensions`, find Noveltrackr and click **Remove**. This deletes the extension's local storage, including its page-to-novel mappings.
2. **Desktop app:** uninstall Noveltrackr, then delete the `%APPDATA%\com.aweso.noveltrackr` folder. That folder contains the database and every backup snapshot, so deleting it removes all remaining data.
3. To remove a single novel, delete it in the app. That does not reach into existing backup snapshots — delete the folder above to remove those too.

If you want a copy of your library before deleting it, use **Export Data** in the app.

## Children

Noveltrackr is a reading tracker, not a social service, and it is not directed at children under 16. The app does not send us personal data, so we do not knowingly collect any from children.

## Changes to this policy

We will update this page and the date above when the policy changes. Material changes will also be noted in the repository.

## Contact

Email **awesomeagent80@gmail.com** for privacy questions or requests, or open an issue at <https://github.com/R1ku1/NovelTrackr/issues>.
