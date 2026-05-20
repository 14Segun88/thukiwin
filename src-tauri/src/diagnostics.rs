//! In-process ring-buffer log collector for the in-app Logs viewer.
//!
//! Tauri does not bridge `eprintln!` to the webview, and once a release build
//! is shipped there is no convenient console for the end user. This module
//! provides:
//!
//!   * `diagnostics::log(scope, message)` — append a structured line. Cheap;
//!     non-blocking; bounded (oldest entries are dropped at `MAX_ENTRIES`).
//!   * `diagnostics::get_logs()` — Tauri command surfaced to the frontend
//!     Logs panel so the user can copy/paste a tail to the developer.
//!   * `diagnostics::clear_logs()` — wipe the buffer.
//!
//! Every entry is also mirrored to `stderr` so devs running `cargo tauri dev`
//! still see the stream in their terminal.

use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Maximum number of retained log entries. Old entries are evicted FIFO.
const MAX_ENTRIES: usize = 500;

#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    /// Milliseconds since UNIX epoch — formatted by the frontend.
    pub ts_ms: u64,
    /// Short tag, e.g. `"asr"`, `"vision"`, `"hermes"`. Lower-case.
    pub scope: String,
    /// Free-form one-line message.
    pub message: String,
}

static BUFFER: OnceLock<Mutex<std::collections::VecDeque<LogEntry>>> = OnceLock::new();

fn buf() -> &'static Mutex<std::collections::VecDeque<LogEntry>> {
    BUFFER.get_or_init(|| Mutex::new(std::collections::VecDeque::with_capacity(MAX_ENTRIES)))
}

/// Appends a single log line. Safe to call from any thread / async task.
pub fn log(scope: &str, message: &str) {
    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let entry = LogEntry {
        ts_ms,
        scope: scope.to_string(),
        message: message.to_string(),
    };
    eprintln!("[{scope}] {message}");
    if let Ok(mut buf) = buf().lock() {
        if buf.len() >= MAX_ENTRIES {
            buf.pop_front();
        }
        buf.push_back(entry);
    }
}

/// Tauri command — returns a snapshot of the current buffer (newest last).
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn get_logs() -> Vec<LogEntry> {
    buf()
        .lock()
        .map(|b| b.iter().cloned().collect())
        .unwrap_or_default()
}

/// Tauri command — wipes the buffer.
#[cfg_attr(coverage_nightly, coverage(off))]
#[cfg_attr(not(coverage), tauri::command)]
pub fn clear_logs() {
    if let Ok(mut buf) = buf().lock() {
        buf.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_appends_and_caps_at_max() {
        clear_logs();
        for i in 0..(MAX_ENTRIES + 50) {
            log("test", &format!("entry {i}"));
        }
        let entries = get_logs();
        assert_eq!(entries.len(), MAX_ENTRIES);
        // Oldest entries are evicted; the last entry should be the most recent.
        assert!(entries.last().unwrap().message.contains(&format!("{}", MAX_ENTRIES + 49)));
    }

    #[test]
    fn clear_empties_buffer() {
        log("test", "foo");
        clear_logs();
        assert!(get_logs().is_empty());
    }
}
