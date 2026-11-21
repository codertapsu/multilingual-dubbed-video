//! The backend watchdog: what happened to the orchestrator, and whether to
//! start it again.
//!
//! On 2026-11-21 the orchestrator ended with 0xC0000409 after 18 hours, mid-dub.
//! The shell logged the exit and did nothing else: the window stayed up with no
//! backend, and the UI said "The built-in backend did not start", which was the
//! one thing that had not happened. Now an exit the user did not ask for (not a
//! quit, not an update) restarts the backend after a short wait (2 s, 10 s,
//! 60 s), up to three times in ten minutes; the restarted backend continues the
//! dubs the crash interrupted (it reads `logs/backend-crash.json`, which is
//! written here). The UI reads [`snapshot`] (the `backend_state` command and the
//! `backend-state` event) to tell "starting", "restarting after a crash" and
//! "keeps stopping" apart.
//!
//! The process handling lives in `sidecar.rs`; this module keeps the state and
//! the rules, which are pure and tested.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

/// Set when the app is quitting or an update is about to install: an exit then
/// is expected, never a crash to restart.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

pub fn set_shutting_down() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
}

pub fn shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::SeqCst)
}

/// The update that stopped the backend did not start its installer, so the app
/// keeps running and needs its backend back (update.rs `install`).
pub fn clear_shutting_down() {
    SHUTTING_DOWN.store(false, Ordering::SeqCst);
}

/// What the UI is told about the backend.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackendState {
    /// `unmanaged` (the shell does not run it: dev, or management disabled),
    /// `running`, `restarting`, `failed`.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit_meaning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit_at: Option<String>,
    /// Restarts since the app opened.
    pub restarts: u32,
    /// Why it could not be started at all (`failed` without an exit).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

struct Supervisor {
    state: BackendState,
    started: Option<Instant>,
    env: Vec<(String, String)>,
    exits: Vec<Instant>,
}

fn supervisor() -> &'static Mutex<Supervisor> {
    static SUPERVISOR: OnceLock<Mutex<Supervisor>> = OnceLock::new();
    SUPERVISOR.get_or_init(|| {
        Mutex::new(Supervisor {
            state: BackendState { state: "unmanaged".into(), ..Default::default() },
            started: None,
            env: Vec::new(),
            exits: Vec::new(),
        })
    })
}

/// The state now (the `backend_state` command).
pub fn snapshot() -> BackendState {
    supervisor().lock().map(|s| s.state.clone()).unwrap_or_default()
}

/// Keep the environment the orchestrator was started with, to start it again.
pub fn remember_env(env: &[(&str, String)]) {
    if let Ok(mut s) = supervisor().lock() {
        s.env = env.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect();
    }
}

/// The environment to start it again with.
pub fn env() -> Vec<(String, String)> {
    supervisor().lock().map(|s| s.env.clone()).unwrap_or_default()
}

/// The orchestrator process was started.
pub fn launched(wall: SystemTime) {
    if let Ok(mut s) = supervisor().lock() {
        s.started = Some(Instant::now());
        s.state.state = "running".into();
        s.state.started_at = Some(crate::logging::iso8601_utc(wall));
        s.state.failure = None;
    }
}

/// The orchestrator could not be started at all.
pub fn launch_failed(reason: &str) {
    if let Ok(mut s) = supervisor().lock() {
        s.state.state = "failed".into();
        s.state.failure = Some(reason.to_string());
    }
}

/// The wait before the n-th exit within [`WINDOW`] is answered by a restart;
/// `None`: it keeps stopping, give up (the UI says so). Pure.
pub fn restart_delay(exits_in_window: usize) -> Option<Duration> {
    match exits_in_window {
        1 => Some(Duration::from_secs(2)),
        2 => Some(Duration::from_secs(10)),
        3 => Some(Duration::from_secs(60)),
        _ => None,
    }
}

/// How far back exits count towards giving up.
pub const WINDOW: Duration = Duration::from_secs(10 * 60);

