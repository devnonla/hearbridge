use base64::{Engine, engine::general_purpose::STANDARD as B64};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, thiserror::Error)]
pub enum OrError {
    #[error("{0}")]
    Msg(String),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for OrError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub stt_model: String,
    pub translate_model: String,
    pub notes_model: String,
    pub tts_model: String,
    pub tts_voice: String,
    /// Công cụ đọc bản dịch: "apple" (on-device) hoặc "openrouter". Settings cũ thiếu → "apple".
    #[serde(default = "default_tts_engine")]
    pub tts_engine: String,
    /// Giọng Kokoro hướng "Nghe" (vd. af_heart).
    #[serde(default)]
    pub kokoro_voice: String,
    #[serde(default = "default_kokoro_speed")]
    pub kokoro_speed: f32,
    /// Nhận giọng khi nghe app: "apple" (SpeechAnalyzer on-device) hoặc "openrouter".
    #[serde(default = "default_tts_engine")]
    pub stt_engine: String,
    /// Dịch: "apple" (Translation.framework, cần tải gói ngôn ngữ) hoặc "openrouter".
    #[serde(default = "default_tts_engine")]
    pub translate_engine: String,
    /// Cài đặt riêng hướng "Nói" (engine, model, giọng). Frontend quản lý cấu trúc.
    #[serde(default)]
    pub speak: serde_json::Value,
    /// Identifier AVSpeech (Voice 3/4…). Rỗng = tự chọn. Settings cũ thiếu → "".
    #[serde(default)]
    pub apple_tts_voice: String,
    /// 0..1 — chậm→nhanh (map min→max AVSpeech). Mặc định ~hơi nhanh.
    #[serde(default = "default_apple_tts_rate")]
    pub apple_tts_rate: f32,
    /// 0.5..2 — cao độ. 1 = trung tính.
    #[serde(default = "default_apple_tts_pitch")]
    pub apple_tts_pitch: f32,
    /// 0..1 — âm lượng Apple TTS.
    #[serde(default = "default_apple_tts_volume")]
    pub apple_tts_volume: f32,
    /// Ngôn ngữ bạn nói (interpreting)
    pub my_lang: String,
    /// Ngôn ngữ phía kia / họp
    pub their_lang: String,
    pub word_list: Vec<String>,
    pub auto_notes_every: u32,
    /// OpenRouter API key. Settings cũ thiếu field → "".
    #[serde(default)]
    pub openrouter_api_key: String,
    /// Base URL tùy chọn; rỗng → mặc định openrouter.ai
    #[serde(default)]
    pub openrouter_base_url: String,
}

#[derive(Clone)]
struct RuntimeConfig {
    api_key: String,
    base_url: String,
    settings: AppSettings,
}

const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";

static RUNTIME: OnceLock<Mutex<RuntimeConfig>> = OnceLock::new();

