use crate::openrouter::{MeetingNotes, OrError};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLine {
    pub id: String,
    pub at: DateTime<Utc>,
    pub role: String,
    pub source: String,
    pub translated: String,
    pub source_lang: String,
    pub target_lang: String,
    pub stt_ms: u64,
    pub translate_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub my_lang: String,
    pub their_lang: String,
    pub lines: Vec<TranscriptLine>,
    pub notes: MeetingNotes,
    pub word_list: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSummary {
    pub id: String,
    pub title: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub line_count: usize,
    pub has_notes: bool,
}

fn meetings_dir() -> Result<PathBuf, OrError> {
    let base = dirs::data_dir().ok_or_else(|| OrError::Msg("Không tìm thấy data dir".into()))?;
    let dir = base.join("hearbridge").join("meetings");
    // migrate legacy
    if !dir.exists() {
        for legacy_name in ["relais", "cicada-tauri"] {
            let legacy = base.join(legacy_name).join("meetings");
            if legacy.is_dir() {
                let _ = std::fs::rename(&legacy, &dir);
                break;
            }
        }
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn meeting_path(id: &str) -> Result<PathBuf, OrError> {
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(OrError::Msg("meeting id không hợp lệ".into()));
    }
    Ok(meetings_dir()?.join(format!("{id}.json")))
}

pub fn create_meeting(
    title: Option<String>,
    my_lang: String,
    their_lang: String,
    word_list: Vec<String>,
) -> Result<Meeting, OrError> {
    let now = Utc::now();
    let id = Uuid::new_v4().to_string();
    let title = title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| format!("Cuộc họp {}", now.format("%Y-%m-%d %H:%M")));
    let meeting = Meeting {
        id: id.clone(),
        title,
        started_at: now,
        ended_at: None,
        my_lang,
        their_lang,
        lines: Vec::new(),
        notes: MeetingNotes::default(),
        word_list,
    };
    save_meeting(&meeting)?;
    Ok(meeting)
}

pub fn save_meeting(meeting: &Meeting) -> Result<(), OrError> {
    let path = meeting_path(&meeting.id)?;
    let raw = serde_json::to_string_pretty(meeting)?;
    std::fs::write(path, raw)?;
    Ok(())
}

pub fn load_meeting(id: &str) -> Result<Meeting, OrError> {
    let path = meeting_path(id)?;
    if !path.is_file() {
        return Err(OrError::Msg("Không tìm thấy cuộc họp".into()));
    }
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn list_meetings() -> Result<Vec<MeetingSummary>, OrError> {
    let dir = meetings_dir()?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let meeting: Meeting = match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(MeetingSummary {
            id: meeting.id,
            title: meeting.title,
            started_at: meeting.started_at,
            ended_at: meeting.ended_at,
            line_count: meeting.lines.len(),
            has_notes: !meeting.notes.summary.trim().is_empty()
                || !meeting.notes.topics.is_empty()
                || !meeting.notes.decisions.is_empty()
                || !meeting.notes.todos.is_empty(),
        });
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

pub fn delete_meeting(id: &str) -> Result<(), OrError> {
    let path = meeting_path(id)?;
    if path.is_file() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub fn append_line(id: &str, line: TranscriptLine) -> Result<Meeting, OrError> {
    let mut meeting = load_meeting(id)?;
    meeting.lines.push(line);
    save_meeting(&meeting)?;
    Ok(meeting)
}

pub fn update_notes(id: &str, notes: MeetingNotes) -> Result<Meeting, OrError> {
    let mut meeting = load_meeting(id)?;
    meeting.notes = notes;
    save_meeting(&meeting)?;
    Ok(meeting)
}

pub fn end_meeting(id: &str) -> Result<Meeting, OrError> {
    let mut meeting = load_meeting(id)?;
    meeting.ended_at = Some(Utc::now());
    save_meeting(&meeting)?;
    Ok(meeting)
}

pub fn export_markdown(meeting: &Meeting) -> String {
    let mut md = String::new();
    md.push_str(&format!("# {}\n\n", meeting.title));
    md.push_str(&format!(
        "- Bắt đầu: {}\n- Kết thúc: {}\n- Ngôn ngữ: tôi {} / họ {}\n\n",
        meeting.started_at.to_rfc3339(),
        meeting
            .ended_at
            .map(|t| t.to_rfc3339())
            .unwrap_or_else(|| "đang diễn ra".into()),
        meeting.my_lang,
        meeting.their_lang
    ));

    if !meeting.notes.summary.trim().is_empty()
        || !meeting.notes.topics.is_empty()
        || !meeting.notes.decisions.is_empty()
        || !meeting.notes.todos.is_empty()
    {
        md.push_str("## Biên bản\n\n");
        if !meeting.notes.summary.trim().is_empty() {
            md.push_str(&format!("### Tóm tắt\n\n{}\n\n", meeting.notes.summary.trim()));
        }
        if !meeting.notes.topics.is_empty() {
            md.push_str("### Chủ đề\n\n");
            for t in &meeting.notes.topics {
                md.push_str(&format!("- {t}\n"));
            }
            md.push('\n');
        }
        if !meeting.notes.decisions.is_empty() {
            md.push_str("### Kết luận\n\n");
            for t in &meeting.notes.decisions {
                md.push_str(&format!("- {t}\n"));
            }
            md.push('\n');
        }
        if !meeting.notes.todos.is_empty() {
            md.push_str("### Việc cần làm\n\n");
            for t in &meeting.notes.todos {
                md.push_str(&format!("- [ ] {t}\n"));
            }
            md.push('\n');
        }
        if !meeting.notes.glossary.is_empty() {
            md.push_str("### Thuật ngữ\n\n");
            for g in &meeting.notes.glossary {
                md.push_str(&format!("- **{}**: {}\n", g.term, g.note));
            }
            md.push('\n');
        }
    }

    md.push_str("## Transcript song ngữ\n\n");
    for line in &meeting.lines {
        let who = if line.role == "me" { "Tôi" } else { "Họ" };
        md.push_str(&format!(
            "- **{}** ({})  \n  {}  \n  _{}_\n\n",
            who,
            line.at.format("%H:%M:%S"),
            line.source,
            line.translated
        ));
    }
    md
}

pub fn export_srt(meeting: &Meeting) -> String {
    let mut srt = String::new();
    let start = meeting.started_at;
    for (i, line) in meeting.lines.iter().enumerate() {
        let offset = (line.at - start).num_milliseconds().max(0) as u64;
        let begin = format_ts(offset);
        let end = format_ts(offset + 3500);
        srt.push_str(&format!(
            "{}\n{} --> {}\n{} {}\n{}\n\n",
            i + 1,
            begin,
            end,
            if line.role == "me" { "[Tôi]" } else { "[Họ]" },
            line.source,
            line.translated
        ));
    }
    srt
}

fn format_ts(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1000;
    let milli = ms % 1000;
    format!("{h:02}:{m:02}:{s:02},{milli:03}")
}

pub fn write_export(id: &str, format: &str) -> Result<String, OrError> {
    let meeting = load_meeting(id)?;
    let dir = meetings_dir()?.join("exports");
    std::fs::create_dir_all(&dir)?;
    let (ext, body) = match format {
        "srt" => ("srt", export_srt(&meeting)),
        _ => ("md", export_markdown(&meeting)),
    };
    let path = dir.join(format!("{id}.{ext}"));
    std::fs::write(&path, body)?;
    Ok(path.to_string_lossy().to_string())
}
