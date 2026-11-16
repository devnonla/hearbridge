#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Trạng thái cặp ngôn ngữ: "installed" | "supported" | "unsupported" | "error:…"
int32_t apple_translate_status(
    const char *source_lang,
    const char *target_lang,
    char *out_buf,
    int32_t out_buf_len
);

/// Dịch on-device (Translation.framework). Chặn đến khi xong.
/// out_buf nhận UTF-8 bản dịch; lỗi → err_buf, trả ≠0.
int32_t apple_translate(
    const char *text_utf8,
    const char *source_lang,
    const char *target_lang,
    char *out_buf,
    int32_t out_buf_len,
    char *err_buf,
    int32_t err_buf_len
);

#ifdef __cplusplus
}
#endif
