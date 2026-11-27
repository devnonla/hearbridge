//! In-app updates (same model as Nonla Desk's `updater.rs`).
//!
//! `tauri-plugin-updater` reads the public key and the endpoint
//! (`releases/latest/download/latest.json` of devnonla/hearbridge) from
//! `plugins.updater` in `tauri.conf.json`. Release builds check 15 s after launch
//! and then every hour; a newer version is announced to the UI with the
//! `update:available` event and is only installed when the user asks
//! (`install_update`), so a running caption session is never cut off by a restart.
//! Download progress is sent as `update:progress`.
//!
//! Debug builds (`tauri:dev`) never check on their own and refuse to install, so
//! the dev bundle in `~/Applications/HearBridge Dev.app` is never replaced. A
//! manual `check_for_updates` still works there for testing the UI.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(15);
const INTERVAL: Duration = Duration::from_secs(60 * 60);
const AUTO_UPDATES: bool = cfg!(not(debug_assertions));

pub const EVENT_AVAILABLE: &str = "update:available";
pub const EVENT_PROGRESS: &str = "update:progress";

#[derive(Default)]
pub struct Updates {
    checking: Mutex<bool>,
    installing: Mutex<bool>,
    pending: Mutex<Option<Update>>,
}

/// A newer version found by the last check.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdate {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// What the UI shows about updates.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Running app version.
    pub version: String,
    /// Background checks run (release builds only).
    pub auto_check: bool,
    /// `install_update` is allowed (release builds only).
    pub can_install: bool,
    pub checking: bool,
    pub installing: bool,
    pub pending: Option<PendingUpdate>,
}

/// Payload of `update:progress`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    /// `downloading` | `installing` | `restarting` | `error`
    phase: &'static str,
    version: String,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u32>,
    error: Option<String>,
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

fn describe(update: &Update) -> PendingUpdate {
    PendingUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update
            .body
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_owned),
        date: update.date.map(|d| d.to_string()),
    }
}

/// Resets a busy flag when dropped, also on early return.
struct Busy<'a>(&'a Mutex<bool>);

impl<'a> Busy<'a> {
    fn take(flag: &'a Mutex<bool>) -> Option<Self> {
        let mut busy = flag.lock().unwrap();
        if *busy {
            return None;
        }
        *busy = true;
        Some(Self(flag))
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = false;
    }
}

pub fn info<R: Runtime>(app: &AppHandle<R>) -> UpdateInfo {
    let state = app.state::<Updates>();
    UpdateInfo {
        version: app.package_info().version.to_string(),
        auto_check: AUTO_UPDATES,
        can_install: AUTO_UPDATES,
        checking: *state.checking.lock().unwrap(),
        installing: *state.installing.lock().unwrap(),
        pending: state.pending.lock().unwrap().as_ref().map(describe),
    }
}

/// Background checks: once shortly after launch, then every hour (release only).
pub fn start_checks<R: Runtime>(app: &AppHandle<R>) {
    if !AUTO_UPDATES {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let Err(err) = check(&app).await {
                eprintln!("[updater] check failed: {err}");
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

/// Ask the endpoint for a newer version. Emits `update:available` with the
/// result (`null` when up to date) and remembers it for `install`.
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PendingUpdate>, String> {
    let state = app.state::<Updates>();
    let Some(_busy) = Busy::take(&state.checking) else {
        // Another check is running; report what is known.
        return Ok(state.pending.lock().unwrap().as_ref().map(describe));
    };
    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let pending = found.as_ref().map(describe);
    if let Some(p) = &pending {
        eprintln!(
            "[updater] {} is available (running {})",
            p.version, p.current_version
        );
    }
    *state.pending.lock().unwrap() = found;
    let _ = app.emit(EVENT_AVAILABLE, &pending);
    Ok(pending)
}

fn progress<R: Runtime>(app: &AppHandle<R>, payload: Progress) {
    let _ = app.emit(EVENT_PROGRESS, payload);
}

/// Download, verify and install the pending update (checking first when none is
/// known), then restart the app. Returns only on failure.
pub async fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if !AUTO_UPDATES {
        return Err("Updates are installed only in release builds.".into());
    }
    let state = app.state::<Updates>();
    let Some(_busy) = Busy::take(&state.installing) else {
        return Err("An update is already being installed.".into());
    };

    let known = state.pending.lock().unwrap().clone();
    let update = match known {
        Some(update) => update,
        None => {
            check(app).await?;
            state
                .pending
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "HearBridge is up to date.".to_string())?
        }
    };

    let version = update.version.clone();
    let mut downloaded: u64 = 0;
    let mut last_percent: Option<u32> = None;
    progress(
        app,
        Progress {
            phase: "downloading",
            version: version.clone(),
            downloaded: 0,
            total: None,
            percent: Some(0),
            error: None,
        },
    );

    let result = update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let percent = total
                    .filter(|t| *t > 0)
                    .map(|t| ((downloaded * 100) / t).min(100) as u32);
                // One event per percent step (or per chunk when the size is unknown).
                if percent.is_some() && percent == last_percent {
                    return;
                }
                last_percent = percent;
                progress(
                    app,
                    Progress {
                        phase: "downloading",
                        version: version.clone(),
                        downloaded,
                        total,
                        percent,
                        error: None,
                    },
                );
            },
            || {
                progress(
                    app,
                    Progress {
                        phase: "installing",
                        version: version.clone(),
                        downloaded: 0,
                        total: None,
                        percent: Some(100),
                        error: None,
                    },
                );
            },
        )
        .await;

    if let Err(err) = result {
        let err = err.to_string();
        eprintln!("[updater] install of {version} failed: {err}");
        progress(
            app,
            Progress {
                phase: "error",
                version,
                downloaded: 0,
                total: None,
                percent: None,
                error: Some(err.clone()),
            },
        );
        return Err(err);
    }

    eprintln!("[updater] installed {version}, restarting");
    progress(
        app,
        Progress {
            phase: "restarting",
            version,
            downloaded,
            total: None,
            percent: Some(100),
            error: None,
        },
    );
    app.restart();
}