fn first_nonempty(vals: &[String]) -> String {
    for v in vals {
        let t = v.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    String::new()
}

fn require_api_key(c: &RuntimeConfig) -> Result<String, OrError> {
    let k = c.api_key.trim();
    if k.is_empty() {
        return Err(OrError::Msg(
            "Thiếu OpenRouter API key — mở Cài đặt để nhập".into(),
        ));
    }
    Ok(k.to_string())
}

/// Per-call model override (e.g. the "Nói" direction); empty → the saved default.
fn pick_model(over: Option<&str>, default: &str) -> String {
    over.map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(default)
        .to_string()
}

fn default_kokoro_speed() -> f32 {
    1.0
}

/// Mặc định cho mọi engine: Apple on-device.
fn default_tts_engine() -> String {
    "apple".into()
}
fn default_apple_tts_rate() -> f32 {
    0.62
}
fn default_apple_tts_pitch() -> f32 {
    1.0
}
fn default_apple_tts_volume() -> f32 {
    0.45
}

fn app_data_dir() -> Result<PathBuf, OrError> {
    let base = dirs::data_dir().ok_or_else(|| OrError::Msg("Không tìm thấy data dir".into()))?;
    let dir = base.join("hearbridge");
    std::fs::create_dir_all(&dir)?;
    // Migrate settings from older app folders if present
    let new_settings = dir.join("settings.json");
    if !new_settings.is_file() {
        for legacy_name in ["relais", "cicada-tauri"] {
            let legacy_settings = base.join(legacy_name).join("settings.json");
            if legacy_settings.is_file() {
                let _ = std::fs::copy(&legacy_settings, &new_settings);
                break;
            }
        }
    }
    Ok(dir)
}

fn settings_path() -> Result<PathBuf, OrError> {
    Ok(app_data_dir()?.join("settings.json"))
}

fn default_settings() -> AppSettings {
    AppSettings {
        stt_model: "openai/gpt-4o-mini-transcribe".into(),
        translate_model: "openai/gpt-4o-mini".into(),
        notes_model: "openai/gpt-4o-mini".into(),
        tts_model: "openai/gpt-4o-mini-tts".into(),
        tts_voice: "alloy".into(),
        tts_engine: default_tts_engine(),
        kokoro_voice: String::new(),
        kokoro_speed: default_kokoro_speed(),
        stt_engine: default_tts_engine(),
        translate_engine: default_tts_engine(),
        speak: serde_json::Value::Null,
        apple_tts_voice: String::new(),
        apple_tts_rate: default_apple_tts_rate(),
        apple_tts_pitch: default_apple_tts_pitch(),
        apple_tts_volume: default_apple_tts_volume(),
        my_lang: "vi".into(),
        their_lang: "en".into(),
        word_list: Vec::new(),
        auto_notes_every: 8,
        openrouter_api_key: String::new(),
        openrouter_base_url: String::new(),
    }
}

fn ensure_runtime() -> Result<&'static Mutex<RuntimeConfig>, OrError> {
    if let Some(rt) = RUNTIME.get() {
        return Ok(rt);
    }
    let mut settings = default_settings();
    if let Ok(path) = settings_path()
        && path.is_file()
        && let Ok(raw) = std::fs::read_to_string(&path)
        && let Ok(saved) = serde_json::from_str::<AppSettings>(&raw)
    {
        settings = saved;
    }

    let api_key = settings.openrouter_api_key.trim().to_string();

    let base_url = first_nonempty(&[
        settings.openrouter_base_url.clone(),
        DEFAULT_BASE_URL.into(),
    ])
    .trim_end_matches('/')
    .to_string();
    if settings.openrouter_base_url.trim().is_empty() {
        settings.openrouter_base_url = base_url.clone();
    }

    let cfg = RuntimeConfig {
        api_key,
        base_url,
        settings,
    };
    let _ = RUNTIME.set(Mutex::new(cfg));
    Ok(RUNTIME.get().unwrap())
}

fn with_cfg<R>(f: impl FnOnce(&RuntimeConfig) -> R) -> Result<R, OrError> {
    let rt = ensure_runtime()?;
    let guard = rt
        .lock()
        .map_err(|_| OrError::Msg("settings lock poisoned".into()))?;
    Ok(f(&guard))
}

