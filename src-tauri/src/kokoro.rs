//! Kokoro TTS on-device (sherpa-onnx, multi-lang v1.0, 53 voices).
//!
//! The model (~350 MB) is downloaded on demand into the app data dir; synthesis returns
//! a WAV so the voice can be routed to any output device (e.g. a virtual mic).

use crate::openrouter::OrError;
use serde::Serialize;
use sherpa_rs::OnnxConfig;
use sherpa_rs::tts::{CommonTtsConfig, KokoroTts, KokoroTtsConfig};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

const MODEL_NAME: &str = "kokoro-multi-lang-v1_0";
const MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2";
const MODEL_BYTES: u64 = 349_886_476;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KokoroStatus {
    pub installed: bool,
    pub downloading: bool,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    downloaded: u64,
    total: u64,
}

static DOWNLOADING: Mutex<bool> = Mutex::new(false);
/// One engine per language (the `lang` option is fixed at creation).
static ENGINES: OnceLock<Mutex<HashMap<String, KokoroTts>>> = OnceLock::new();

fn models_dir() -> Result<PathBuf, OrError> {
    let base = dirs::data_dir().ok_or_else(|| OrError::Msg("Không tìm thấy data dir".into()))?;
    let dir = base.join("hearbridge").join("models");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn model_dir() -> Result<PathBuf, OrError> {
    Ok(models_dir()?.join(MODEL_NAME))
}

fn is_installed() -> bool {
    model_dir()
        .map(|d| {
            ["model.onnx", "voices.bin", "tokens.txt"]
                .iter()
                .all(|f| d.join(f).is_file())
                && d.join("espeak-ng-data").is_dir()
        })
        .unwrap_or(false)
}

pub fn status() -> KokoroStatus {
    KokoroStatus {
        installed: is_installed(),
        downloading: *DOWNLOADING.lock().unwrap(),
        size_bytes: MODEL_BYTES,
    }
}

/// Download + extract the model, emitting `kokoro-download` progress events.
pub async fn download(app: AppHandle) -> Result<KokoroStatus, OrError> {
    if is_installed() {
        return Ok(status());
    }
    {
        let mut busy = DOWNLOADING.lock().unwrap();
        if *busy {
            return Err(OrError::Msg("Đang tải model Kokoro".into()));
        }
        *busy = true;
    }
    let result = download_inner(&app).await;
    *DOWNLOADING.lock().unwrap() = false;
    result?;
    Ok(status())
}

async fn download_inner(app: &AppHandle) -> Result<(), OrError> {
    let dir = models_dir()?;
    let archive = dir.join(format!("{MODEL_NAME}.tar.bz2.part"));
    let emit = |phase: &'static str, downloaded: u64, total: u64| {
        let _ = app.emit(
            "kokoro-download",
            Progress {
                phase,
                downloaded,
                total,
            },
        );
    };

    let mut res = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 30))
        .build()?
        .get(MODEL_URL)
        .send()
        .await?
        .error_for_status()?;
    let total = res.content_length().unwrap_or(MODEL_BYTES);
    let mut file = std::fs::File::create(&archive)?;
    let mut downloaded: u64 = 0;
    let mut last_emit = 0u64;
    emit("downloading", 0, total);
    while let Some(chunk) = res.chunk().await? {
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= 2 * 1024 * 1024 {
            last_emit = downloaded;
            emit("downloading", downloaded, total);
        }
    }
    file.flush()?;
    drop(file);
    if downloaded < total {
        let _ = std::fs::remove_file(&archive);
        return Err(OrError::Msg("Tải model Kokoro bị ngắt giữa chừng".into()));
    }

    emit("extracting", downloaded, total);
    let out = tauri::async_runtime::spawn_blocking({
        let archive = archive.clone();
        let dir = dir.clone();
        move || {
            std::process::Command::new("/usr/bin/tar")
                .arg("-xjf")
                .arg(&archive)
                .arg("-C")
                .arg(&dir)
                .output()
        }
    })
    .await
    .map_err(|e| OrError::Msg(format!("extract join: {e}")))??;
    let _ = std::fs::remove_file(&archive);
    if !out.status.success() || !is_installed() {
        return Err(OrError::Msg(format!(
            "Giải nén model Kokoro lỗi: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    emit("done", downloaded, total);
    Ok(())
}

fn engine_config(lang: &str) -> Result<KokoroTtsConfig, OrError> {
    let d = model_dir()?;
    let p = |f: &str| d.join(f).to_string_lossy().into_owned();
    // English needs the lexicon of its accent (US vs GB); Chinese uses its own.
    let english = if lang == "en" {
        "lexicon-gb-en.txt"
    } else {
        "lexicon-us-en.txt"
    };
    let lexicon = [english, "lexicon-zh.txt"]
        .iter()
        .filter(|f| d.join(f).is_file())
        .map(|f| p(f))
        .collect::<Vec<_>>()
        .join(",");
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, 4))
        .unwrap_or(2) as i32;
    Ok(KokoroTtsConfig {
        model: p("model.onnx"),
        voices: p("voices.bin"),
        tokens: p("tokens.txt"),
        data_dir: p("espeak-ng-data"),
        dict_dir: if d.join("dict").is_dir() {
            p("dict")
        } else {
            String::new()
        },
        lexicon,
        length_scale: 1.0,
        onnx_config: OnnxConfig {
            provider: "cpu".into(),
            debug: false,
            num_threads: threads,
        },
        common_config: CommonTtsConfig {
            max_num_sentences: 1,
            silence_scale: 0.2,
            ..Default::default()
        },
        lang: lang.to_string(),
    })
}

/// espeak-ng language codes sherpa-onnx accepts for Kokoro. Anything else makes the native
/// library throw a C++ exception, which aborts the whole app (Rust can't catch it), so every
/// input is mapped onto this list. Verified per language in `tests::render_one`.
fn safe_lang(lang: &str) -> &'static str {
    match lang.trim().to_ascii_lowercase().as_str() {
        "en-gb" | "en" => "en",
        "es" | "es-es" => "es",
        "fr" | "fr-fr" => "fr",
        "hi" | "hi-in" => "hi",
        "it" | "it-it" => "it",
        "ja" | "ja-jp" => "ja",
        "pt" | "pt-br" => "pt-br",
        "zh" | "zh-cn" | "cmn" => "cmn",
        _ => "en-us",
    }
}

