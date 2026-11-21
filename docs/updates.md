# Desktop updates

The desktop app checks for updates on launch and from **Check for updates** in the header. It reads a small manifest from the latest GitHub release:

```text
https://github.com/R1ku1/NovelTrackr/releases/latest/download/latest.json
```

## What the app does

1. Fetches `latest.json` over HTTPS.
2. Requires a semver newer than the installed app.
3. Requires the installer URL to be an HTTPS `github.com/R1ku1/NovelTrackr/releases/download/...` URL ending in `.exe` or `.msi`.
4. Downloads the installer into memory, checks the optional byte size, then verifies its SHA-256.
5. Only after the hash matches does it write the file to the temp folder and launch the installer.

A failed check is silent on launch; the header button reports the failure. A failed hash stops the update and never runs the file.

## Security boundary

The SHA-256 check protects against a corrupted or tampered download. The manifest is fetched from GitHub over TLS, so the hash is only as trustworthy as the release itself. The installer is currently **unsigned**, so Windows SmartScreen may still warn. Authenticode signing is the next step if the update path needs publisher authentication rather than download integrity.

## Release checklist

1. Bump the desktop version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`.
2. Build:

   ```powershell
   npm run tauri build
   ```

3. Generate the manifest from the NSIS installer:

   ```powershell
   .\scripts\make-update-manifest.ps1 `
     -Version 2.2.1 `
     -Installer "src-tauri\target\release\bundle\nsis\noveltrackr_2.2.1_x64-setup.exe" `
     -Notes "A short user-facing summary."
   ```

4. Create the release with the installer, MSI, `latest.json`, and `extension.zip`:

   ```powershell
   gh release create v2.2.1 --title "v2.2.1" --notes-file notes.md `
     "src-tauri\target\release\bundle\nsis\noveltrackr_2.2.1_x64-setup.exe" `
     "src-tauri\target\release\bundle\msi\noveltrackr_2.2.1_x64_en-US.msi" `
     latest.json extension.zip
   ```

5. The release must be published (`releases/latest`), not a draft, before existing installs can see it.

The manifest's `version` must match the tag and the installer filename. The app compares against the installed `CARGO_PKG_VERSION`.
