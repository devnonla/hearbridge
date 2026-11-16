#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// PNG icon app → base64 (malloc). Caller gọi apple_apps_free.
/// Trả NULL nếu không lấy được.
char *apple_app_icon_png_base64(const char *bundle_id_utf8);

/// Ảnh preview cửa sổ lớn nhất của PID → PNG base64 (malloc).
/// max_edge: cạnh dài tối đa (vd 320). NULL nếu không có cửa sổ / không quyền.
char *apple_app_window_preview_png_base64(int32_t pid, int32_t max_edge);

void apple_apps_free(char *p);

#ifdef __cplusplus
}
#endif