/// Synthesize `text` with speaker `sid` → 16-bit mono WAV bytes. Blocks (CPU-heavy).
pub fn render(text: &str, sid: i32, lang: &str, speed: f32) -> Result<Vec<u8>, OrError> {
    let lang = safe_lang(lang);
    // Kokoro v1.0 has 54 speakers (0..=53); an out-of-range id would also abort natively.
    if !(0..=53).contains(&sid) {
        return Err(OrError::Msg(format!("Giọng Kokoro không hợp lệ ({sid})")));
    }
    if !is_installed() {
        return Err(OrError::Msg("Chưa tải model Kokoro".into()));
    }
    let text = text.trim();
    if text.is_empty() {
        return Err(OrError::Msg("Không có text TTS".into()));
    }
    let engines = ENGINES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = engines.lock().unwrap();
    if !map.contains_key(lang) {
        map.insert(lang.to_string(), KokoroTts::new(engine_config(lang)?));
    }
    let tts = map.get_mut(lang).expect("engine just inserted");
    let audio = tts
        .create(text, sid, speed.clamp(0.5, 2.0))
        .map_err(|e| OrError::Msg(format!("Kokoro lỗi: {e}")))?;
    Ok(wav_from_f32(&audio.samples, audio.sample_rate))
}

fn wav_from_f32(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    /// Needs the downloaded model: `cargo test --lib kokoro -- --ignored`.
    /// Writes WAVs to $HB_KOKORO_OUT (default: temp dir) for listening / pitch checks.
    /// One language per process (a native abort kills the whole test binary):
    /// `HB_KOKORO_CASE="25 en-gb" cargo test --lib kokoro::tests::render_one -- --ignored`.
    #[test]
    #[ignore]
    fn render_one() {
        let case = std::env::var("HB_KOKORO_CASE").unwrap_or_else(|_| "3 en-us".into());
        let mut it = case.split_whitespace();
        let sid: i32 = it.next().unwrap().parse().unwrap();
        let lang = it.next().unwrap();
        let text =
            std::env::var("HB_KOKORO_TEXT").unwrap_or_else(|_| "Hello, this is a test.".into());
        let wav = super::render(&text, sid, lang, 1.0).expect("render");
        println!("case {case}: {} bytes", wav.len());
        assert!(wav.len() > 44 + 8_000);
    }

    #[test]
    #[ignore]
    fn render_samples() {
        let out = std::env::var("HB_KOKORO_OUT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir());
        for (sid, name, lang) in [
            (3, "af_heart", "en-us"),
            (16, "am_michael", "en-us"),
            (25, "bm_fable", "en-gb"),
        ] {
            let t0 = std::time::Instant::now();
            let wav = super::render(
                "Hello, this is how your translated voice will sound.",
                sid,
                lang,
                1.0,
            )
            .expect("render");
            println!(
                "{name}: {} bytes in {} ms",
                wav.len(),
                t0.elapsed().as_millis()
            );
            assert!(wav.len() > 44 + 24_000, "too little audio");
            std::fs::write(out.join(format!("{name}.wav")), wav).unwrap();
        }
    }
}
