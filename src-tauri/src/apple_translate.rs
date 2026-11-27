//! macOS on-device Translation.framework.

use crate::openrouter::OrError;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};

unsafe extern "C" {
    fn apple_translate(
        text_utf8: *const c_char,
        source_lang: *const c_char,
        target_lang: *const c_char,
        out_buf: *mut c_char,
        out_buf_len: c_int,
        err_buf: *mut c_char,
        err_buf_len: c_int,
    ) -> c_int;

    fn apple_translate_status(
        source_lang: *const c_char,
        target_lang: *const c_char,
        out_buf: *mut c_char,
        out_buf_len: c_int,
    ) -> c_int;
}

pub fn status(source_lang: &str, target_lang: &str) -> Result<String, OrError> {
    let src = CString::new(source_lang).map_err(|_| OrError::Msg("lang NUL".into()))?;
    let dst = CString::new(target_lang).map_err(|_| OrError::Msg("lang NUL".into()))?;
    let mut buf = vec![0i8; 64];
    let code = unsafe {
        apple_translate_status(
            src.as_ptr(),
            dst.as_ptr(),
            buf.as_mut_ptr(),
            buf.len() as c_int,
        )
    };
    if code != 0 {
        return Err(OrError::Msg("apple_translate_status failed".into()));
    }
    Ok(unsafe { CStr::from_ptr(buf.as_ptr()) }
        .to_string_lossy()
        .into_owned())
}

pub fn translate(text: &str, source_lang: &str, target_lang: &str) -> Result<String, OrError> {
    let text_c = CString::new(text).map_err(|_| OrError::Msg("text NUL".into()))?;
    let src = CString::new(source_lang).map_err(|_| OrError::Msg("lang NUL".into()))?;
    let dst = CString::new(target_lang).map_err(|_| OrError::Msg("lang NUL".into()))?;
    let mut out = vec![0i8; 64 * 1024];
    let mut err = vec![0i8; 512];
    let code = unsafe {
        apple_translate(
            text_c.as_ptr(),
            src.as_ptr(),
            dst.as_ptr(),
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
            format!("Apple Translate failed ({code})")
        } else {
            msg
        }));
    }
    Ok(unsafe { CStr::from_ptr(out.as_ptr()) }
        .to_string_lossy()
        .into_owned())
}
