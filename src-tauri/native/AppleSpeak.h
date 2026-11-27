#pragma once

#include <stdint.h>
#include "AppleSiriTTS.h"

#ifdef __cplusplus
extern "C" {
#endif

/// Đọc text bằng AVSpeechSynthesizer / SiriTTSService (on-device). Chặn đến khi xong.
/// `lang_bcp47` ví dụ "vi-VN", "en-US". NULL → en-US.
/// `voice_id_utf8` identifier AVSpeech (vd. Voice 4). NULL/rỗng → tự chọn.
/// `rate_01` 0..1 (min→max AVSpeech). `pitch` ~0.5..2. `volume` 0..1.
/// Trả 0 nếu OK; khác 0 kèm err_buf.
int32_t apple_speak(
    const char *text_utf8,
    const char *lang_bcp47,
    const char *voice_id_utf8,
    float rate_01,
    float pitch,
    float volume,
    char *err_buf,
    int32_t err_buf_len
);

/// Liệt kê giọng theo ngôn ngữ → JSON array vào out_buf.
/// Trả 0 nếu OK.
int32_t apple_speak_list_voices(
    const char *lang_bcp47,
    char *out_buf,
    int32_t out_buf_len
);

/// Render text thành WAV (không phát). Thành công: *out_ptr là buffer malloc, giải phóng bằng
/// apple_speak_free. Giọng Siri neural không render được (trả 3). Không gọi trên main thread.
int32_t apple_speak_render(
    const char *text_utf8,
    const char *lang_bcp47,
    const char *voice_id_utf8,
    float rate_01,
    float pitch,
    uint8_t **out_ptr,
    int32_t *out_len,
    char *err_buf,
    int32_t err_buf_len
);

void apple_speak_free(uint8_t *ptr);

/// Nhận giọng từ file audio (WAV) bằng SFSpeechRecognizer (on-device nếu hỗ trợ).
/// Trả 0 và text (có thể rỗng nếu không nghe thấy gì) vào out_buf. Không gọi trên main thread.
int32_t apple_transcribe_file(
    const char *path_utf8,
    const char *lang_bcp47,
    char *out_buf,
    int32_t out_buf_len,
    char *err_buf,
    int32_t err_buf_len
);

/// Phát audio (WAV/MP3/AAC) ra thiết bị có tên device_name. Chặn tới khi phát xong.
/// monitor_name: NULL = không phát thêm, "" = phát thêm ra loa mặc định, khác = thiết bị đó.
int32_t apple_play_audio(
    const uint8_t *data,
    int32_t len,
    const char *device_name,
    const char *monitor_name,
    float volume,
    char *err_buf,
    int32_t err_buf_len
);

void apple_play_stop(void);

/// Hủy utterance đang đọc (nếu có).
void apple_speak_stop(void);

#ifdef __cplusplus
}
#endif
