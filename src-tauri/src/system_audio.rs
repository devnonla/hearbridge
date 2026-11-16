//! Bắt system audio trên macOS bằng ScreenCaptureKit (âm thanh Zoom/Meet đang phát).

use crate::openrouter::OrError;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const SAMPLE_RATE: u32 = 48_000;
const RING_SECS: usize = 45;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioChunk {
    pub audio_base64: String,
    pub mime_type: String,
    pub duration_ms: u64,
    pub rms: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioStatus {
    pub running: bool,
    pub available: bool,
    pub sample_rate: u32,
    pub buffered_ms: u64,
    pub rms: f32,
    pub platform: String,
    pub bundle_id: Option<String>,
    pub app_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioApp {
    pub bundle_id: String,
    pub name: String,
    pub process_id: i32,
    pub preferred: bool,
    /// PNG icon (base64, không data-URL)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_base64: Option<String>,
    /// Preview cửa sổ lớn nhất (PNG base64)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_base64: Option<String>,
}

struct Shared {
    samples: Mutex<VecDeque<f32>>,
    running: AtomicBool,
    /// Tạm không ghi buffer (đang interpreting / TTS)
    gated: AtomicBool,
    /// Tăng khi duck/gate để hủy pull_utterance đang chạy
    epoch: std::sync::atomic::AtomicU64,
}

struct CaptureState {
    shared: Arc<Shared>,
    bundle_id: Option<String>,
    app_name: Option<String>,
    #[cfg(target_os = "macos")]
    stream: screencapturekit::stream::SCStream,
}

static CAPTURE: OnceLock<Mutex<Option<CaptureState>>> = OnceLock::new();

fn capture_slot() -> &'static Mutex<Option<CaptureState>> {
    CAPTURE.get_or_init(|| Mutex::new(None))
}

fn downmix_interleaved(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 || samples.is_empty() {
        return samples.to_vec();
    }
    samples
        .chunks_exact(channels)
        .map(|c| c.iter().sum::<f32>() / channels as f32)
        .collect()
}

fn push_samples(shared: &Shared, mono: &[f32]) {
    if shared.gated.load(Ordering::SeqCst) {
        return;
    }
    let max = SAMPLE_RATE as usize * RING_SECS;
    let mut q = shared.samples.lock().unwrap();
    for &s in mono {
        if q.len() >= max {
            q.pop_front();
        }
        q.push_back(s);
    }
}

fn with_shared<R>(f: impl FnOnce(&Shared) -> R) -> Result<Option<R>, OrError> {
    let slot = capture_slot()
        .lock()
        .map_err(|_| OrError::Msg("system audio lock".into()))?;
    Ok(slot.as_ref().map(|s| f(&s.shared)))
}

pub fn clear_buffer() -> Result<(), OrError> {
    let _ = with_shared(|shared| {
        shared.samples.lock().unwrap().clear();
        shared.epoch.fetch_add(1, Ordering::SeqCst);
    })?;
    Ok(())
}

/// Gate=true: ngừng nhận system audio (khi bạn đang nói / TTS đang phát).
pub fn set_gated(gated: bool) -> Result<(), OrError> {
    let _ = with_shared(|shared| {
        shared.gated.store(gated, Ordering::SeqCst);
        shared.samples.lock().unwrap().clear();
        shared.epoch.fetch_add(1, Ordering::SeqCst);
    })?;
    Ok(())
}

/// Gate một lúc rồi mở lại — dùng sau interpreting/TTS để khỏi bắt lại giọng mình.
pub fn duck(pause_ms: u64) -> Result<(), OrError> {
    let shared = {
        let slot = capture_slot()
            .lock()
            .map_err(|_| OrError::Msg("system audio lock".into()))?;
        slot.as_ref().map(|s| Arc::clone(&s.shared))
    };
    let Some(shared) = shared else {
        return Ok(());
    };
    shared.gated.store(true, Ordering::SeqCst);
    shared.samples.lock().unwrap().clear();
    shared.epoch.fetch_add(1, Ordering::SeqCst);
    let ms = pause_ms.max(200);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        shared.samples.lock().unwrap().clear();
        shared.gated.store(false, Ordering::SeqCst);
        shared.epoch.fetch_add(1, Ordering::SeqCst);
    });
    Ok(())
}