/// An exit code in hex (Windows status codes read as 0xC0000409) and in plain
/// words. Pure.
pub fn exit_meaning(code: Option<i32>) -> (Option<String>, &'static str) {
    let Some(c) = code else {
        return (None, "it was stopped by a signal");
    };
    let hex = format!("0x{:08X}", c as u32);
    let meaning = match c as u32 {
        0 => "it exited normally",
        1 => "it stopped on a fatal error (see its log)",
        134 => "it aborted (SIGABRT)",
        137 => "it was killed (SIGKILL), often by the system for lack of memory",
        0xC000_0409 => "a fast-fail abort: a fatal error inside the runtime or a native library",
        0xC000_0005 => "an access violation in native code",
        0xC000_00FD => "a stack overflow",
        0xC000_0017 | 0xC000_012D => "the system ran out of memory",
        0xC000_013A => "it was stopped with Ctrl+C",
        _ => "an unexpected exit",
    };
    (Some(hex), meaning)
}

/// What [`on_exit`] decided.
#[derive(Debug, PartialEq, Eq)]
pub enum ExitDecision {
    /// Expected (the app is quitting): nothing to do.
    Ignore,
    /// Start it again after this wait.
    Restart(Duration),
    /// It keeps stopping: leave it stopped.
    GiveUp,
}

/// The orchestrator ended: record it and decide. The crash marker for the next
/// backend is written by the caller ([`write_crash_marker`]).
pub fn on_exit(code: Option<i32>, now: Instant, wall: SystemTime) -> (ExitDecision, Option<u64>) {
    if shutting_down() {
        return (ExitDecision::Ignore, None);
    }
    let Ok(mut s) = supervisor().lock() else {
        return (ExitDecision::GiveUp, None);
    };
    let uptime = s.started.map(|t| now.saturating_duration_since(t).as_secs());
    s.exits.retain(|t| now.saturating_duration_since(*t) < WINDOW);
    s.exits.push(now);
    let (hex, meaning) = exit_meaning(code);
    s.state.last_exit_code = code;
    s.state.last_exit_hex = hex;
    s.state.last_exit_meaning = Some(meaning.to_string());
    s.state.last_exit_at = Some(crate::logging::iso8601_utc(wall));
    match restart_delay(s.exits.len()) {
        Some(delay) => {
            s.state.state = "restarting".into();
            s.state.restarts += 1;
            (ExitDecision::Restart(delay), uptime)
        }
        None => {
            s.state.state = "failed".into();
            (ExitDecision::GiveUp, uptime)
        }
    }
}

/// `logs/backend-crash.json`, which the restarted backend reads once
/// (diagnostics/health.ts `takeRecoveredCrash`) to continue the interrupted dubs.
pub fn write_crash_marker(logs_dir: &Path, code: Option<i32>, uptime_sec: Option<u64>, wall: SystemTime) {
    let (hex, meaning) = exit_meaning(code);
    let body = serde_json::json!({
        "at": crate::logging::iso8601_utc(wall),
        "code": code,
        "codeHex": hex,
        "meaning": meaning,
        "uptimeSec": uptime_sec,
    });
    let _ = std::fs::create_dir_all(logs_dir);
    let tmp = logs_dir.join("backend-crash.json.tmp");
    if std::fs::write(&tmp, format!("{body}\n")).is_ok() {
        let _ = std::fs::rename(&tmp, logs_dir.join("backend-crash.json"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_fast_fail_that_ended_the_backend() {
        let (hex, meaning) = exit_meaning(Some(-1_073_740_791));
        assert_eq!(hex.as_deref(), Some("0xC0000409"));
        assert!(meaning.contains("fast-fail"));
        assert_eq!(exit_meaning(None).0, None);
        assert_eq!(exit_meaning(Some(137)).1, "it was killed (SIGKILL), often by the system for lack of memory");
    }

    #[test]
    fn waits_longer_each_time_and_gives_up_after_three_restarts() {
        assert_eq!(restart_delay(1), Some(Duration::from_secs(2)));
        assert_eq!(restart_delay(2), Some(Duration::from_secs(10)));
        assert_eq!(restart_delay(3), Some(Duration::from_secs(60)));
        assert_eq!(restart_delay(4), None);
    }

    #[test]
    fn writes_the_marker_the_next_backend_reads() {
        let dir = std::env::temp_dir().join(format!("vd-watchdog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_crash_marker(&dir, Some(-1_073_740_791), Some(66_444), SystemTime::UNIX_EPOCH);
        let text = std::fs::read_to_string(dir.join("backend-crash.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["codeHex"], "0xC0000409");
        assert_eq!(v["uptimeSec"], 66_444);
        assert_eq!(v["at"], "1970-01-01T00:00:00Z");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
