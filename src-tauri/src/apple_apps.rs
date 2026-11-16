//! Icon + preview cửa sổ app (picker kiểu Meet/OBS).

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn apple_app_icon_png_base64(bundle_id_utf8: *const c_char) -> *mut c_char;
    fn apple_app_window_preview_png_base64(pid: c_int, max_edge: c_int) -> *mut c_char;
    fn apple_apps_free(p: *mut c_char);
}

#[cfg(target_os = "macos")]
fn take_cstr(ptr: *mut c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let s = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { apple_apps_free(ptr) };
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(target_os = "macos")]
pub fn icon_png_base64(bundle_id: &str) -> Option<String> {
    let c = CString::new(bundle_id).ok()?;
    take_cstr(unsafe { apple_app_icon_png_base64(c.as_ptr()) })
}

#[cfg(target_os = "macos")]
pub fn window_preview_png_base64(pid: i32, max_edge: i32) -> Option<String> {
    take_cstr(unsafe { apple_app_window_preview_png_base64(pid as c_int, max_edge as c_int) })
}

#[cfg(not(target_os = "macos"))]
pub fn icon_png_base64(_bundle_id: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn window_preview_png_base64(_pid: i32, _max_edge: i32) -> Option<String> {
    None
}