fn rms_of(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

fn write_wav_s16(mono: &[f32], sample_rate: u32) -> Vec<u8> {
    let mut pcm = Vec::with_capacity(mono.len() * 2);
    for &s in mono {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        pcm.extend_from_slice(&v.to_le_bytes());
    }
    let data_len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(&pcm);
    out
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use core_media_rs::cm_sample_buffer::CMSampleBuffer;
    use screencapturekit::{
        shareable_content::SCShareableContent,
        stream::{
            configuration::SCStreamConfiguration, content_filter::SCContentFilter,
            output_trait::SCStreamOutputTrait, output_type::SCStreamOutputType, SCStream,
        },
    };
    use std::sync::mpsc::{sync_channel, Receiver, SyncSender};

    struct AudioOutput {
        tx: SyncSender<CMSampleBuffer>,
    }

    impl SCStreamOutputTrait for AudioOutput {
        fn did_output_sample_buffer(
            &self,
            sample_buffer: CMSampleBuffer,
            _of_type: SCStreamOutputType,
        ) {
            let _ = self.tx.try_send(sample_buffer);
        }
    }

    fn ingest_sample(shared: &Shared, sample: CMSampleBuffer) {
        let Ok(list) = sample.get_audio_buffer_list() else {
            return;
        };
        for i in 0..list.num_buffers() {
            let Some(buffer) = list.get(i) else { continue };
            let channels = buffer.number_channels.max(1) as usize;
            let data = buffer.data();
            if data.len() < 4 {
                continue;
            }
            let floats: Vec<f32> = data
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            if floats.is_empty() {
                continue;
            }
            let mono = downmix_interleaved(&floats, channels);
            push_samples(shared, &mono);
        }
    }

    fn is_preferred_app(bundle_id: &str, name: &str) -> bool {
        let b = bundle_id.to_ascii_lowercase();
        let n = name.to_ascii_lowercase();
        [
            "zoom",
            "teams",
            "webex",
            "skype",
            "discord",
            "slack",
            "telegram",
            "chrome",
            "chromium",
            "safari",
            "firefox",
            "edge",
            "brave",
            "arc",
            "meet",
            "notion",
            "figma",
            "spotify",
            "music",
            "vlc",
            "iina",
            "browser",
        ]
        .iter()
        .any(|k| b.contains(k) || n.contains(k))
    }

    pub fn list_apps() -> Result<Vec<AudioApp>, OrError> {
        let content = SCShareableContent::get().map_err(|e| {
            OrError::Msg(format!(
                "Không liệt kê app ({e}). Cấp Screen & System Audio Recording cho HearBridge."
            ))
        })?;
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for app in content.applications() {
            let bundle_id = app.bundle_identifier();
            let name = app.application_name();
            if bundle_id.is_empty() || name.is_empty() {
                continue;
            }
            // Chỉ app user — bỏ com.apple.* và helper/agent nền
            let b_lower = bundle_id.to_ascii_lowercase();
            if b_lower.starts_with("com.apple.")
                || bundle_id.contains("hearbridge")
                || bundle_id.contains("relais")
                || bundle_id.contains("cicada-tauri")
                || b_lower.contains("webkit")
                || b_lower.contains("helper")
                || b_lower.contains("platformsupport")
                || b_lower.contains(".alerter")
                || name.to_ascii_lowercase().contains("helper")
            {
                continue;
            }
            if !seen.insert(bundle_id.clone()) {
                continue;
            }
            let process_id = app.process_id() as i32;
            let preferred = is_preferred_app(&bundle_id, &name);
            // Icon nhanh; preview cửa sổ (kiểu Meet) — có thể trống nếu app ẩn / chưa cấp Screen Recording
            let icon_base64 = crate::apple_apps::icon_png_base64(&bundle_id);
            let preview_base64 = crate::apple_apps::window_preview_png_base64(process_id, 360);
            out.push(AudioApp {
                preferred,
                bundle_id,
                name,
                process_id,
                icon_base64,
                preview_base64,
            });
        }
        out.sort_by(|a, b| match (b.preferred, a.preferred) {
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            _ => a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()),
        });
        Ok(out)
    }

    pub fn start_capture(
        bundle_id: &str,
    ) -> Result<(SCStream, Arc<Shared>, Receiver<CMSampleBuffer>, String), OrError> {
        let (tx, rx) = sync_channel::<CMSampleBuffer>(64);

        let config = SCStreamConfiguration::new()
            .set_captures_audio(true)
            .map_err(|e| OrError::Msg(format!("captures_audio: {e}")))?
            .set_excludes_current_process_audio(true)
            .map_err(|e| OrError::Msg(format!("exclude process audio: {e}")))?
            .set_channel_count(2)
            .map_err(|e| OrError::Msg(format!("channel_count: {e}")))?
            .set_width(2)
            .map_err(|e| OrError::Msg(format!("width: {e}")))?
            .set_height(2)
            .map_err(|e| OrError::Msg(format!("height: {e}")))?;

        let content = SCShareableContent::get().map_err(|e| {
            OrError::Msg(format!(
                "Không lấy được shareable content ({e}). Cấp Screen & System Audio Recording cho HearBridge."
            ))
        })?;
        let mut displays = content.displays();
        if displays.is_empty() {
            return Err(OrError::Msg("Không tìm thấy màn hình".into()));
        }
        let display = displays.remove(0);

        let apps: Vec<_> = content.applications();
        let target = apps
            .iter()
            .find(|a| a.bundle_identifier() == bundle_id)
            .ok_or_else(|| {
                OrError::Msg(format!(
                    "Không thấy app `{bundle_id}`. Mở Zoom/Meet rồi bấm tải lại danh sách."
                ))
            })?;
        let app_name = target.application_name();

        // Chỉ bắt audio của app được chọn — tránh lẫn TTS/loa của mình
        let filter = SCContentFilter::new().with_display_including_application_excepting_windows(
            &display,
            &[target],
            &[],
        );

        let mut stream = SCStream::new(&filter, &config);
        stream.add_output_handler(AudioOutput { tx }, SCStreamOutputType::Audio);
        stream.start_capture().map_err(|e| {
            OrError::Msg(format!(
                "Không bắt được audio của {app_name} ({e}). System Settings › Privacy & Security › Screen & System Audio Recording → bật HearBridge."
            ))
        })?;

        let shared = Arc::new(Shared {
            samples: Mutex::new(VecDeque::with_capacity(SAMPLE_RATE as usize * 8)),
            running: AtomicBool::new(true),
            gated: AtomicBool::new(false),
            epoch: std::sync::atomic::AtomicU64::new(1),
        });
        Ok((stream, shared, rx, app_name))
    }

    pub fn spawn_ingest(shared: Arc<Shared>, rx: Receiver<CMSampleBuffer>) {
        std::thread::Builder::new()
            .name("sck-audio-ingest".into())
            .spawn(move || {
                while shared.running.load(Ordering::SeqCst) {
                    match rx.recv_timeout(Duration::from_millis(200)) {
                        Ok(sample) => ingest_sample(&shared, sample),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .ok();
    }
}

#[cfg(target_os = "macos")]
fn start_macos(bundle_id: &str) -> Result<(), OrError> {
    // Đổi app / restart: dừng stream cũ trước
    {
        let mut slot = capture_slot()
            .lock()
            .map_err(|_| OrError::Msg("system audio lock".into()))?;
        if let Some(state) = slot.take() {
            state.shared.running.store(false, Ordering::SeqCst);
            let _ = state.stream.stop_capture();
        }
    }

    let (stream, shared, rx, app_name) = mac::start_capture(bundle_id)?;
    mac::spawn_ingest(Arc::clone(&shared), rx);
    let mut slot = capture_slot()
        .lock()
        .map_err(|_| OrError::Msg("system audio lock".into()))?;
    *slot = Some(CaptureState {
        shared,
        bundle_id: Some(bundle_id.to_string()),
        app_name: Some(app_name),
        stream,
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn start_macos(_bundle_id: &str) -> Result<(), OrError> {
    Err(OrError::Msg(
        "System audio chỉ hỗ trợ macOS (ScreenCaptureKit)".into(),
    ))
}

pub fn list_apps() -> Result<Vec<AudioApp>, OrError> {
    #[cfg(target_os = "macos")]
    {
        return mac::list_apps();
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}

pub fn start(bundle_id: Option<String>) -> Result<SystemAudioStatus, OrError> {
    let bundle_id = bundle_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            OrError::Msg("Chọn app để Listen (Zoom/Meet/Chrome…). Không bắt cả hệ thống nữa.".into())
        })?;
    start_macos(&bundle_id)?;
    // Cho stream ổn định trước khi pull — ngắn để UI không đơ
    std::thread::sleep(Duration::from_millis(120));
    status()
}

pub fn stop() -> Result<SystemAudioStatus, OrError> {
    let mut slot = capture_slot()
        .lock()
        .map_err(|_| OrError::Msg("system audio lock".into()))?;
    if let Some(state) = slot.take() {
        state.shared.running.store(false, Ordering::SeqCst);
        #[cfg(target_os = "macos")]
        {
            let _ = state.stream.stop_capture();
        }
    }
    status()
}

pub fn status() -> Result<SystemAudioStatus, OrError> {
    let slot = capture_slot()
        .lock()
        .map_err(|_| OrError::Msg("system audio lock".into()))?;
    let (running, buffered_ms, rms, bundle_id, app_name) = if let Some(state) = slot.as_ref() {
        let q = state.shared.samples.lock().unwrap();
        let n = q.len();
        let recent: Vec<f32> = q.iter().rev().take(SAMPLE_RATE as usize / 5).copied().collect();
        (
            state.shared.running.load(Ordering::SeqCst),
            (n as u64 * 1000) / SAMPLE_RATE as u64,
            rms_of(&recent),
            state.bundle_id.clone(),
            state.app_name.clone(),
        )
    } else {
        (false, 0, 0.0, None, None)
    };

    Ok(SystemAudioStatus {
        running,
        available: cfg!(target_os = "macos"),
        sample_rate: SAMPLE_RATE,
        buffered_ms,
        rms,
        platform: std::env::consts::OS.to_string(),
        bundle_id,
        app_name,
    })
}

pub async fn pull_utterance(
    max_wait_ms: u64,
    max_utterance_ms: u64,
) -> Result<Option<SystemAudioChunk>, OrError> {
    {
        let slot = capture_slot()
            .lock()
            .map_err(|_| OrError::Msg("system audio lock".into()))?;
        if slot.is_none() {
            return Err(OrError::Msg(
                "Chưa bật Listen / chưa chọn app. Chọn Zoom/Meet rồi bật Listen.".into(),
            ));
        }
    }

    let epoch_at_start = with_shared(|s| s.epoch.load(Ordering::SeqCst))?.unwrap_or(0);

    let speech_thresh = 0.018f32;
    let silence_thresh = 0.010f32;
    let min_speech_ms = 350u64;
    let end_silence_ms = 650u64;
    let frame_ms = 40u64;
    let frame_n = (SAMPLE_RATE as u64 * frame_ms / 1000) as usize;

    let deadline = Instant::now() + Duration::from_millis(max_wait_ms.max(500));
    let mut collecting = false;
    let mut speech_ms = 0u64;
    let mut silence_ms = 0u64;
    let mut captured: Vec<f32> = Vec::new();

    while Instant::now() < deadline || collecting {
        // Bị duck/gate giữa chừng → hủy câu đang gom
        let (gated, epoch_now) = with_shared(|s| {
            (
                s.gated.load(Ordering::SeqCst),
                s.epoch.load(Ordering::SeqCst),
            )
        })?
        .unwrap_or((true, 0));
        if gated || epoch_now != epoch_at_start {
            return Ok(None);
        }

        let frame = {
            let slot = capture_slot()
                .lock()
                .map_err(|_| OrError::Msg("system audio lock".into()))?;
            let Some(state) = slot.as_ref() else {
                return Err(OrError::Msg("System audio chưa chạy".into()));
            };
            if state.shared.gated.load(Ordering::SeqCst) {
                None
            } else {
                let mut q = state.shared.samples.lock().unwrap();
                if !collecting && q.len() > frame_n * 3 {
                    let drop_n = q.len().saturating_sub(frame_n * 2);
                    for _ in 0..drop_n {
                        q.pop_front();
                    }
                }
                if q.len() < frame_n {
                    None
                } else {
                    let mut frame = Vec::with_capacity(frame_n);
                    for _ in 0..frame_n {
                        if let Some(s) = q.pop_front() {
                            frame.push(s);
                        }
                    }
                    Some(frame)
                }
            }
        };

        if let Some(frame) = frame {
            let r = rms_of(&frame);
            if !collecting {
                if r >= speech_thresh {
                    collecting = true;
                    speech_ms = frame_ms;
                    silence_ms = 0;
                    captured.extend_from_slice(&frame);
                }
            } else {
                captured.extend_from_slice(&frame);
                if r >= silence_thresh {
                    speech_ms += frame_ms;
                    silence_ms = 0;
                } else {
                    silence_ms += frame_ms;
                }
                let dur_ms = (captured.len() as u64 * 1000) / SAMPLE_RATE as u64;
                if (speech_ms >= min_speech_ms && silence_ms >= end_silence_ms)
                    || dur_ms >= max_utterance_ms.max(1200)
                {
                    break;
                }
            }
        } else {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        if collecting {
            let dur_ms = (captured.len() as u64 * 1000) / SAMPLE_RATE as u64;
            if dur_ms >= max_utterance_ms.max(1200) {
                break;
            }
        }
    }

    // Duck xảy ra lúc đang cắt câu → bỏ
    let (gated, epoch_now) = with_shared(|s| {
        (
            s.gated.load(Ordering::SeqCst),
            s.epoch.load(Ordering::SeqCst),
        )
    })?
    .unwrap_or((true, 0));
    if gated || epoch_now != epoch_at_start {
        return Ok(None);
    }

    if !collecting || speech_ms < min_speech_ms || captured.len() < SAMPLE_RATE as usize / 5 {
        return Ok(None);
    }

    let trim = (SAMPLE_RATE as usize * end_silence_ms as usize / 1000) / 2;
    if captured.len() > trim + SAMPLE_RATE as usize / 4 {
        captured.truncate(captured.len() - trim);
    }

    let rms = rms_of(&captured);
    let duration_ms = (captured.len() as u64 * 1000) / SAMPLE_RATE as u64;
    let wav = write_wav_s16(&captured, SAMPLE_RATE);
    Ok(Some(SystemAudioChunk {
        audio_base64: B64.encode(wav),
        mime_type: "audio/wav".into(),
        duration_ms,
        rms,
    }))
}
