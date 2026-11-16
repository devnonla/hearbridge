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

/// Hủy utterance đang đọc (nếu có).
void apple_speak_stop(void);

#ifdef __cplusplus
}
#endif
