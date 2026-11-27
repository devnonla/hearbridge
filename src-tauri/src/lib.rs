#[cfg(target_os = "macos")]
mod apple_apps;
mod apple_listen;
#[cfg(target_os = "macos")]
mod apple_speak;
#[cfg(target_os = "macos")]
mod apple_translate;
#[cfg(target_os = "macos")]
mod kokoro;
mod openrouter;
mod store;
mod system_audio;
mod updater;
#[cfg(target_os = "macos")]
mod virtual_mic;

use chrono::Utc;
use openrouter::{
    AppSettings, ConfigInfo, MeetingNotes, OrError, OrModelLists, TranscriptLineIn, UtteranceResult,
};
use store::{Meeting, MeetingSummary, TranscriptLine};
use system_audio::{AudioApp, SystemAudioChunk, SystemAudioStatus};
use uuid::Uuid;

#[tauri::command]
fn get_config() -> Result<ConfigInfo, OrError> {
    openrouter::config_info()
}

#[tauri::command]
fn save_settings(settings: AppSettings) -> Result<AppSettings, OrError> {
    openrouter::save_settings(settings)
}

#[tauri::command]
async fn list_openrouter_models() -> Result<OrModelLists, OrError> {
    openrouter::list_models().await
}

#[tauri::command]
async fn process_utterance(
    audio_base64: String,
    mime_type: String,
    role: String,
    source_lang: String,
    target_lang: String,
    word_list: Option<Vec<String>>,
    speak: Option<bool>,
) -> Result<UtteranceResult, OrError> {
    let words = word_list.unwrap_or_default();
    openrouter::process_utterance(
        &audio_base64,
        &mime_type,
        &role,
        &source_lang,
        &target_lang,
        &words,
        speak.unwrap_or(false),
    )
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeResult {
    text: String,
    stt_ms: u64,
}

#[tauri::command]
async fn transcribe_audio(
    audio_base64: String,
    mime_type: String,
    language: Option<String>,
    model: Option<String>,
) -> Result<TranscribeResult, OrError> {
    let t0 = std::time::Instant::now();
    let text = openrouter::transcribe(
        &audio_base64,
        &mime_type,
        language.as_deref(),
        model.as_deref(),
    )
    .await?;
    Ok(TranscribeResult {
        text,
        stt_ms: t0.elapsed().as_millis() as u64,
    })
}

/// Push-to-talk STT on-device: WAV (base64) → Apple SFSpeechRecognizer.
#[tauri::command]
async fn transcribe_apple(
    audio_base64: String,
    language: Option<String>,
) -> Result<TranscribeResult, OrError> {
    #[cfg(target_os = "macos")]
    {
        use base64::{Engine, engine::general_purpose::STANDARD as B64};
        let t0 = std::time::Instant::now();
        let bytes = B64
            .decode(audio_base64.trim())
            .map_err(|e| OrError::Msg(format!("audio_base64 lỗi: {e}")))?;
        let path = std::env::temp_dir().join(format!(
            "hearbridge-stt-{}-{}.wav",
            std::process::id(),
            t0.elapsed().as_nanos()
                ^ std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_default()
        ));
        std::fs::write(&path, &bytes)
            .map_err(|e| OrError::Msg(format!("ghi file STT lỗi: {e}")))?;
        let lang = language.unwrap_or_else(|| "en".into());
        let p = path.clone();
        let res =
            tauri::async_runtime::spawn_blocking(move || apple_speak::transcribe_file(&p, &lang))
                .await
                .map_err(|e| OrError::Msg(format!("apple stt join: {e}")));
        let _ = std::fs::remove_file(&path);
        let text = res??;
        if text.is_empty() {
            return Err(OrError::Msg("STT không trả text".into()));
        }
        Ok(TranscribeResult {
            text,
            stt_ms: t0.elapsed().as_millis() as u64,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (audio_base64, language);
        Err(OrError::Msg("Nhận giọng Apple chỉ hỗ trợ macOS".into()))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslateResult {
    text: String,
    translate_ms: u64,
}

#[tauri::command]
async fn translate_text(
    text: String,
    source_lang: String,
    target_lang: String,
    word_list: Option<Vec<String>>,
    context: Option<Vec<openrouter::TranslateContextTurn>>,
    engine: Option<String>,
    model: Option<String>,
) -> Result<TranslateResult, OrError> {
    let t0 = std::time::Instant::now();
    let words = word_list.unwrap_or_default();
    let ctx = context.unwrap_or_default();

    // engine: "apple" → chỉ Apple Translation trên máy (không chuyển sang API; thiếu gói → báo lỗi rõ);
    // "openrouter" → luôn OpenRouter; không truyền → Apple khi không có glossary, lỗi thì OpenRouter.
    let apple_only = engine.as_deref() == Some("apple");
    let try_apple = match engine.as_deref() {
        Some("openrouter") => false,
        Some("apple") => true,
        _ => words.is_empty(),
    };
    #[cfg(not(target_os = "macos"))]
    let _ = try_apple;

    #[cfg(target_os = "macos")]
    if try_apple {
        let src = source_lang.clone();
        let dst = target_lang.clone();
        let st = tauri::async_runtime::spawn_blocking({
            let src = src.clone();
            let dst = dst.clone();
            move || apple_translate::status(&src, &dst)
        })
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
        if st == "installed" {
            let body = text.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                apple_translate::translate(&body, &src, &dst)
            })
            .await
            {
                Ok(Ok(out)) if !out.trim().is_empty() => {
                    return Ok(TranslateResult {
                        text: out,
                        translate_ms: t0.elapsed().as_millis() as u64,
                    });
                }
                Ok(Err(e)) if apple_only => {
                    return Err(OrError::Msg(format!("Dịch Apple lỗi: {e}")));
                }
                Err(e) if apple_only => return Err(OrError::Msg(format!("Dịch Apple lỗi: {e}"))),
                Ok(Ok(_)) if apple_only => {
                    return Err(OrError::Msg("Dịch Apple không trả kết quả".into()));
                }
                Ok(Err(e)) => eprintln!("[translate] Apple → OpenRouter: {e}"),
                Err(e) => eprintln!("[translate] Apple join → OpenRouter: {e}"),
                _ => {}
            }
        } else if apple_only {
            let pair = format!(
                "{} → {}",
                source_lang.to_uppercase(),
                target_lang.to_uppercase()
            );
            return Err(OrError::Msg(match st.as_str() {
                "unsupported" => format!("Apple chưa dịch được cặp {pair}"),
                _ => format!(
                    "Chưa tải gói dịch {pair}: Cài đặt hệ thống › Chung › Ngôn ngữ & Vùng › Ngôn ngữ dịch"
                ),
            }));
        } else if !st.is_empty() && st != "installed" {
            eprintln!("[translate] Apple status={st} → OpenRouter");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = apple_only;

    let out = openrouter::translate_text(
        &text,
        &source_lang,
        &target_lang,
        &words,
        &ctx,
        model.as_deref(),
    )
    .await?;
    Ok(TranslateResult {
        text: out,
        translate_ms: t0.elapsed().as_millis() as u64,
    })
}

/// Trạng thái gói ngôn ngữ Apple Translation cho một cặp ngôn ngữ
/// ("installed", "supported" = cần tải, "unsupported", hoặc "" nếu không phải macOS).
#[tauri::command]
async fn apple_translate_status(
    source_lang: String,
    target_lang: String,
) -> Result<String, OrError> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            apple_translate::status(&source_lang, &target_lang)
        })
        .await
        .map_err(|e| OrError::Msg(format!("translate status join: {e}")))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source_lang, target_lang);
        Ok(String::new())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsResult {
    audio_base64: String,
    audio_mime: String,
    tts_ms: u64,
}

#[tauri::command]
async fn synthesize_speech(
    text: String,
    voice: Option<String>,
    model: Option<String>,
) -> Result<TtsResult, OrError> {
    let t0 = std::time::Instant::now();
    let (bytes, mime) = openrouter::synthesize(&text, voice.as_deref(), model.as_deref()).await?;
    use base64::{Engine, engine::general_purpose::STANDARD as B64};
    Ok(TtsResult {
        audio_base64: B64.encode(bytes),
        audio_mime: mime,
        tts_ms: t0.elapsed().as_millis() as u64,
    })
}

/// Play TTS audio on a named output device (e.g. BlackHole). WKWebView can't route
/// <audio> to another device (setSinkId fails), so this goes through AVAudioPlayer.
#[tauri::command]
async fn play_audio_device(
    audio_base64: String,
    device_name: String,
    monitor_device_name: Option<String>,
    volume: Option<f32>,
) -> Result<(), OrError> {
    #[cfg(target_os = "macos")]
    {
        use base64::{Engine, engine::general_purpose::STANDARD as B64};
        let bytes = B64
            .decode(audio_base64.trim())
            .map_err(|e| OrError::Msg(format!("audio_base64 lỗi: {e}")))?;
        let vol = volume.unwrap_or(1.0).clamp(0.0, 1.0);
        tauri::async_runtime::spawn_blocking(move || {
            apple_speak::play_on_device(&bytes, &device_name, monitor_device_name.as_deref(), vol)
        })
        .await
        .map_err(|e| OrError::Msg(format!("play join: {e}")))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (audio_base64, device_name, monitor_device_name, volume);
        Err(OrError::Msg("Chỉ hỗ trợ macOS".into()))
    }
}

#[tauri::command]
fn stop_audio_device() {
    #[cfg(target_os = "macos")]
    apple_speak::stop_device_playback();
}

/// Kokoro model status (downloaded? downloading?).
#[tauri::command]
fn kokoro_status() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        serde_json::json!(kokoro::status())
    }
    #[cfg(not(target_os = "macos"))]
    {
        serde_json::json!({ "installed": false, "downloading": false, "sizeBytes": 0 })
    }
}

