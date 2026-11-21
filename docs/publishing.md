# Publishing the extension to the Chrome Web Store

The extension is published through the **Chrome Web Store API v2** using a Google Cloud service account. This page is the setup checklist; day-to-day publishing is one command.

The item ID is `fpopdhhcjefmejigbgnjeknkbloolcfb`.

## One-time setup

### 1. Add the service account to the Web Store

1. Open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Open **Account** (some versions label it **Publisher > Settings**).
3. Paste the service account email into the service-account field and save:
   `riku-796@noveltrackr.iam.gserviceaccount.com`
4. Copy the **Publisher ID** shown on the same page.

The grant is publisher-wide: the service account can manage every item owned by that publisher, not just Noveltrackr. Google allows one service account per publisher.

### 2. Create a JSON key

1. Open the [service accounts page](https://console.cloud.google.com/iam-admin/serviceaccounts?project=noveltrackr).
2. Select `riku-796@noveltrackr.iam.gserviceaccount.com`.
3. Open **Keys → Add key → Create new key → JSON**.
4. Save the downloaded file to:

   ```
   %APPDATA%\NovelTrackr\chrome-webstore-key.json
   ```

   Create the folder first if needed:

   ```powershell
   New-Item -ItemType Directory -Force "$env:APPDATA\NovelTrackr"
   ```

No IAM role is needed on the service account — its authority comes from the Developer Dashboard grant.

> The JSON key is a credential. Keep it out of this repository and never paste it into a chat or issue. If it is exposed, delete the key in Google Cloud and create a new one.

### 3. Save the Publisher ID

Create `scripts/chrome-webstore.local.json`:

```json
{
  "publisherId": "YOUR_PUBLISHER_ID"
}
```

That file is gitignored. Alternatively, set `CWS_PUBLISHER_ID` in the environment. To keep the key elsewhere, set `CWS_SERVICE_ACCOUNT_KEY` to its path.

### 4. Verify

```bash
npm run extension:status
```

This is read-only. It mints a short-lived access token from the JSON key and prints the published and submitted versions. It should report the current store version, `1.4.1`.

## Publishing an update

1. Bump `version` in `extension/manifest.json` — the Web Store rejects a version that is already published.
2. Run:

   ```bash
   npm run extension:publish
   ```

That command builds `extension.zip` with `manifest.json` at the root, uploads it, waits for Google to finish processing, and publishes with `DEFAULT_PUBLISH`. Publishing submits the build for Chrome Web Store review.

Other commands:

| Command | Effect |
| --- | --- |
| `npm run extension:zip` | Build `extension.zip` only |
| `npm run extension:status` | Show published/submitted versions |
| `npm run extension:upload` | Build and upload, but do not publish |
| `npm run extension:publish` | Build, upload, wait, and publish |

The API cannot create a brand-new listing or edit the Store listing and Privacy tabs. Do those in the Developer Dashboard when they change.

## GitHub releases

Store publishing and GitHub releases are separate. The release page still needs the zip attached:

```bash
gh release upload v2.1.3 extension.zip --clobber
```

Use the tag of the desktop release the extension zip belongs to.
