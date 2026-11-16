//! macOS: Core Audio Process Tap + STT English on-device.
//! Hiện: SFSpeechRecognizer en-US. SpeechAnalyzer khi có Xcode 26 SDK.

use crate::openrouter::OrError;
use serde::Serialize;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_float, c_int, c_void};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

unsafe extern "C" {
    fn apple_listen_start(
        bundle_id_utf8: *const c_char,
        cb: Option<unsafe extern "C" fn(*const c_char, c_int, *mut c_void)>,
        status_cb: Option<unsafe extern "C" fn(*const c_char, *mut c_void)>,
        user_data: *mut c_void,
        err_buf: *mut c_char,
        err_buf_len: c_int,
    ) -> c_int;
    fn apple_listen_stop();
    fn apple_listen_running() -> c_int;
    fn apple_listen_engine(out_buf: *mut c_char, out_buf_len: c_int);
    fn apple_listen_take_peak_rms() -> c_float;
    fn apple_listen_set_gated(gated: c_int);
    fn apple_listen_set_mute_original(muted: c_int);
    fn apple_listen_mute_original() -> c_int;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleTranscriptEvent {
    pub text: String,
    pub is_final: bool,
    pub engine: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleListenStatusEvent {
    pub message: String,
}

struct BridgeState {
    app: Option<AppHandle>,
}

static BRIDGE: OnceLock<Mutex<BridgeState>> = OnceLock::new();
static STARTED: AtomicBool = AtomicBool::new(false);

fn bridge() -> &'static Mutex<BridgeState> {
    BRIDGE.get_or_init(|| Mutex::new(BridgeState { app: None }))
}

pub fn bind_app(app: AppHandle) {
    if let Ok(mut g) = bridge().lock() {
        g.app = Some(app);
    }
}

unsafe extern "C" fn on_transcript(text: *const c_char, is_final: c_int, _user: *mut c_void) {
    if text.is_null() {
        return;
    }
    let Ok(s) = (unsafe { CStr::from_ptr(text) }).to_str() else {
        return;
    };
    let evt = AppleTranscriptEvent {
        text: s.to_string(),
        is_final: is_final != 0,
        engine: current_engine(),
    };
    if let Ok(g) = bridge().lock() {
        if let Some(app) = g.app.as_ref() {
            let _ = app.emit("apple-transcript", evt);
        }
    }
}

unsafe extern "C" fn on_status(message: *const c_char, _user: *mut c_void) {
    if message.is_null() {
        return;
    }
    let Ok(s) = (unsafe { CStr::from_ptr(message) }).to_str() else {
        return;
    };
    let evt = AppleListenStatusEvent {
        message: s.to_string(),
    };
    if let Ok(g) = bridge().lock() {
        if let Some(app) = g.app.as_ref() {
            let _ = app.emit("apple-listen-status", evt);
        }
    }
}

fn current_engine() -> String {
    let mut buf = [0i8; 64];
    unsafe {
        apple_listen_engine(buf.as_mut_ptr(), buf.len() as c_int);
        CStr::from_ptr(buf.as_ptr())
            .to_string_lossy()
            .into_owned()
    }
}

pub fn start(bundle_id: &str) -> Result<String, OrError> {
    let bundle_id = bundle_id.trim();
    if bundle_id.is_empty() {
        return Err(OrError::Msg("Chưa chọn app để nghe".into()));
    }
    // Đổi app / restart: dừng tap cũ trước
    if STARTED.load(Ordering::SeqCst) {
        stop();
    }
    let bundle_c =
        CString::new(bundle_id).map_err(|_| OrError::Msg("bundle id chứa NUL".into()))?;
    let mut err = vec![0i8; 512];
    let code = unsafe {
        apple_listen_start(
            bundle_c.as_ptr(),
            Some(on_transcript),
            Some(on_status),
            std::ptr::null_mut(),
            err.as_mut_ptr(),
            err.len() as c_int,
        )
    };
    if code != 0 {
        let msg = unsafe { CStr::from_ptr(err.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        return Err(OrError::Msg(if msg.is_empty() {
            format!("apple_listen_start failed ({code})")
        } else {
            msg
        }));
    }
    STARTED.store(true, Ordering::SeqCst);
    Ok(current_engine())
}

pub fn stop() {
    if !STARTED.swap(false, Ordering::SeqCst) {
        return;
    }
    unsafe { apple_listen_stop() };
}

pub fn is_running() -> bool {
    STARTED.load(Ordering::SeqCst) && unsafe { apple_listen_running() != 0 }
}

pub fn engine() -> String {
    if !is_running() {
        return "none".into();
    }
    current_engine()
}

pub fn take_peak_rms() -> f32 {
    if !STARTED.load(Ordering::SeqCst) {
        return 0.0;
    }
    unsafe { apple_listen_take_peak_rms() }
}

/// Tạm dừng STT (TTS đang phát) để không tự thu lại tiếng mình.
pub fn set_gated(gated: bool) {
    unsafe { apple_listen_set_gated(if gated { 1 } else { 0 }) };
}

/// Tắt loa app gốc (Process Tap mute) nhưng vẫn bắt audio để STT/dịch/TTS.
pub fn set_mute_original(muted: bool) {
    unsafe { apple_listen_set_mute_original(if muted { 1 } else { 0 }) };
}

pub fn mute_original() -> bool {
    unsafe { apple_listen_mute_original() != 0 }
}
