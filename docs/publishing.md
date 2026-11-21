# Publishing the extension to the Chrome Web Store

The extension is published with `scripts/publish.ps1`, which uses the Chrome Web Store API v2 and a short-lived token minted by `gcloud` service-account impersonation. No JSON key and no OAuth client are used.

## Prerequisites

- Google Cloud CLI installed and authenticated as `awesomeagent80@gmail.com`:

  ```powershell
  gcloud auth login awesomeagent80@gmail.com
  ```

- The service account `riku-796@noveltrackr.iam.gserviceaccount.com` added under **Account** in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). This is already verified working.
- The gcloud account has **Service Account Token Creator** on that service account.
- No local config file is needed. The identifiers are built into the script:
  - Publisher ID: `7357b543-b9dc-44f2-b761-d95e1dbb8175`
  - Extension ID: `fpopdhhcjefmejigbgnjeknkbloolcfb`
  - Google Cloud project: `noveltrackr`
  - Service account: `riku-796@noveltrackr.iam.gserviceaccount.com`

## Safe testing

### 1. Package only — no network

```powershell
.\scripts\publish.ps1 -PackageOnly
```

Writes `extension.zip` in the repository root. It verifies that `manifest.json` is at the archive root, entries use forward slashes, and development files are absent. It does not touch Google.

### 2. Read-only status

```powershell
.\scripts\publish.ps1 -StatusOnly
```

Mints a token, calls `fetchStatus`, and prints the published and submitted versions. It does not upload or publish.

### 3. Upload without publishing

```powershell
.\scripts\publish.ps1 -UploadOnly
```

Packages, authenticates, checks that the version is newer than both the published and submitted versions, uploads, waits for processing, and stops. It does not call the publish endpoint.

### 4. Full publish — asks for confirmation

```powershell
.\scripts\publish.ps1
```

Does the same, then asks you to type `publish`. Anything else cancels and leaves the uploaded revision unpublished.

## What the script validates

- `extension/manifest.json` exists, parses, uses manifest v3, and has a valid Chrome version.
- Every file referenced by the manifest exists.
- The zip contains only runtime files, with `manifest.json` at the root. `selfcheck.mjs`, `.git`, `node_modules`, backslash entries, and other development files are rejected.
- gcloud is installed, signed in as the expected account, and can mint a token.
- The manifest version is newer than both the published and submitted store versions.
- The upload response's `crxVersion`, when present, matches the manifest.
- Google finishes processing the upload before the confirmation prompt. `UPLOAD_FAILED` or a timeout stops the workflow before publishing.

## Version bumping

The script never changes the version. Bump `version` in `extension/manifest.json` before publishing; the Web Store rejects a version that is already published or submitted.

At the time of writing, **1.4.1 is published** and **1.4.2 is pending review**. Until 1.4.2 clears review, the script will refuse to upload 1.4.2 again — bump to 1.4.3 for the next submission.

## What the API can and cannot do

- It can upload a package to an existing item and submit it for publication.
- It cannot create a brand-new listing or edit the Store listing and Privacy tabs. Use the Developer Dashboard for those.
- A successful publish call means Google accepted the submission, not that it approved the update. `PENDING_REVIEW` and similar states are expected; approval can still fail.
- The script uses `DEFAULT_PUBLISH`, so the update goes live after approval. It does not use staged rollout.

## npm shortcuts

| Command | Same as |
| --- | --- |
| `npm run extension:zip` | `.\scripts\publish.ps1 -PackageOnly` |
| `npm run extension:status` | `.\scripts\publish.ps1 -StatusOnly` |
| `npm run extension:upload` | `.\scripts\publish.ps1 -UploadOnly` |
| `npm run extension:publish` | `.\scripts\publish.ps1` |

## GitHub releases

Store publishing and GitHub releases are separate. To attach the built zip to a release:

```powershell
gh release upload v2.1.3 extension.zip --clobber
```

Use the tag of the desktop release the extension zip belongs to.

## Notes

- The access token exists only in memory for the duration of the script. It is never printed, written to disk, or committed.
- `gcloud` prints a warning that `--scopes` is ignored for impersonated accounts. That is expected; the API call succeeds with the impersonated token, as verified with `-StatusOnly`.
- If `gcloud` is not on PATH in the current shell, the script also looks in the standard per-user Cloud SDK install directory.
- The upload zip is temporary and deleted unless `-KeepZip` is used. `-PackageOnly` deliberately keeps `extension.zip`.
