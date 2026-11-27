//! One-click install of the BlackHole 2ch virtual audio device (macOS).
//!
//! HearBridge plays the translated voice into BlackHole's output; Discord / Zoom / Meet
//! pick "BlackHole 2ch" as their microphone. The official signed .pkg is downloaded,
//! checked (SHA-256 + Developer ID Installer signature), and installed with the
//! standard macOS administrator prompt.

use crate::openrouter::OrError;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// Used when Homebrew isn't available. Keep in sync with the `blackhole-2ch` cask.
const PINNED_URL: &str = "https://existential.audio/downloads/BlackHole2ch-0.7.1.pkg";
const PINNED_SHA256: &str = "57b540f27a3e29c37e310e01bee0fdfab76733087e47f997ef9dccf851400dcf";
const DRIVER_PATH: &str = "/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver";
const BREW_PATHS: [&str; 2] = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualMicStatus {
    pub installed: bool,
}

pub fn status() -> VirtualMicStatus {
    VirtualMicStatus {
        installed: Path::new(DRIVER_PATH).exists(),
    }
}

/// Latest pkg URL + checksum from the Homebrew cask, else the pinned release.
fn package_source() -> (String, String) {
    for brew in BREW_PATHS {
        if !Path::new(brew).exists() {
            continue;
        }
        let Ok(out) = Command::new(brew)
            .args(["info", "--cask", "--json=v2", "blackhole-2ch"])
            .env("HOMEBREW_NO_AUTO_UPDATE", "1")
            .output()
        else {
            continue;
        };
        let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
            continue;
        };
        let cask = &json["casks"][0];
        if let (Some(url), Some(sha)) = (cask["url"].as_str(), cask["sha256"].as_str())
            && url.starts_with("https://existential.audio/")
            && sha.len() == 64
        {
            return (url.to_string(), sha.to_string());
        }
    }
    (PINNED_URL.to_string(), PINNED_SHA256.to_string())
}

fn sha256_of(path: &Path) -> Result<String, OrError> {
    let out = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(path)
        .output()
        .map_err(|e| OrError::Msg(format!("shasum lỗi: {e}")))?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_lowercase())
}

fn check_signature(path: &Path) -> Result<(), OrError> {
    let out = Command::new("/usr/sbin/pkgutil")
        .arg("--check-signature")
        .arg(path)
        .output()
        .map_err(|e| OrError::Msg(format!("pkgutil lỗi: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    if out.status.success() && text.contains("Developer ID Installer") {
        Ok(())
    } else {
        Err(OrError::Msg(
            "Bộ cài BlackHole không có chữ ký hợp lệ, đã dừng".into(),
        ))
    }
}

/// Download, verify and install. Shows the macOS admin password prompt; blocks until done.
pub async fn install() -> Result<VirtualMicStatus, OrError> {
    if status().installed {
        return Ok(status());
    }
    let (url, sha) = package_source();
    let bytes = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()?
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    let dir = std::env::temp_dir().join(format!("hearbridge-blackhole-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| OrError::Msg(format!("tạo thư mục tạm lỗi: {e}")))?;
    let pkg = dir.join("BlackHole2ch.pkg");
    std::fs::write(&pkg, &bytes).map_err(|e| OrError::Msg(format!("ghi bộ cài lỗi: {e}")))?;

    let result = tauri::async_runtime::spawn_blocking({
        let pkg = pkg.clone();
        move || -> Result<(), OrError> {
            if sha256_of(&pkg)? != sha.to_lowercase() {
                return Err(OrError::Msg("Checksum bộ cài BlackHole không khớp, đã dừng".into()));
            }
            check_signature(&pkg)?;
            // Path is our own temp file (no quotes); restart Core Audio so the device appears.
            let shell = format!(
                "/usr/sbin/installer -pkg '{}' -target / && (/bin/launchctl kickstart -k system/com.apple.audio.coreaudiod || /usr/bin/killall coreaudiod || true)",
                pkg.display()
            );
            let script = format!(
                "do shell script \"{}\" with prompt \"HearBridge cần quyền quản trị để cài mic ảo BlackHole 2ch.\" with administrator privileges",
                shell.replace('\\', "\\\\").replace('"', "\\\"")
            );
            let out = Command::new("/usr/bin/osascript")
                .args(["-e", &script])
                .output()
                .map_err(|e| OrError::Msg(format!("osascript lỗi: {e}")))?;
            if out.status.success() {
                return Ok(());
            }
            let err = String::from_utf8_lossy(&out.stderr);
            if err.contains("-128") {
                Err(OrError::Msg("Đã hủy cài đặt".into()))
            } else {
                Err(OrError::Msg(format!("Cài BlackHole lỗi: {}", err.trim())))
            }
        }
    })
    .await
    .map_err(|e| OrError::Msg(format!("install join: {e}")))?;

    let _ = std::fs::remove_dir_all(&dir);
    result?;
    Ok(status())
}
