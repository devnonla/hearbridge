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
    let lang_c = CString::new(lang.unwrap_or("vi-VN"))
        .map_err(|_| OrError::Msg("lang chứa NUL".into()))?;
    let mut buf = vec![0i8; 256 * 1024];
    let code = unsafe {
        apple_speak_list_voices(lang_c.as_ptr(), buf.as_mut_ptr(), buf.len() as c_int)
    };
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