pub fn save_settings(settings: AppSettings) -> Result<AppSettings, OrError> {
    let mut settings = settings;
    let path = settings_path()?;
    let rt = ensure_runtime()?;
    let mut guard = rt
        .lock()
        .map_err(|_| OrError::Msg("settings lock poisoned".into()))?;

    // Ô key để trống khi lưu → giữ key cũ (tránh xóa nhầm)
    if settings.openrouter_api_key.trim().is_empty() && !guard.api_key.is_empty() {
        settings.openrouter_api_key = guard.api_key.clone();
    }
    if settings.openrouter_base_url.trim().is_empty() {
        settings.openrouter_base_url = guard.base_url.clone();
    }

    std::fs::write(&path, serde_json::to_string_pretty(&settings)?)?;
    guard.api_key = settings.openrouter_api_key.trim().to_string();
    guard.base_url = settings
        .openrouter_base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    if guard.base_url.is_empty() {
        guard.base_url = DEFAULT_BASE_URL.into();
        settings.openrouter_base_url = guard.base_url.clone();
    }
    guard.settings = settings.clone();
    Ok(settings)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInfo {
    pub has_key: bool,
    pub base_url: String,
    pub settings: AppSettings,
}

pub fn config_info() -> Result<ConfigInfo, OrError> {
    with_cfg(|c| ConfigInfo {
        has_key: !c.api_key.is_empty(),
        base_url: c.base_url.clone(),
        settings: c.settings.clone(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrModel {
    pub id: String,
    pub name: String,
    pub input_modalities: Vec<String>,
    pub output_modalities: Vec<String>,
    pub supported_voices: Vec<String>,
    pub capability: String,
    /// Giá hiển thị sẵn (VD: "$0.15 / $0.6")
    pub price_label: String,
    pub prompt_price: Option<f64>,
    pub completion_price: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrModelLists {
    pub stt: Vec<OrModel>,
    pub tts: Vec<OrModel>,
    pub chat: Vec<OrModel>,
    pub fetched_at: String,
}

fn parse_str_list(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_price_num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| {
        x.as_f64()
            .or_else(|| x.as_str().and_then(|s| s.parse::<f64>().ok()))
    })
}

/// $/M (Drama $10, chat…) — số nguyên, không thập phân.
fn format_money_int(v: f64) -> String {
    format!("${}", v.round() as i64)
}

/// Giá nhỏ (STT $/giây, $/giờ) — giữ số như OpenRouter, bỏ zero thừa.
fn format_rate(v: f64) -> String {
    if v == 0.0 {
        return "$0".into();
    }
    if v >= 1.0 {
        return format_money_int(v);
    }
    // Tối đa 8 chữ số thập phân, cắt 0 cuối: 0.000003 → $0.000003
    let s = format!("{v:.8}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    format!("${s}")
}

/// $/M có thể lẻ (gpt-4o-mini-transcribe $1.25) — nguyên nếu tròn, không thì 2 số.
fn format_per_million(per_token: f64) -> String {
    let v = per_token * 1_000_000.0;
    if (v - v.round()).abs() < 1e-6 {
        format_money_int(v)
    } else {
        let s = format!("{v:.2}");
        let s = s.trim_end_matches('0').trim_end_matches('.');
        format!("${s}")
    }
}

/// OpenRouter pricing:
/// - TTS: $/token|byte → ×1e6 = $/M (Drama 3 = $10/M)
/// - STT token (có completion): ×1e6 = $/M tok
/// - STT duration: API đã là $/giây (Whisper) hoặc $/giờ nếu ≥0.01 (MAI)
/// - Chat: $/token → $/M
fn format_price_label(capability: &str, prompt: Option<f64>, completion: Option<f64>) -> String {
    let p = prompt.unwrap_or(0.0);
    let c = completion.unwrap_or(0.0);
    if p == 0.0 && c == 0.0 {
        return "—".into();
    }
    match capability {
        "tts" => {
            // Drama $10/M; model rẻ hơn có thể lẻ (vd. $0.62/M)
            if c > 0.0 {
                format!("{} / {}", format_per_million(p), format_per_million(c))
            } else {
                format_per_million(p)
            }
        }
        "stt" => {
            if c > 0.0 {
                // openai/gpt-4o-*-transcribe…: chỉ hiện $in / $out
                format!("{} / {}", format_per_million(p), format_per_million(c))
            } else if p >= 0.01 {
                // microsoft/mai-transcribe-*: API = $/giờ
                format!("${p:.2}/giờ")
            } else {
                // Whisper, Deepgram…: API = $/giây
                format!("{}/giây", format_rate(p))
            }
        }
        _ => {
            // Chat/translate: gpt-4o-mini → "$0.15 / $0.6"
            if c > 0.0 {
                format!("{} / {}", format_per_million(p), format_per_million(c))
            } else {
                format_per_million(p)
            }
        }
    }
}

fn parse_model_item(item: &Value, capability: &str) -> Option<OrModel> {
    let id = item
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() || id.contains(":batch") || id.starts_with('~') {
        return None;
    }
    let name = item
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or(&id)
        .to_string();
    let arch = item.get("architecture").cloned().unwrap_or(json!({}));
    let input = parse_str_list(&arch, "input_modalities");
    let output = parse_str_list(&arch, "output_modalities");
    let voices = parse_str_list(item, "supported_voices");
    let pricing = item.get("pricing").cloned().unwrap_or(json!({}));
    let prompt_price = parse_price_num(&pricing, "prompt");
    let completion_price = parse_price_num(&pricing, "completion");
    let price_label = format_price_label(capability, prompt_price, completion_price);
    Some(OrModel {
        id,
        name,
        input_modalities: input,
        output_modalities: output,
        supported_voices: voices,
        capability: capability.to_string(),
        price_label,
        prompt_price,
        completion_price,
    })
}

async fn fetch_models_by_modality(
    base_url: &str,
    api_key: &str,
    output_modalities: &str,
) -> Result<Vec<Value>, OrError> {
    let url = format!("{base_url}/models?output_modalities={output_modalities}&limit=1000");
    let res = client()?
        .get(url)
        .headers(auth_headers(api_key))
        .send()
        .await?;
    let status = res.status();
    let body = res.text().await?;
    if !status.is_success() {
        return Err(OrError::Msg(format!(
            "Models ({output_modalities}) {status}: {}",
            truncate(&body, 400)
        )));
    }
    let v: Value = serde_json::from_str(&body)?;
    Ok(v.get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default())
}

/// Chuẩn hóa giá để sort rẻ → mắc trong cùng nhóm capability.
fn sort_cost(m: &OrModel) -> f64 {
    let p = m.prompt_price.unwrap_or(f64::INFINITY);
    let c = m.completion_price.unwrap_or(0.0);
    if !p.is_finite() {
        return f64::INFINITY;
    }
    match m.capability.as_str() {
        // STT duration lưu $/giờ (≥0.01) → đổi về $/giây cho đồng bộ với Whisper
        "stt" if c == 0.0 && p >= 0.01 => p / 3600.0,
        // Chat/TTS/STT token: ưu tiên input, cộng nhẹ output
        _ => p + c * 0.5,
    }
}

fn dedupe_sort(list: &mut Vec<OrModel>) {
    list.sort_by(|a, b| a.id.cmp(&b.id));
    list.dedup_by(|a, b| a.id == b.id);
    // Rẻ → mắc
    list.sort_by(|a, b| {
        sort_cost(a)
            .partial_cmp(&sort_cost(b))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
    });
}

pub async fn list_models() -> Result<OrModelLists, OrError> {
    let (api_key, base_url) =
        with_cfg(|c| -> Result<_, OrError> { Ok((require_api_key(c)?, c.base_url.clone())) })??;

    // OpenRouter modality:
    // - STT = transcription (POST /audio/transcriptions)
    // - TTS = speech (POST /audio/speech) — KHÔNG phải output "audio" (chat đa modal)
    let stt_raw = fetch_models_by_modality(&base_url, &api_key, "transcription").await?;
    let tts_raw = fetch_models_by_modality(&base_url, &api_key, "speech").await?;
    let chat_raw = fetch_models_by_modality(&base_url, &api_key, "text").await?;

    let mut stt: Vec<OrModel> = stt_raw
        .iter()
        .filter_map(|item| {
            let m = parse_model_item(item, "stt")?;
            // Chỉ nhận transcription; loại chat multimodal audio
            if m.output_modalities.iter().any(|x| x == "transcription")
                || m.output_modalities.is_empty()
            {
                Some(m)
            } else {
                None
            }
        })
        .collect();
    let mut tts: Vec<OrModel> = tts_raw
        .iter()
        .filter_map(|item| {
            let m = parse_model_item(item, "tts")?;
            // TTS = speech. Loại model chỉ có audio (gpt-audio, lyria…)
            let has_speech = m.output_modalities.iter().any(|x| x == "speech");
            let audio_only = m.output_modalities.iter().any(|x| x == "audio") && !has_speech;
            if audio_only {
                return None;
            }
            if has_speech || m.output_modalities.is_empty() {
                Some(m)
            } else {
                None
            }
        })
        .collect();
    let mut chat: Vec<OrModel> = chat_raw
        .iter()
        .filter_map(|item| {
            let m = parse_model_item(item, "chat")?;
            let out = &m.output_modalities;
            if out.iter().any(|x| x == "transcription" || x == "speech")
                && !out.iter().any(|x| x == "text")
            {
                return None;
            }
            if !m.input_modalities.iter().any(|x| x == "text") {
                return None;
            }
            Some(m)
        })
        .collect();

    dedupe_sort(&mut stt);
    dedupe_sort(&mut tts);
    dedupe_sort(&mut chat);

    Ok(OrModelLists {
        stt,
        tts,
        chat,
        fetched_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn client() -> Result<reqwest::Client, OrError> {
    Ok(reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?)
}

fn auth_headers(api_key: &str) -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        reqwest::header::AUTHORIZATION,
        format!("Bearer {api_key}").parse().unwrap(),
    );
    h.insert("HTTP-Referer", "http://localhost:1420".parse().unwrap());
    h.insert("X-Title", "HearBridge".parse().unwrap());
    h
}

pub fn lang_name(code: &str) -> &'static str {
    match code {
        "vi" => "Vietnamese",
        "en" => "English",
        "zh" => "Chinese",
        "ja" => "Japanese",
        "ko" => "Korean",
        "fr" => "French",
        "de" => "German",
        "es" => "Spanish",
        _ => "the target language",
    }
}

fn truncate(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(n).collect::<String>())
    }
}

fn word_list_hint(words: &[String]) -> String {
    let cleaned: Vec<_> = words
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .take(80)
        .collect();
    if cleaned.is_empty() {
        String::new()
    } else {
        format!(
            " Prefer these glossary terms exactly when relevant: {}.",
            cleaned.join("; ")
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateContextTurn {
    pub source: String,
    pub translated: String,
}

fn clip_ctx(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(max).collect::<String>())
    }
}

pub async fn transcribe(
    audio_base64: &str,
    mime_type: &str,
    language: Option<&str>,
    model: Option<&str>,
) -> Result<String, OrError> {
    let (api_key, base_url, stt_model) = with_cfg(|c| -> Result<_, OrError> {
        Ok((
            require_api_key(c)?,
            c.base_url.clone(),
            pick_model(model, &c.settings.stt_model),
        ))
    })??;

    let bytes = B64
        .decode(audio_base64.trim())
        .map_err(|e| OrError::Msg(format!("audio_base64 lỗi: {e}")))?;
    if bytes.len() < 800 {
        return Err(OrError::Msg("Audio quá ngắn".into()));
    }

    let ext = if mime_type.contains("wav") {
        "wav"
    } else if mime_type.contains("mp4") || mime_type.contains("m4a") {
        "mp4"
    } else if mime_type.contains("ogg") {
        "ogg"
    } else if mime_type.contains("mpeg") || mime_type.contains("mp3") {
        "mp3"
    } else {
        "webm"
    };
    let part = Part::bytes(bytes)
        .file_name(format!("audio.{ext}"))
        .mime_str(mime_type)
        .map_err(|e| OrError::Msg(e.to_string()))?;

    let mut form = Form::new().text("model", stt_model).part("file", part);
    if let Some(lang) = language.filter(|s| !s.is_empty() && *s != "auto") {
        form = form.text("language", lang.to_string());
    }

    let res = client()?
        .post(format!("{base_url}/audio/transcriptions"))
        .headers(auth_headers(&api_key))
        .multipart(form)
        .send()
        .await?;

    let status = res.status();
    let body = res.text().await?;
    if !status.is_success() {
        return Err(OrError::Msg(format!(
            "STT {status}: {}",
            truncate(&body, 400)
        )));
    }
    let v: Value = serde_json::from_str(&body)?;
    let text = v
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(OrError::Msg("STT không trả text".into()));
    }
    Ok(text)
}

fn openrouter_error_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    let err = v.get("error")?;
    let msg = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("OpenRouter error")
        .trim();
    let code = err
        .get("code")
        .and_then(|c| c.as_u64().or_else(|| c.as_i64().map(|n| n as u64)));
    Some(match code {
        Some(c) => format!("{c}: {msg}"),
        None => msg.to_string(),
    })
}

fn translate_retryable(status: reqwest::StatusCode, body: &str, empty_content: bool) -> bool {
    if empty_content {
        return true;
    }
    if matches!(
        status.as_u16(),
        408 | 429 | 500 | 502 | 503 | 520 | 522 | 524
    ) {
        return true;
    }
    // OpenRouter đôi khi HTTP 200 nhưng body.error = 429/502
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(code) = v
            .pointer("/error/code")
            .and_then(|c| c.as_u64().or_else(|| c.as_i64().map(|n| n as u64)))
        {
            return matches!(code, 408 | 429 | 500 | 502 | 503 | 520 | 522 | 524);
        }
        if v.get("error").is_some() {
            return true;
        }
    }
    false
}

fn retry_after_ms(res: &reqwest::Response, attempt: u32) -> u64 {
    if let Some(raw) = res.headers().get(reqwest::header::RETRY_AFTER)
        && let Ok(s) = raw.to_str()
        && let Ok(secs) = s.trim().parse::<u64>()
    {
        return (secs.saturating_mul(1000)).clamp(400, 20_000);
    }
    // 0.5s, 1.2s, 2.5s…
    let base = 500u64.saturating_mul(1u64 << attempt.min(3));
    (base + 200 * u64::from(attempt)).clamp(400, 8_000)
}

pub async fn translate_text(
    text: &str,
    source_lang: &str,
    target_lang: &str,
    word_list: &[String],
    context: &[TranslateContextTurn],
    model: Option<&str>,
) -> Result<String, OrError> {
    let (api_key, base_url, model) = with_cfg(|c| -> Result<_, OrError> {
        Ok((
            require_api_key(c)?,
            c.base_url.clone(),
            pick_model(model, &c.settings.translate_model),
        ))
    })??;
    let input = text.trim();
    if input.is_empty() {
        return Err(OrError::Msg("Không có text để dịch".into()));
    }
    if source_lang == target_lang {
        return Ok(input.to_string());
    }

    let system = format!(
        "You are a simultaneous interpreter for a live conversation. Translate from {} to {}. \
         Output ONLY the translation — no quotes, no preamble. \
         Keep meaning, names, numbers, and technical terms. \
         Match prior turns for how people, products, teams, and recurring terms are named — \
         do not invent a new rendering if the prior context already established one.{}",
        lang_name(source_lang),
        lang_name(target_lang),
        word_list_hint(word_list)
    );

    // Vài câu trước (user/assistant) để giữ cách gọi đồng bộ xuyên suốt buổi nghe.
    let mut messages = vec![json!({"role": "system", "content": system})];
    let ctx_start = context.len().saturating_sub(8);
    for turn in &context[ctx_start..] {
        let src = clip_ctx(&turn.source, 360);
        let dst = clip_ctx(&turn.translated, 360);
        if src.is_empty() || dst.is_empty() || dst.starts_with("(lỗi") {
            continue;
        }
        messages.push(json!({"role": "user", "content": src}));
        messages.push(json!({"role": "assistant", "content": dst}));
    }
    messages.push(json!({"role": "user", "content": input}));

    let payload = json!({
        "model": model,
        "temperature": 0.2,
        "messages": messages
    });

    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = OrError::Msg("Translate thất bại".into());

    for attempt in 0..MAX_ATTEMPTS {
        let res = match client()?
            .post(format!("{base_url}/chat/completions"))
            .headers(auth_headers(&api_key))
            .json(&payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = OrError::Http(e);
                if attempt + 1 < MAX_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_millis(retry_after_ms_fallback(
                        attempt,
                    )))
                    .await;
                    continue;
                }
                break;
            }
        };

        let status = res.status();
        let wait_ms = retry_after_ms(&res, attempt);
        let body = res.text().await.unwrap_or_default();

        if let Some(msg) = openrouter_error_message(&body) {
            last_err = OrError::Msg(format!("Translate: {msg}"));
            if translate_retryable(status, &body, false) && attempt + 1 < MAX_ATTEMPTS {
                tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                continue;
            }
            return Err(last_err);
        }

        if !status.is_success() {
            last_err = OrError::Msg(format!("Translate {status}: {}", truncate(&body, 400)));
            if translate_retryable(status, &body, false) && attempt + 1 < MAX_ATTEMPTS {
                tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                continue;
            }
            return Err(last_err);
        }

        let v: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => {
                last_err = OrError::Json(e);
                if attempt + 1 < MAX_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_millis(retry_after_ms_fallback(
                        attempt,
                    )))
                    .await;
                    continue;
                }
                break;
            }
        };

        let out = v["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .trim()
            .trim_matches('"')
            .to_string();
        if out.is_empty() {
            last_err = OrError::Msg("Translate trả rỗng".into());
            if attempt + 1 < MAX_ATTEMPTS {
                tokio::time::sleep(std::time::Duration::from_millis(retry_after_ms_fallback(
                    attempt,
                )))
                .await;
                continue;
            }
            break;
        }
        return Ok(out);
    }

    Err(last_err)
}

