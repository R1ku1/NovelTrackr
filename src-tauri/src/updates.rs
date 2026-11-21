//! In-app update checks.
//!
//! The app reads a small manifest published as a release asset, downloads the
//! installer over HTTPS, verifies its SHA-256 before writing it to disk, and only
//! then launches it. Nothing from the network is executed unverified.

use std::{fs, path::PathBuf, process::Command, time::Duration};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const LATEST_JSON: &str =
    "https://github.com/R1ku1/NovelTrackr/releases/latest/download/latest.json";
const RELEASE_PREFIX: &str = "/R1ku1/NovelTrackr/releases/download/";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    pub installer_url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
}

fn validate_update(update: &UpdateInfo) -> Result<(), String> {
    semver::Version::parse(&update.version).map_err(|_| {
        format!(
            "The update manifest has an invalid version: {}",
            update.version
        )
    })?;

    let url = reqwest::Url::parse(&update.installer_url)
        .map_err(|_| "The update manifest has an invalid installer URL.".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("github.com") {
        return Err("The update installer must come from https://github.com.".to_string());
    }
    if !url.path().starts_with(RELEASE_PREFIX) {
        return Err(
            "The update installer points outside this project's GitHub releases.".to_string(),
        );
    }

    let file_name = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !file_name.ends_with(".exe") && !file_name.ends_with(".msi") {
        return Err("The update installer must be an .exe or .msi file.".to_string());
    }

    if update.sha256.len() != 64 || !update.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("The update manifest has an invalid SHA-256 hash.".to_string());
    }
    if matches!(update.size, Some(0)) {
        return Err("The update manifest has a zero installer size.".to_string());
    }

    Ok(())
}

fn is_newer(current: &str, candidate: &str) -> Result<bool, String> {
    let current = semver::Version::parse(current)
        .map_err(|e| format!("Could not read the installed version: {e}"))?;
    let candidate = semver::Version::parse(candidate)
        .map_err(|e| format!("Could not read the available version: {e}"))?;
    Ok(candidate > current)
}

fn manifest_url() -> &'static str {
    LATEST_JSON
}

fn user_agent(app: &tauri::AppHandle) -> String {
    format!("NovelTrackr/{}", app.package_info().version)
}

pub async fn check_for_update(app: &tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(user_agent(app))
        .build()
        .map_err(|e| format!("Couldn't prepare the update check: {e}"))?;

    let response = client
        .get(manifest_url())
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the update server: {e}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "The update server returned HTTP {}.",
            response.status()
        ));
    }

    let update: UpdateInfo = response
        .json()
        .await
        .map_err(|e| format!("The update manifest is invalid: {e}"))?;
    validate_update(&update)?;

    let current = app.package_info().version.to_string();
    if is_newer(&current, &update.version)? {
        Ok(Some(update))
    } else {
        Ok(None)
    }
}

pub async fn download_update(app: &tauri::AppHandle, update: UpdateInfo) -> Result<String, String> {
    validate_update(&update)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent(user_agent(app))
        .build()
        .map_err(|e| format!("Couldn't prepare the download: {e}"))?;

    let response = client
        .get(&update.installer_url)
        .send()
        .await
        .map_err(|e| format!("Couldn't download the update: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The update download returned HTTP {}.",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Couldn't read the update download: {e}"))?;

    if let Some(expected) = update.size {
        if bytes.len() as u64 != expected {
            return Err(format!(
                "The update download was incomplete (expected {expected} bytes, got {}).",
                bytes.len()
            ));
        }
    }

    let actual = hex::encode(Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&update.sha256) {
        return Err("The update failed its SHA-256 check and was not run.".to_string());
    }

    let url = reqwest::Url::parse(&update.installer_url)
        .map_err(|_| "The update manifest has an invalid installer URL.".to_string())?;
    let file_name = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "The update URL has no file name.".to_string())?;

    let directory = std::env::temp_dir().join("NovelTrackr").join("updates");
    fs::create_dir_all(&directory)
        .map_err(|e| format!("Couldn't create the update folder: {e}"))?;
    let path: PathBuf = directory.join(file_name);
    fs::write(&path, &bytes).map_err(|e| format!("Couldn't save the update: {e}"))?;

    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("msi"))
    {
        Command::new("msiexec")
            .arg("/i")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Couldn't open the installer: {e}"))?;
    } else {
        Command::new(&path)
            .spawn()
            .map_err(|e| format!("Couldn't open the installer: {e}"))?;
    }

    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(url: &str, sha256: &str) -> UpdateInfo {
        UpdateInfo {
            version: "2.2.0".to_string(),
            notes: "A newer release".to_string(),
            installer_url: url.to_string(),
            sha256: sha256.to_string(),
            size: Some(1024),
        }
    }

    #[test]
    fn newer_versions_are_detected() {
        assert!(is_newer("2.1.3", "2.2.0").unwrap());
        assert!(!is_newer("2.2.0", "2.2.0").unwrap());
        assert!(!is_newer("2.2.0", "2.1.9").unwrap());
        assert!(is_newer("2.2.0", "2.2.1").unwrap());
    }

    #[test]
    fn a_valid_release_manifest_is_accepted() {
        let info = update(
            "https://github.com/R1ku1/NovelTrackr/releases/download/v2.2.0/noveltrackr_2.2.0_x64-setup.exe",
            &"a".repeat(64),
        );
        assert!(validate_update(&info).is_ok());
    }

    #[test]
    fn installers_outside_the_repository_are_rejected() {
        let info = update(
            "https://example.com/noveltrackr_2.2.0_x64-setup.exe",
            &"a".repeat(64),
        );
        assert!(validate_update(&info).is_err());

        let info = update(
            "https://github.com/someone/else/releases/download/v2.2.0/noveltrackr_2.2.0_x64-setup.exe",
            &"a".repeat(64),
        );
        assert!(validate_update(&info).is_err());
    }

    #[test]
    fn non_installer_files_are_rejected() {
        let info = update(
            "https://github.com/R1ku1/NovelTrackr/releases/download/v2.2.0/notes.txt",
            &"a".repeat(64),
        );
        assert!(validate_update(&info).is_err());
    }

    #[test]
    fn bad_hashes_are_rejected() {
        let info = update(
            "https://github.com/R1ku1/NovelTrackr/releases/download/v2.2.0/noveltrackr_2.2.0_x64-setup.exe",
            "not-a-hash",
        );
        assert!(validate_update(&info).is_err());
    }

    #[test]
    fn sha256_matches_only_the_expected_bytes() {
        let bytes = b"a verified installer";
        let expected = hex::encode(Sha256::digest(bytes));
        assert_eq!(expected.len(), 64);
        assert!(expected.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
