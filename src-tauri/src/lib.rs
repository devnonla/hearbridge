#[cfg(target_os = "macos")]
mod apple_apps;
mod apple_listen;
#[cfg(target_os = "macos")]
mod apple_speak;
#[cfg(target_os = "macos")]
mod apple_translate;
mod openrouter;
mod store;
mod system_audio;

use chrono::Utc;
use openrouter::{
    AppSettings, ConfigInfo, MeetingNotes, OrError, OrModelLists, TranscriptLineIn,
    UtteranceResult,
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
) -> Result<TranscribeResult, OrError> {
    let t0 = std::time::Instant::now();
    let text =
        openrouter::transcribe(&audio_base64, &mime_type, language.as_deref()).await?;
    Ok(TranscribeResult {
        text,
        stt_ms: t0.elapsed().as_millis() as u64,
    })
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
) -> Result<TranslateResult, OrError> {
    let t0 = std::time::Instant::now();
    let words = word_list.unwrap_or_default();
    let ctx = context.unwrap_or_default();

    // Apple on-device khi đã tải language pack; còn không / có glossary → OpenRouter.
    #[cfg(target_os = "macos")]
    if words.is_empty() {
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
                Ok(Err(e)) => eprintln!("[translate] Apple → OpenRouter: {e}"),
                Err(e) => eprintln!("[translate] Apple join → OpenRouter: {e}"),
                _ => {}
            }
        } else if !st.is_empty() && st != "installed" {
            eprintln!("[translate] Apple status={st} → OpenRouter");
        }
    }

    let out = openrouter::translate_text(&text, &source_lang, &target_lang, &words, &ctx).await?;
    Ok(TranslateResult {
        text: out,
        translate_ms: t0.elapsed().as_millis() as u64,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsResult {
    audio_base64: String,
    audio_mime: String,
    tts_ms: u64,
}

#[tauri::command]
async fn synthesize_speech(text: String, voice: Option<String>) -> Result<TtsResult, OrError> {
    let t0 = std::time::Instant::now();
    let (bytes, mime) = openrouter::synthesize(&text, voice.as_deref()).await?;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    Ok(TtsResult {
        audio_base64: B64.encode(bytes),
        audio_mime: mime,
        tts_ms: t0.elapsed().as_millis() as u64,
    })
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
        return apple_speak::list_voices(lang.as_deref());
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
            "Không mở được — vào System Settings › Accessibility › Read & Speak (Đọc và nói)".into(),
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
        return apple_listen::start(&id);
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
        return Ok(serde_json::json!({
            "running": apple_listen::is_running(),
            "engine": apple_listen::engine(),
            "peakRms": apple_listen::take_peak_rms(),
            "muteOriginal": apple_listen::mute_original(),
        }));
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
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = muted;
        Err(OrError::Msg("Mute âm gốc chỉ hỗ trợ macOS".into()))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                apple_listen::bind_app(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_settings,
            list_openrouter_models,
            process_utterance,
            transcribe_audio,
            translate_text,
            synthesize_speech,
            speak_apple_tts,
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
            set_apple_listen_mute_original
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