fn retry_after_ms_fallback(attempt: u32) -> u64 {
    (500u64.saturating_mul(1u64 << attempt.min(3)) + 200 * u64::from(attempt)).clamp(400, 8_000)
}

fn model_wants_pcm(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("gemini") || m.contains("heygen")
}

/// Raw PCM 16-bit LE → WAV để trình duyệt phát được.
fn pcm_to_wav(pcm: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate * u32::from(channels) * u32::from(bits_per_sample) / 8;
    let block_align = channels * bits_per_sample / 8;
    let data_len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits_per_sample.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

fn parse_pcm_rate(ctype: &str) -> u32 {
    // audio/pcm;rate=24000;channels=1
    for part in ctype.split(';') {
        let p = part.trim();
        if let Some(v) = p.strip_prefix("rate=")
            && let Ok(n) = v.trim().parse::<u32>()
            && n > 0
        {
            return n;
        }
    }
    24_000
}

/// Trả (audio bytes, mime). Gemini/HeyGen → pcm bọc WAV; còn lại mp3.
pub async fn synthesize(
    text: &str,
    voice: Option<&str>,
    model: Option<&str>,
) -> Result<(Vec<u8>, String), OrError> {
    let (api_key, base_url, model, default_voice) = with_cfg(|c| -> Result<_, OrError> {
        Ok((
            require_api_key(c)?,
            c.base_url.clone(),
            pick_model(model, &c.settings.tts_model),
            c.settings.tts_voice.clone(),
        ))
    })??;
    let input = text.trim();
    if input.is_empty() {
        return Err(OrError::Msg("Không có text TTS".into()));
    }
    let voice = voice.unwrap_or(&default_voice);
    let use_pcm = model_wants_pcm(&model);
    let response_format = if use_pcm { "pcm" } else { "mp3" };
    let mut payload = json!({
        "model": model,
        "input": input.chars().take(1200).collect::<String>(),
        "voice": voice,
        "response_format": response_format
    });
    // Gemini TTS: instructions giúp tự nhiên hơn; không nhét vào input (sẽ bị đọc thành tiếng)
    if use_pcm {
        payload.as_object_mut().unwrap().insert(
            "instructions".into(),
            json!("Speak clearly in a natural, warm conversational tone."),
        );
    }

    let res = client()?
        .post(format!("{base_url}/audio/speech"))
        .headers(auth_headers(&api_key))
        .header(reqwest::header::ACCEPT, "audio/*, application/json")
        .json(&payload)
        .send()
        .await?;
    let status = res.status();
    let ctype = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = res.bytes().await?.to_vec();
    if !status.is_success() {
        let msg = String::from_utf8_lossy(&bytes);
        return Err(OrError::Msg(format!(
            "TTS {status}: {}",
            truncate(&msg, 400)
        )));
    }
    if ctype.contains("json") {
        let msg = String::from_utf8_lossy(&bytes);
        return Err(OrError::Msg(format!("TTS JSON: {}", truncate(&msg, 400))));
    }
    if bytes.len() < 200 {
        return Err(OrError::Msg("TTS audio quá ngắn".into()));
    }
    if use_pcm || ctype.contains("pcm") {
        let rate = parse_pcm_rate(&ctype);
        let wav = pcm_to_wav(&bytes, rate, 1);
        return Ok((wav, "audio/wav".into()));
    }
    Ok((bytes, "audio/mpeg".into()))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtteranceResult {
    pub role: String,
    pub source_text: String,
    pub translated_text: String,
    pub source_lang: String,
    pub target_lang: String,
    pub audio_base64: Option<String>,
    pub audio_mime: Option<String>,
    pub stt_ms: u64,
    pub translate_ms: u64,
    pub tts_ms: Option<u64>,
    pub tts_error: Option<String>,
}

pub async fn process_utterance(
    audio_base64: &str,
    mime_type: &str,
    role: &str,
    source_lang: &str,
    target_lang: &str,
    word_list: &[String],
    speak: bool,
) -> Result<UtteranceResult, OrError> {
    let t0 = std::time::Instant::now();
    let source_text = transcribe(audio_base64, mime_type, Some(source_lang), None).await?;
    let stt_ms = t0.elapsed().as_millis() as u64;

    let t1 = std::time::Instant::now();
    let translated_text =
        translate_text(&source_text, source_lang, target_lang, word_list, &[], None).await?;
    let translate_ms = t1.elapsed().as_millis() as u64;

    let mut audio_base64_out = None;
    let mut audio_mime = None;
    let mut tts_ms = None;
    let mut tts_error = None;
    if speak {
        let t2 = std::time::Instant::now();
        match synthesize(&translated_text, None, None).await {
            Ok((bytes, mime)) => {
                tts_ms = Some(t2.elapsed().as_millis() as u64);
                audio_base64_out = Some(B64.encode(bytes));
                audio_mime = Some(mime);
            }
            Err(e) => tts_error = Some(e.to_string()),
        }
    }

    Ok(UtteranceResult {
        role: role.to_string(),
        source_text,
        translated_text,
        source_lang: source_lang.to_string(),
        target_lang: target_lang.to_string(),
        audio_base64: audio_base64_out,
        audio_mime,
        stt_ms,
        translate_ms,
        tts_ms,
        tts_error,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MeetingNotes {
    pub summary: String,
    pub topics: Vec<String>,
    pub decisions: Vec<String>,
    pub todos: Vec<String>,
    pub glossary: Vec<GlossaryItem>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryItem {
    pub term: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLineIn {
    pub role: String,
    pub source: String,
    pub translated: String,
}

pub async fn generate_notes(
    lines: &[TranscriptLineIn],
    my_lang: &str,
    their_lang: &str,
    word_list: &[String],
) -> Result<MeetingNotes, OrError> {
    let (api_key, base_url, model) = with_cfg(|c| -> Result<_, OrError> {
        Ok((
            require_api_key(c)?,
            c.base_url.clone(),
            c.settings.notes_model.clone(),
        ))
    })??;
    if lines.is_empty() {
        return Err(OrError::Msg("Chưa có transcript để viết biên bản".into()));
    }

    let mut transcript = String::new();
    for (i, line) in lines.iter().take(200).enumerate() {
        let who = if line.role == "me" { "Me" } else { "Them" };
        transcript.push_str(&format!(
            "{}. [{}] {}\n   → {}\n",
            i + 1,
            who,
            line.source,
            line.translated
        ));
    }

    let system = format!(
        "You write structured live meeting notes. Reply in {}. \
         Return ONLY valid JSON with keys: summary (string), topics (string[]), \
         decisions (string[]), todos (string[]), glossary (array of {{term, note}}). \
         Be concise and actionable.{}",
        lang_name(my_lang),
        word_list_hint(word_list)
    );
    let user = format!(
        "Meeting languages: them={} / me={}.\nTranscript:\n{}",
        lang_name(their_lang),
        lang_name(my_lang),
        transcript
    );

    let payload = json!({
        "model": model,
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ]
    });

    let res = client()?
        .post(format!("{base_url}/chat/completions"))
        .headers(auth_headers(&api_key))
        .json(&payload)
        .send()
        .await?;
    let status = res.status();
    let body = res.text().await?;
    if !status.is_success() {
        return Err(OrError::Msg(format!(
            "Notes {status}: {}",
            truncate(&body, 500)
        )));
    }
    let v: Value = serde_json::from_str(&body)?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("{}")
        .trim()
        .to_string();
    // Strip markdown fences if any
    let json_str = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let mut notes: MeetingNotes = serde_json::from_str(json_str).unwrap_or_default();
    notes.updated_at = Some(chrono::Utc::now().to_rfc3339());
    Ok(notes)
}
