#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Callback khi có transcript (UTF-8). `is_final=1` = câu hoàn chỉnh.
typedef void (*AppleListenTranscriptCb)(
    const char *text_utf8,
    int32_t is_final,
    void *user_data
);

/// Callback lỗi / cảnh báo (UTF-8), ví dụ STT fail hoặc im lặng lâu.
typedef void (*AppleListenStatusCb)(
    const char *message_utf8,
    void *user_data
);

/// Bắt audio của đúng app (bundle_id) qua Process Tap + STT tiếng Anh.
/// `bundle_id_utf8` bắt buộc — không tap global (tránh lẫn TTS/app khác).
/// Trả 0 nếu OK; khác 0 kèm message trong err_buf.
int32_t apple_listen_start(
    const char *bundle_id_utf8,
    AppleListenTranscriptCb cb,
    AppleListenStatusCb status_cb,
    void *user_data,
    char *err_buf,
    int32_t err_buf_len
);

void apple_listen_stop(void);

/// 1 = đang chạy.
int32_t apple_listen_running(void);

/// Engine đang dùng: "speechanalyzer" | "sfspeech" | "none"
void apple_listen_engine(char *out_buf, int32_t out_buf_len);

/// Peak RMS gần nhất (0..1), reset sau khi đọc.
float apple_listen_take_peak_rms(void);

/// gated=1: bỏ qua audio + hủy STT đang chạy (tránh TTS/loa bị thu lại thành transcript).
void apple_listen_set_gated(int32_t gated);

/// muted=1: tắt loa app gốc (CATapMuted) nhưng vẫn bắt audio để STT/dịch.
/// Đang Listen thì áp dụng ngay (đổi muteBehavior trên tap hoặc recreate).
void apple_listen_set_mute_original(int32_t muted);

/// 1 = đang mute âm gốc.
int32_t apple_listen_mute_original(void);

#ifdef __cplusplus
}
#endif
