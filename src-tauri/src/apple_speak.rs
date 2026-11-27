//! macOS on-device TTS via AVSpeechSynthesizer.

use crate::openrouter::OrError;
use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_float, c_int};

unsafe extern "C" {
    fn apple_speak(
        text_utf8: *const c_char,
        lang_bcp47: *const c_char,
        voice_id_utf8: *const c_char,
        rate_01: c_float,
        pitch: c_float,
        volume: c_float,
        err_buf: *mut c_char,
        err_buf_len: c_int,
    ) -> c_int;
    fn apple_speak_list_voices(
        lang_bcp47: *const c_char,
        out_buf: *mut c_char,
        out_buf_len: c_int,
    ) -> c_int;
    fn apple_speak_stop();
    fn apple_speak_render(
        text_utf8: *const c_char,
        lang_bcp47: *const c_char,
        voice_id_utf8: *const c_char,
        rate_01: c_float,
        pitch: c_float,
        out_ptr: *mut *mut u8,
        out_len: *mut c_int,
        err_buf: *mut c_char,
        err_buf_len: c_int,
    ) -> c_int;
    fn apple_speak_free(ptr: *mut u8);
    fn apple_play_audio(
        data: *const u8,
        len: c_int,
        device_name: *const c_char,
        monitor_name: *const c_char,
        volume: c_float,
        err_buf: *mut c_char,
        err_buf_len: c_int,
    ) -> c_int;
    fn apple_play_stop();
    fn apple_transcribe_file(
        path_utf8: *const c_char,
        lang_bcp47: *const c_char,
        out_buf: *mut c_char,
        out_buf_len: c_int,
        err_buf: *mut c_char,
        err_buf_len: c_int,
    ) -> c_int;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleTtsVoice {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub gender: String,
    pub quality: String,
}

pub struct SpeakOpts {
    pub lang: Option<String>,
    pub voice_id: Option<String>,
    pub rate: f32,
    pub pitch: f32,
    pub volume: f32,
}

pub fn speak(text: &str, opts: SpeakOpts) -> Result<(), OrError> {
    let text_c = CString::new(text).map_err(|_| OrError::Msg("TTS text chứa NUL".into()))?;
    let lang_c = CString::new(opts.lang.as_deref().unwrap_or("en-US"))
        .map_err(|_| OrError::Msg("TTS lang chứa NUL".into()))?;
    let voice_c = CString::new(opts.voice_id.as_deref().unwrap_or("").trim())
        .map_err(|_| OrError::Msg("TTS voice chứa NUL".into()))?;
    let mut err = vec![0i8; 512];
    let code = unsafe {
        apple_speak(
            text_c.as_ptr(),
            lang_c.as_ptr(),
            voice_c.as_ptr(),
            opts.rate,
            opts.pitch,
            opts.volume,
            err.as_mut_ptr(),
            err.len() as c_int,
        )
    };
    if code != 0 {
        let msg = unsafe { CStr::from_ptr(err.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        return Err(OrError::Msg(if msg.is_empty() {
            format!("apple_speak failed ({code})")
        } else {
            msg
        }));
    }
    Ok(())
}

pub fn list_voices(lang: Option<&str>) -> Result<Vec<AppleTtsVoice>, OrError> {
    let lang_c =
        CString::new(lang.unwrap_or("vi-VN")).map_err(|_| OrError::Msg("lang chứa NUL".into()))?;
    let mut buf = vec![0i8; 256 * 1024];
    let code =
        unsafe { apple_speak_list_voices(lang_c.as_ptr(), buf.as_mut_ptr(), buf.len() as c_int) };
    if code != 0 {
        let msg = unsafe { CStr::from_ptr(buf.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        return Err(OrError::Msg(if msg.is_empty() {
            format!("list voices failed ({code})")
        } else {
            msg
        }));
    }
    let json = unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy();
    let list: Vec<AppleTtsVoice> = serde_json::from_str(&json)?;
    Ok(list)
}

pub fn stop() {
    unsafe { apple_speak_stop() };
}

/// Render to WAV bytes instead of playing, so the webview can route the voice to any
/// output device. Siri neural voices can't render (error). Blocks; call off the main thread.
pub fn render(text: &str, opts: &SpeakOpts) -> Result<Vec<u8>, OrError> {
    let text_c = CString::new(text).map_err(|_| OrError::Msg("TTS text chứa NUL".into()))?;
    let lang_c = CString::new(opts.lang.as_deref().unwrap_or("en-US"))
        .map_err(|_| OrError::Msg("TTS lang chứa NUL".into()))?;
    let voice_c = CString::new(opts.voice_id.as_deref().unwrap_or("").trim())
        .map_err(|_| OrError::Msg("TTS voice chứa NUL".into()))?;
    let mut out_ptr: *mut u8 = std::ptr::null_mut();
    let mut out_len: c_int = 0;
    let mut err = vec![0i8; 512];
    let code = unsafe {
        apple_speak_render(
            text_c.as_ptr(),
            lang_c.as_ptr(),
            voice_c.as_ptr(),
            opts.rate,
            opts.pitch,
            &mut out_ptr,
            &mut out_len,
            err.as_mut_ptr(),
            err.len() as c_int,
        )
    };
    if code != 0 || out_ptr.is_null() || out_len <= 0 {
        let msg = unsafe { CStr::from_ptr(err.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        return Err(OrError::Msg(if msg.is_empty() {
            format!("apple_speak_render failed ({code})")
        } else {
            msg
        }));
    }
    let bytes = unsafe { std::slice::from_raw_parts(out_ptr, out_len as usize) }.to_vec();
    unsafe { apple_speak_free(out_ptr) };
    Ok(bytes)
}

/// Speech-to-text of a WAV file with Apple SFSpeechRecognizer (on-device when supported).
/// Empty string = no speech heard. Blocks; call off the main thread.
pub fn transcribe_file(path: &std::path::Path, lang: &str) -> Result<String, OrError> {
    let path_c = CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| OrError::Msg("STT path chứa NUL".into()))?;
    let lang_c = CString::new(lang).map_err(|_| OrError::Msg("STT lang chứa NUL".into()))?;
    let mut out = vec![0i8; 16 * 1024];
    let mut err = vec![0i8; 512];
    let code = unsafe {
        apple_transcribe_file(
            path_c.as_ptr(),
            lang_c.as_ptr(),
            out.as_mut_ptr(),
            out.len() as c_int,
            err.as_mut_ptr(),
            err.len() as c_int,
        )
    };
    if code != 0 {
        let msg = unsafe { CStr::from_ptr(err.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        return Err(OrError::Msg(if msg.is_empty() {
            format!("apple_transcribe_file failed ({code})")
        } else {
            msg
        }));
    }
    Ok(unsafe { CStr::from_ptr(out.as_ptr()) }
        .to_string_lossy()
        .trim()
        .to_string())
}

/// Play audio bytes (WAV/MP3/AAC) on the output device named `device`, optionally a copy on
/// `monitor` ("" = system default). Blocks until playback ends; call off the main thread.
pub fn play_on_device(
    bytes: &[u8],
    device: &str,
    monitor: Option<&str>,
    volume: f32,
) -> Result<(), OrError> {
    let device_c = CString::new(device).map_err(|_| OrError::Msg("device chứa NUL".into()))?;
    let monitor_c = monitor
        .map(|m| CString::new(m).map_err(|_| OrError::Msg("monitor chứa NUL".into())))
        .transpose()?;
    let mut err = vec![0i8; 512];
    let code = unsafe {
        apple_play_audio(
            bytes.as_ptr(),
            bytes.len() as c_int,
            device_c.as_ptr(),
            monitor_c.as_ref().map_or(std::ptr::null(), |m| m.as_ptr()),
            volume,
            err.as_mut_ptr(),
            err.len() as c_int,
        )
    };
    if code != 0 {
        let msg = unsafe { CStr::from_ptr(err.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        return Err(OrError::Msg(if msg.is_empty() {
            format!("apple_play_audio failed ({code})")
        } else {
            msg
        }));
    }
    Ok(())
}

pub fn stop_device_playback() {
    unsafe { apple_play_stop() };
}
