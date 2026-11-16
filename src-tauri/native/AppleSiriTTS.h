#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// 1 nếu load được private SiriTTSService.
int32_t apple_siri_available(void);

/// Liệt kê Siri neural đã tải (qua sirittsd). JSON array → out_buf.
/// Mỗi phần tử: id (=assetKey), name, lang, gender, quality="siri".
int32_t apple_siri_list_voices(
    const char *lang_bcp47,
    char *out_buf,
    int32_t out_buf_len
);

/// Đọc bằng SiriTTSDaemonSession speak. voice_asset_key = assetKey từ list.
/// rate_01 0..1 (map ~0.7..1.5). pitch/volume 0.5..2 / 0..1.
int32_t apple_siri_speak(
    const char *text_utf8,
    const char *voice_asset_key,
    float rate_01,
    float pitch,
    float volume,
    char *err_buf,
    int32_t err_buf_len
);

void apple_siri_stop(void);

#ifdef __cplusplus
}
#endif
