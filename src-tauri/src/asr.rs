//! Speech-to-Text (Whisper) integration via Groq Cloud.
//!
//! ThukiWin records microphone audio in the frontend (`MediaRecorder`),
//! sends the raw bytes to the Rust backend, and the backend forwards them
//! to Groq's OpenAI-compatible `/openai/v1/audio/transcriptions` endpoint
//! using `whisper-large-v3`. The API key is stored ONLY in the SQLite
//! `app_config` table under the key `api_key_groq` — never in TOML, never
//! sent over IPC after the initial save.
//!
//! Why Groq and not local Whisper:
//!   - GTX 1660 has only 4 GB VRAM, not enough for whisper-large-v3
//!   - Groq's free tier is generous and the latency is sub-second
//!   - Same architecture as the Hermes/NIM mainline: cloud does the work,
//!     ThukiWin just orchestrates and presents

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::State;

const GROQ_ENDPOINT: &str =
    "https://api.groq.com/openai/v1/audio/transcriptions";

/// Default Whisper model on Groq Cloud. Supports Russian, English, and 50+
/// other languages with automatic detection.
const DEFAULT_WHISPER_MODEL: &str = "whisper-large-v3";

/// Response shape from the Groq transcription endpoint.
#[derive(Debug, Deserialize)]
struct GroqTranscriptionResponse {
    text: String,
}

/// Result returned to the frontend after a successful transcription.
#[derive(Debug, Serialize)]
pub struct TranscriptionResult {
    /// The transcribed text. Trimmed of leading/trailing whitespace.
    pub text: String,
    /// The model that produced this transcription (echoed for diagnostics).
    pub model: String,
}