/// Download the Kokoro model; progress arrives as `kokoro-download` events.
#[tauri::command]
async fn kokoro_download(app: tauri::AppHandle) -> Result<serde_json::Value, OrError> {
    #[cfg(target_os = "macos")]
    {
        Ok(serde_json::json!(kokoro::download(app).await?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(OrError::Msg("Chỉ hỗ trợ macOS".into()))
    }
}

/// Kokoro TTS → WAV (base64), for routing to any output device.
#[tauri::command]
async fn kokoro_render(
    text: String,
    sid: i32,
    lang: Option<String>,
    speed: Option<f32>,
) -> Result<TtsResult, OrError> {
    #[cfg(target_os = "macos")]
    {
        use base64::{Engine, engine::general_purpose::STANDARD as B64};
        let t0 = std::time::Instant::now();
        let lang = lang.unwrap_or_else(|| "en-us".into());
        let speed = speed.unwrap_or(1.0);
        let wav =
            tauri::async_runtime::spawn_blocking(move || kokoro::render(&text, sid, &lang, speed))
                .await
                .map_err(|e| OrError::Msg(format!("kokoro join: {e}")))??;
        Ok(TtsResult {
            audio_base64: B64.encode(wav),
            audio_mime: "audio/wav".into(),
            tts_ms: t0.elapsed().as_millis() as u64,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (text, sid, lang, speed);
        Err(OrError::Msg("Chỉ hỗ trợ macOS".into()))
    }
}

/// Open System Settings › Keyboard (Dictation), needed by Apple speech recognition.
#[tauri::command]
fn open_dictation_settings() -> Result<(), OrError> {
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.Keyboard-Settings.extension")
        .spawn()
        .map_err(|e| OrError::Msg(format!("Không mở được Cài đặt: {e}")))?;
    Ok(())
}

/// Whether the BlackHole virtual mic is installed.
#[tauri::command]
fn virtual_mic_status() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        serde_json::json!(virtual_mic::status())
    }
    #[cfg(not(target_os = "macos"))]
    {
        serde_json::json!({ "installed": false })
    }
}

/// Download + install BlackHole 2ch (admin prompt).
#[tauri::command]
async fn install_virtual_mic() -> Result<serde_json::Value, OrError> {
    #[cfg(target_os = "macos")]
    {
        Ok(serde_json::json!(virtual_mic::install().await?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(OrError::Msg("Chỉ hỗ trợ macOS".into()))
    }
}

/// Apple TTS rendered to WAV (not played), for routing to a chosen output device.
#[tauri::command]
async fn render_apple_tts(
    text: String,
    lang: Option<String>,
    voice_id: Option<String>,
    rate: Option<f32>,
    pitch: Option<f32>,
) -> Result<TtsResult, OrError> {
    #[cfg(target_os = "macos")]
    {
        use base64::{Engine, engine::general_purpose::STANDARD as B64};
        let t0 = std::time::Instant::now();
        let opts = apple_speak::SpeakOpts {
            lang,
            voice_id,
            rate: rate.unwrap_or(0.62).clamp(0.0, 1.0),
            pitch: pitch.unwrap_or(1.0).clamp(0.5, 2.0),
            volume: 1.0,
        };
        let bytes = tauri::async_runtime::spawn_blocking(move || apple_speak::render(&text, &opts))
            .await
            .map_err(|e| OrError::Msg(format!("render tts join: {e}")))??;
        Ok(TtsResult {
            audio_base64: B64.encode(bytes),
            audio_mime: "audio/wav".into(),
            tts_ms: t0.elapsed().as_millis() as u64,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (text, lang, voice_id, rate, pitch);
        Err(OrError::Msg("Apple TTS chỉ hỗ trợ macOS".into()))
    }
}

/// TTS on-device macOS (AVSpeechSynthesizer). Trả số ms đã nói.
#[tauri::command]
async fn speak_apple_tts(
    text: String,
    lang: Option<String>,
    voice_id: Option<String>,
    rate: Option<f32>,
    pitch: Option<f32>,
    volume: Option<f32>,
) -> Result<u64, OrError> {
    #[cfg(target_os = "macos")]
    {
        let t0 = std::time::Instant::now();
        let opts = apple_speak::SpeakOpts {
            lang,
            voice_id,
            rate: rate.unwrap_or(0.62).clamp(0.0, 1.0),
            pitch: pitch.unwrap_or(1.0).clamp(0.5, 2.0),
            volume: volume.unwrap_or(0.45).clamp(0.0, 1.0),
        };
        tauri::async_runtime::spawn_blocking(move || apple_speak::speak(&text, opts))
            .await
            .map_err(|e| OrError::Msg(e.to_string()))??;
        Ok(t0.elapsed().as_millis() as u64)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (text, lang, voice_id, rate, pitch, volume);
        Err(OrError::Msg("Apple TTS chỉ hỗ trợ macOS".into()))
    }
}

#[tauri::command]
fn stop_apple_tts() -> Result<(), OrError> {
    #[cfg(target_os = "macos")]
    {
        apple_speak::stop();
    }
    Ok(())
}

#[tauri::command]
fn list_apple_tts_voices(lang: Option<String>) -> Result<Vec<apple_speak::AppleTtsVoice>, OrError> {
    #[cfg(target_os = "macos")]
    {
        apple_speak::list_voices(lang.as_deref())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = lang;
        Ok(vec![])
    }
}

/// Mở System Settings › Accessibility › Read & Speak (Đọc và nói).
/// (Apple không cho app tự tải Siri Voice — user tải trong sheet Giọng hệ thống.)
#[tauri::command]
fn open_apple_tts_voice_settings() -> Result<(), OrError> {
    #[cfg(target_os = "macos")]
    {
        // macOS mới: pane tên "Read & Speak". URL này đã verify mở đúng pane đó.
        // (Accessibility-Settings.extension?SpokenContent đôi khi chỉ mở trang Accessibility chung.)
        let urls = [
            "x-apple.systempreferences:com.apple.Accessibility?SpokenContent",
            "x-apple.systempreferences:com.apple.Accessibility-Settings.extension?SpokenContent",
        ];
        for url in urls {
            let status = std::process::Command::new("open")
                .arg(url)
                .status()
                .map_err(|e| OrError::Msg(e.to_string()))?;
            if status.success() {
                return Ok(());
            }
        }
        Err(OrError::Msg(
            "Không mở được — vào System Settings › Accessibility › Read & Speak (Đọc và nói)"
                .into(),
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(OrError::Msg("Chỉ hỗ trợ macOS".into()))
    }
}

#[tauri::command]
async fn generate_notes(
    meeting_id: String,
    lines: Option<Vec<TranscriptLineIn>>,
) -> Result<Meeting, OrError> {
    let meeting = store::load_meeting(&meeting_id)?;
    let input_lines: Vec<TranscriptLineIn> = lines.unwrap_or_else(|| {
        meeting
            .lines
            .iter()
            .map(|l| TranscriptLineIn {
                role: l.role.clone(),
                source: l.source.clone(),
                translated: l.translated.clone(),
            })
            .collect()
    });
    let notes = openrouter::generate_notes(
        &input_lines,
        &meeting.my_lang,
        &meeting.their_lang,
        &meeting.word_list,
    )
    .await?;
    store::update_notes(&meeting_id, notes)
}

#[tauri::command]
fn create_meeting(
    title: Option<String>,
    my_lang: String,
    their_lang: String,
    word_list: Option<Vec<String>>,
) -> Result<Meeting, OrError> {
    store::create_meeting(title, my_lang, their_lang, word_list.unwrap_or_default())
}

#[tauri::command]
fn list_meetings() -> Result<Vec<MeetingSummary>, OrError> {
    store::list_meetings()
}

#[tauri::command]
fn load_meeting(id: String) -> Result<Meeting, OrError> {
    store::load_meeting(&id)
}

#[tauri::command]
fn save_meeting(meeting: Meeting) -> Result<(), OrError> {
    store::save_meeting(&meeting)
}

#[tauri::command]
fn delete_meeting(id: String) -> Result<(), OrError> {
    store::delete_meeting(&id)
}

#[tauri::command]
fn end_meeting(id: String) -> Result<Meeting, OrError> {
    store::end_meeting(&id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: args mirror the JS invoke payload
fn append_utterance(
    meeting_id: String,
    role: String,
    source: String,
    translated: String,
    source_lang: String,
    target_lang: String,
    stt_ms: u64,
    translate_ms: u64,
) -> Result<Meeting, OrError> {
    let line = TranscriptLine {
        id: Uuid::new_v4().to_string(),
        at: Utc::now(),
        role,
        source,
        translated,
        source_lang,
        target_lang,
        stt_ms,
        translate_ms,
    };
    store::append_line(&meeting_id, line)
}

#[tauri::command]
fn export_meeting(id: String, format: String) -> Result<String, OrError> {
    store::write_export(&id, &format)
}

#[tauri::command]
fn update_meeting_notes(id: String, notes: MeetingNotes) -> Result<Meeting, OrError> {
    store::update_notes(&id, notes)
}

#[tauri::command]
async fn list_audio_apps() -> Result<Vec<AudioApp>, OrError> {
    tauri::async_runtime::spawn_blocking(system_audio::list_apps)
        .await
        .map_err(|e| OrError::Msg(format!("list apps join: {e}")))?
}

#[tauri::command]
async fn start_system_audio(bundle_id: Option<String>) -> Result<SystemAudioStatus, OrError> {
    tauri::async_runtime::spawn_blocking(move || system_audio::start(bundle_id))
        .await
        .map_err(|e| OrError::Msg(format!("start audio join: {e}")))?
}

#[tauri::command]
async fn stop_system_audio() -> Result<SystemAudioStatus, OrError> {
    tauri::async_runtime::spawn_blocking(system_audio::stop)
        .await
        .map_err(|e| OrError::Msg(format!("stop audio join: {e}")))?
}

#[tauri::command]
fn system_audio_status() -> Result<SystemAudioStatus, OrError> {
    system_audio::status()
}

#[tauri::command]
async fn pull_system_utterance(
    max_wait_ms: Option<u64>,
    max_utterance_ms: Option<u64>,
) -> Result<Option<SystemAudioChunk>, OrError> {
    system_audio::pull_utterance(
        max_wait_ms.unwrap_or(12_000),
        max_utterance_ms.unwrap_or(8_000),
    )
    .await
}

#[tauri::command]
fn set_system_audio_gated(gated: bool) -> Result<(), OrError> {
    system_audio::set_gated(gated)?;
    #[cfg(target_os = "macos")]
    {
        apple_listen::set_gated(gated);
    }
    Ok(())
}

#[tauri::command]
fn clear_system_audio() -> Result<(), OrError> {
    system_audio::clear_buffer()
}

#[tauri::command]
fn duck_system_audio(pause_ms: Option<u64>) -> Result<(), OrError> {
    // Chỉ duck buffer SCK — không gate Apple Listen (Process Tap app-only;
    // gate/hủy STT giữa chừng làm khựng + lệch câu khi TTS/interpreting).
    let ms = pause_ms.unwrap_or(1200);
    system_audio::duck(ms)?;
    Ok(())
}

#[tauri::command]
fn start_apple_listen(bundle_id: Option<String>) -> Result<String, OrError> {
    #[cfg(target_os = "macos")]
    {
        let id = bundle_id.unwrap_or_default();
        apple_listen::start(&id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bundle_id;
        Err(OrError::Msg("Apple Listen chỉ hỗ trợ macOS".into()))
    }
}

#[tauri::command]
fn stop_apple_listen() -> Result<(), OrError> {
    #[cfg(target_os = "macos")]
    {
        apple_listen::stop();
    }
    Ok(())
}

#[tauri::command]
fn apple_listen_status() -> Result<serde_json::Value, OrError> {
    #[cfg(target_os = "macos")]
    {
        Ok(serde_json::json!({
            "running": apple_listen::is_running(),
            "engine": apple_listen::engine(),
            "peakRms": apple_listen::take_peak_rms(),
            "muteOriginal": apple_listen::mute_original(),
        }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(serde_json::json!({
            "running": false,
            "engine": "none",
            "peakRms": 0.0,
            "muteOriginal": false
        }))
    }
}

#[tauri::command]
fn set_apple_listen_mute_original(muted: bool) -> Result<(), OrError> {
    #[cfg(target_os = "macos")]
    {
        apple_listen::set_mute_original(muted);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = muted;
        Err(OrError::Msg("Mute âm gốc chỉ hỗ trợ macOS".into()))
    }
}

/// Running version, whether this build updates itself, and a newer version if known.
#[tauri::command]
fn update_info(app: tauri::AppHandle) -> updater::UpdateInfo {
    updater::info(&app)
}

/// Check the release feed now. `None` = up to date.
#[tauri::command]
async fn check_for_updates(
    app: tauri::AppHandle,
) -> Result<Option<updater::PendingUpdate>, String> {
    updater::check(&app).await
}

/// Download and install the newer version, then restart. Returns only on error.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    updater::install(&app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(updater::plugin())
        .manage(updater::Updates::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                apple_listen::bind_app(app.handle().clone());
            }
            updater::start_checks(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_settings,
            list_openrouter_models,
            process_utterance,
            transcribe_audio,
            transcribe_apple,
            translate_text,
            synthesize_speech,
            apple_translate_status,
            speak_apple_tts,
            render_apple_tts,
            virtual_mic_status,
            open_dictation_settings,
            kokoro_status,
            kokoro_download,
            kokoro_render,
            play_audio_device,
            stop_audio_device,
            install_virtual_mic,
            stop_apple_tts,
            list_apple_tts_voices,
            open_apple_tts_voice_settings,
            generate_notes,
            create_meeting,
            list_meetings,
            load_meeting,
            save_meeting,
            delete_meeting,
            end_meeting,
            append_utterance,
            export_meeting,
            update_meeting_notes,
            list_audio_apps,
            start_system_audio,
            stop_system_audio,
            system_audio_status,
            pull_system_utterance,
            set_system_audio_gated,
            clear_system_audio,
            duck_system_audio,
            start_apple_listen,
            stop_apple_listen,
            apple_listen_status,
            set_apple_listen_mute_original,
            update_info,
            check_for_updates,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