/// Transcribes a single recording sent from the frontend.
///
/// `audio_base64` is the raw recording bytes (typically `audio/webm;codecs=opus`
/// from `MediaRecorder`) base64-encoded for safe IPC transport. `mime_type`
/// preserves the container so Groq can pick the right decoder. `language`
/// is an optional ISO-639-1 hint (e.g. `"ru"`); leave empty to autodetect.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub async fn transcribe_audio(
    audio_base64: String,
    mime_type: Option<String>,
    language: Option<String>,
    client: State<'_, reqwest::Client>,
    db: State<'_, crate::history::Database>,
) -> Result<TranscriptionResult, String> {
    // Look up the Groq API key from SQLite (same pattern as Hermes/OpenAI).
    let api_key: String = {
        let conn = db
            .0
            .lock()
            .map_err(|e: std::sync::PoisonError<_>| e.to_string())?;
        crate::database::get_config(&conn, "api_key_groq")
            .map_err(|e| e.to_string())?
            .unwrap_or_default()
    };
    if api_key.is_empty() {
        return Err(
            "Groq API key is missing. Open Settings → Sound and paste your \
             Groq key under 'Voice input (Whisper)'."
                .to_string(),
        );
    }

    let bytes = BASE64_STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|e| format!("Invalid base64 audio payload: {e}"))?;

    crate::diagnostics::log(
        "asr",
        &format!(
            "received recording: bytes={}, mime={:?}, lang={:?}",
            bytes.len(),
            mime_type,
            language
        ),
    );

    if bytes.is_empty() {
        crate::diagnostics::log("asr", "empty recording — refusing to call Groq");
        return Err("Empty audio recording".to_string());
    }
    // Reject obviously-too-short clips up front. MediaRecorder always emits a
    // ~few-hundred-byte container even when nothing was captured; Whisper then
    // hallucinates a stock phrase (Russian: «продолжение следует», English:
    // «thanks for watching», etc.) from its training data instead of returning
    // empty text. 2 KiB is a safe floor that still lets through legitimate
    // one-word commands (~0.5 s of opus at 32 kbps ≈ 2.5 KiB).
    if bytes.len() < 2048 {
        crate::diagnostics::log(
            "asr",
            &format!(
                "recording too short ({} bytes) — likely silence; skipping Groq call",
                bytes.len()
            ),
        );
        return Ok(TranscriptionResult {
            text: String::new(),
            model: DEFAULT_WHISPER_MODEL.to_string(),
        });
    }
    // Groq accepts up to 25 MB. Reject anything obviously oversized so we
    // don't burn the upload only to be rejected server-side.
    if bytes.len() > 25 * 1024 * 1024 {
        return Err(format!(
            "Recording is {:.1} MB; Groq limit is 25 MB. Record a shorter clip.",
            bytes.len() as f64 / (1024.0 * 1024.0)
        ));
    }

    // Pick a sensible filename + content-type. The extension matters for
    // the Whisper API's internal demuxer; we map common MediaRecorder MIMEs
    // to known-good extensions.
    let mime = mime_type
        .as_deref()
        .unwrap_or("audio/webm")
        .to_lowercase();
    let (filename, content_type) = if mime.contains("ogg") {
        ("recording.ogg", "audio/ogg")
    } else if mime.contains("wav") {
        ("recording.wav", "audio/wav")
    } else if mime.contains("mp4") || mime.contains("m4a") {
        ("recording.m4a", "audio/m4a")
    } else if mime.contains("mpeg") || mime.contains("mp3") {
        ("recording.mp3", "audio/mpeg")
    } else {
        // Default: treat as webm/opus (Chrome/Edge MediaRecorder default).
        ("recording.webm", "audio/webm")
    };

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.to_string())
        .mime_str(content_type)
        .map_err(|e| format!("Failed to set MIME type: {e}"))?;

    let mut form = reqwest::multipart::Form::new()
        .text("model", DEFAULT_WHISPER_MODEL)
        .text("response_format", "json")
        // Use temperature=0 for the most stable transcription.
        .text("temperature", "0")
        .part("file", part);

    if let Some(lang) = language.as_deref().filter(|s| !s.trim().is_empty()) {
        form = form.text("language", lang.trim().to_string());
    }

    let response = client
        .post(GROQ_ENDPOINT)
        .header("Authorization", format!("Bearer {api_key}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            crate::diagnostics::log("asr", &format!("Groq request failed: {e}"));
            format!("Groq request failed: {e}")
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(400).collect();
        crate::diagnostics::log(
            "asr",
            &format!("Groq HTTP {} — {}", status.as_u16(), snippet),
        );
        return Err(format!(
            "Groq returned HTTP {}: {}",
            status.as_u16(),
            snippet
        ));
    }

    let parsed: GroqTranscriptionResponse = response
        .json()
        .await
        .map_err(|e| {
            crate::diagnostics::log("asr", &format!("Failed to parse Groq response: {e}"));
            format!("Failed to parse Groq response: {e}")
        })?;

    let text = parsed.text.trim().to_string();
    crate::diagnostics::log(
        "asr",
        &format!(
            "Groq returned transcript: len={}, preview={:?}",
            text.chars().count(),
            text.chars().take(80).collect::<String>()
        ),
    );

    // Whisper hallucination guard: when fed near-silence (typical with cheap
    // mics or accidental brief clicks on the mic button) the model emits
    // canonical training-set phrases instead of empty text. Suppress the most
    // common ones so the UI doesn't append garbage to the user's query.
    let lower = text.to_lowercase();
    const HALLUCINATIONS: &[&str] = &[
        "продолжение следует",
        "субтитры подогнал",
        "субтитры сделал",
        "редактор субтитров",
        "субтитры от",
        "корректор",
        "thanks for watching",
        "thank you for watching",
        "subtitles by",
        "♪",
    ];
    let is_hallucination = HALLUCINATIONS.iter().any(|p| lower.contains(p))
        // Or anything suspiciously short (< 3 chars) that whisper sometimes
        // emits for silence.
        || (text.chars().count() < 3 && !text.is_empty());
    if is_hallucination {
        crate::diagnostics::log(
            "asr",
            &format!("suppressed likely hallucination: {:?}", text),
        );
        return Ok(TranscriptionResult {
            text: String::new(),
            model: DEFAULT_WHISPER_MODEL.to_string(),
        });
    }

    Ok(TranscriptionResult {
        text,
        model: DEFAULT_WHISPER_MODEL.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcription_result_serializes_text_and_model() {
        let r = TranscriptionResult {
            text: "привет".to_string(),
            model: "whisper-large-v3".to_string(),
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"text\":\"привет\""));
        assert!(json.contains("whisper-large-v3"));
    }
}
