//! In-app updates: a download the window can follow, a stall that ends in a
//! message instead of a spinner forever, and a record of every attempt.
//!
//! WHY: the 0.16.1 -> 0.17.0 update "got stuck" on a user's Windows machine
//! (2026-11-21). The ~280 MB installer came through a client with no read
//! timeout, behind a spinner with no numbers, and every step was logged with
//! `println!`, which a windowed release build has nobody to read. Each earlier
//! update had left its installer in %TEMP%; that one left none, so the download
//! never finished. Twice the user closed and reopened the app, then uninstalled
//! it and installed 0.17.0 by hand. Now the window shows how far the download
//! is, a stalled one fails after a minute with a message, the user can cancel,
//! a failure offers the installer from GitHub, and shell.log says what happened.
//!
//! Both update paths come through here, the Install button (commands.rs
//! `download_and_install_update`) and the background update at launch (lib.rs
//! `maybe_auto_update`), so the window can follow either.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

/// Nothing received for this long: the download has stalled. reqwest waits
/// forever by default, which is how the 0.17.0 update hung.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Progress events at most this often: enough for a smooth bar, cheap for IPC.
const EMIT_EVERY: Duration = Duration::from_millis(250);

/// A record older than this is not reported at launch: whatever happened, the
/// user has long since moved on.
const STALE_ATTEMPT_SECS: u64 = 14 * 24 * 3600;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Idle,
    Downloading,
    /// Downloaded and verified, not installed: a dub started meanwhile, and
    /// installing stops the backend.
    Ready,
    Installing,
    Failed,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Downloading => "downloading",
            Phase::Ready => "ready",
            Phase::Installing => "installing",
            Phase::Failed => "failed",
        }
    }
}

struct Status {
    phase: Phase,
    version: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    started: Option<Instant>,
    error: Option<String>,
    /// Started by the background update rather than the Install button.
    auto: bool,
}

static STATUS: Mutex<Status> = Mutex::new(Status {
    phase: Phase::Idle,
    version: None,
    downloaded: 0,
    total: None,
    started: None,
    error: None,
    auto: false,
});

/// The verified installer of one version, kept so that installing after a wait
/// (a dub was running) or after a failed start does not download it again.
static DOWNLOADED: Mutex<Option<(String, Vec<u8>)>> = Mutex::new(None);

/// The user pressed Cancel during the download.
static CANCEL: AtomicBool = AtomicBool::new(false);

/// The pre-install teardown ran: the backend is down until it is started again.
static TEARDOWN_RAN: AtomicBool = AtomicBool::new(false);

/// What the last attempt came to, decided once at launch (`settle_last_attempt`).
static OUTCOME: Mutex<Option<Value>> = Mutex::new(None);

fn status() -> MutexGuard<'static, Status> {
    STATUS.lock().unwrap_or_else(|p| p.into_inner())
}

fn downloaded() -> MutexGuard<'static, Option<(String, Vec<u8>)>> {
    DOWNLOADED.lock().unwrap_or_else(|p| p.into_inner())
}

/// One line in shell.log (and stdout under `tauri dev`).
pub(crate) fn log(msg: &str) {
    crate::sidecar::log_info(&format!("update: {msg}"));
}

fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_000_000.0)
}

/// The status the window renders (`update_status`, `update-status` event).
pub(crate) fn status_json() -> Value {
    let s = status();
    let rate = match (s.phase, s.started) {
        (Phase::Downloading, Some(t)) if t.elapsed() >= Duration::from_secs(1) => {
            Some((s.downloaded as f64 / t.elapsed().as_secs_f64()) as u64)
        }
        _ => None,
    };
    json!({
        "phase": s.phase.name(),
        "version": s.version,
        "downloaded": s.downloaded,
        "total": s.total,
        "bytesPerSecond": rate,
        "error": s.error,
        "auto": s.auto,
    })
}

fn emit(app: &AppHandle) {
    let _ = app.emit("update-status", status_json());
}

fn set_phase(app: &AppHandle, phase: Phase, error: Option<String>) {
    {
        let mut s = status();
        s.phase = phase;
        s.error = error;
    }
    emit(app);
}

/// The updater every path uses: timeouts that turn a stall into an error, and
/// the backend stopped right before the installer starts.
///
/// `on_before_exit` runs immediately before the plugin launches the platform
/// installer. On Windows that installer (NSIS) writes over the install
/// directory, and the backend's programs hold their `.exe`/`.dll` files open
/// while they run, which fails it with "Error opening file for writing" and can
/// leave a half-updated install. On macOS the `.app` is replaced wholesale, so
/// it is simply a clean shutdown.
pub(crate) fn updater(app: &AppHandle) -> Result<Updater, String> {
    app.updater_builder()
        .configure_client(|client| client.connect_timeout(CONNECT_TIMEOUT).read_timeout(READ_TIMEOUT))
        .on_before_exit(|| {
            log("stopping the backend; the installer starts next");
            TEARDOWN_RAN.store(true, Ordering::SeqCst);
            crate::sidecar::shutdown_all();
        })
        .build()
        .map_err(|e| e.to_string())
}

/// Claim the one update slot. `false` while an update downloads or installs.
fn begin(app: &AppHandle, version: &str, auto: bool) -> bool {
    {
        let mut s = status();
        if matches!(s.phase, Phase::Downloading | Phase::Installing) {
            return false;
        }
        *s = Status {
            phase: Phase::Downloading,
            version: Some(version.to_string()),
            downloaded: 0,
            total: None,
            started: Some(Instant::now()),
            error: None,
            auto,
        };
    }
    CANCEL.store(false, Ordering::SeqCst);
    emit(app);
    true
}

/// An error and every cause under it: the plugin's message alone ("error
/// decoding response body") hides the timeout that explains it.
fn describe(err: &dyn std::error::Error) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        source = cause.source();
    }
    out
}

pub(crate) enum FetchError {
    Cancelled,
    Failed(String),
}

/// Download and verify the installer of `update`, or reuse the one already here.
async fn fetch(app: &AppHandle, update: &Update) -> Result<(), FetchError> {
    let reuse = downloaded().as_ref().is_some_and(|(v, _)| v == &update.version);
    if reuse {
        log(&format!("{}: using the installer downloaded earlier", update.version));
        return Ok(());
    }
    log(&format!("downloading {} from {}", update.version, update.download_url));
    let mut logged_tenths = 0u64;
    let mut last_emit = Instant::now();
    let download = update.download(
        |len, total| {
            let (done, total) = {
                let mut s = status();
                s.downloaded += len as u64;
                if total.is_some() {
                    s.total = total;
                }
                (s.downloaded, s.total)
            };
            if let Some(total) = total.filter(|t| *t > 0) {
                let tenths = done * 10 / total;
                if tenths > logged_tenths {
                    logged_tenths = tenths;
                    log(&format!("downloaded {} of {}", mb(done), mb(total)));
                }
            }
            if last_emit.elapsed() >= EMIT_EVERY {
                last_emit = Instant::now();
                emit(app);
            }
        },
        || log("download complete; checking its signature"),
    );
    let cancelled = async {
        while !CANCEL.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    tokio::select! {
        result = download => match result {
            Ok(bytes) => {
                log(&format!("{} downloaded and verified ({})", update.version, mb(bytes.len() as u64)));
                *downloaded() = Some((update.version.clone(), bytes));
                Ok(())
            }
            Err(e) => Err(FetchError::Failed(describe(&e))),
        },
        _ = cancelled => Err(FetchError::Cancelled),
    }
}

/// Install the downloaded update. On Windows the plugin starts the installer and
/// ends this process, and on macOS the app relaunches: this returns only when
/// the install failed, with the reason.
fn install(app: &AppHandle, update: &Update) -> String {
    set_phase(app, Phase::Installing, None);
    write_attempt(&update.current_version, &update.version);
    log(&format!("installing {} over {}", update.version, update.current_version));
    let result = {
        let guard = downloaded();
        match guard.as_ref() {
            Some((version, bytes)) if version == &update.version => update.install(bytes).map_err(|e| describe(&e)),
            _ => Err("the downloaded installer is gone".to_string()),
        }
    };
    match result {
        Ok(()) => {
            log("installed; relaunching");
            app.restart()
        }
        Err(reason) => {
            remove_attempt();
            log(&format!("the install did not start: {reason}"));
            if TEARDOWN_RAN.swap(false, Ordering::SeqCst) {
                log("starting the backend again");
                crate::watchdog::clear_shutting_down();
                if let Err(e) = crate::sidecar::maybe_spawn_services(app) {
                    log(&format!("the backend could not start again: {e}"));
                }
            }
            set_phase(app, Phase::Failed, Some(reason.clone()));
            reason
        }
    }
}

/// The Install button: download (or reuse), then install. Returns only when it
/// did not install: a failure (`Err`), a cancel, or an update the background
/// already downloads, which the window then follows.
pub(crate) async fn install_now(app: &AppHandle) -> Result<Value, String> {
    let updater = updater(app).map_err(|e| {
        error_json(
            "UNKNOWN",
            &format!("updater is not configured: {e}"),
            Some("Ensure plugins.updater (endpoints + pubkey) is set in tauri.conf.json and the app is a release bundle."),
        )
    })?;
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            return Err(error_json(
                "UNKNOWN",
                "no update is available to install",
                Some("Check for updates again; this version may already be the latest."),
            ))
        }
        Err(e) => {
            let reason = describe(&e);
            log(&format!("the check before installing failed: {reason}"));
            return Err(error_json(
                "UNKNOWN",
                &format!("could not reach the update server: {reason}"),
                Some("Check the internet connection and try again."),
            ));
        }
    };
    if !begin(app, &update.version, false) {
        return Ok(json!({ "ok": true, "following": true }));
    }
    match fetch(app, &update).await {
        Ok(()) => {}
        Err(FetchError::Cancelled) => {
            log("download cancelled");
            set_phase(app, Phase::Idle, None);
            return Ok(json!({ "ok": false, "cancelled": true }));
        }
        Err(FetchError::Failed(reason)) => {
            log(&format!("download failed: {reason}"));
            set_phase(app, Phase::Failed, Some(reason.clone()));
            return Err(error_json(
                "UNKNOWN",
                &format!("the update could not be downloaded: {reason}"),
                Some("Check the internet connection and try again, or download the installer from GitHub."),
            ));
        }
    }
    // A dub may have started while the update downloaded.
    if let Some(reason) = crate::commands::busy_with_a_run_reason().await {
        log(&format!("downloaded; not installing now: {reason}"));
        set_phase(app, Phase::Ready, None);
        return Err(error_json(
            "RUN_IN_PROGRESS",
            &format!("VideoDubber is busy: {reason}"),
            Some("The update is downloaded. Install it when the dub has finished (or cancel the dub)."),
        ));
    }
    let reason = install(app, &update);
    Err(error_json(
        "UNKNOWN",
        &format!("the update could not be installed: {reason}"),
        Some("Try again, or download the installer from GitHub and run it."),
    ))
}

/// The background update at launch: the same steps, with nobody to answer, so
/// a dub that started meanwhile leaves the update downloaded for the button.
pub(crate) async fn install_in_background(app: &AppHandle, updater: Updater) {
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            log("already up to date");
            return;
        }
        Err(e) => {
            log(&format!("update check failed: {}", describe(&e)));
            return;
        }
    };
    if !begin(app, &update.version, true) {
        return;
    }
    log(&format!("{} is available; downloading it in the background", update.version));
    match fetch(app, &update).await {
        Ok(()) => {}
        Err(FetchError::Cancelled) => {
            log("background download cancelled");
            set_phase(app, Phase::Idle, None);
            return;
        }
        Err(FetchError::Failed(reason)) => {
            log(&format!("background download failed: {reason}"));
            set_phase(app, Phase::Failed, Some(reason));
            return;
        }
    }
    if let Some(reason) = crate::commands::busy_with_a_run_reason().await {
        log(&format!("downloaded; waiting to install: {reason}"));
        set_phase(app, Phase::Ready, None);
        return;
    }
    install(app, &update);
}

/// Cancel a download in progress. `false` when nothing was downloading.
pub(crate) fn cancel() -> bool {
    let downloading = status().phase == Phase::Downloading;
    if downloading {
        log("cancel requested");
        CANCEL.store(true, Ordering::SeqCst);
    }
    downloading
}

// ---------------------------------------------------------------------------
// The record of an attempt, read at the next launch
// ---------------------------------------------------------------------------

fn attempt_path() -> PathBuf {
    crate::sidecar::resolve_config_dir().join("update-attempt.json")
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Written right before the installer starts: at the next launch, the version
/// running says whether it took.
fn write_attempt(from: &str, to: &str) {
    let body = json!({
        "from": from,
        "to": to,
        "at": crate::logging::iso8601_utc(SystemTime::now()),
        "atSecs": now_secs(),
    });
    let _ = std::fs::write(attempt_path(), body.to_string());
}

fn remove_attempt() {
    let _ = std::fs::remove_file(attempt_path());
}

/// At launch: did the last update take? An installer that failed leaves no
/// trace in the app otherwise, and the user just sees the old version again.
pub(crate) fn settle_last_attempt(current: &str) {
    let path = attempt_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    let Some(outcome) = outcome_of(&text, current, now_secs()) else {
        return;
    };
    let from = outcome["from"].as_str().unwrap_or("").to_string();
    let to = outcome["to"].as_str().unwrap_or("").to_string();
    if outcome["outcome"] == "failed" {
        log(&format!("the update from {from} to {to} did not finish: this is still {current}"));
        log_installer_tail();
    } else {
        log(&format!("updated from {from} to {current}"));
    }
    *OUTCOME.lock().unwrap_or_else(|p| p.into_inner()) = Some(outcome);
}

/// The pure half of `settle_last_attempt`: what a record means for the version
/// now running. Still the version it started from: the update did not take.
fn outcome_of(record: &str, current: &str, now: u64) -> Option<Value> {
    let v: Value = serde_json::from_str(record).ok()?;
    let from = v["from"].as_str()?;
    let to = v["to"].as_str()?;
    let at = v["atSecs"].as_u64().unwrap_or(0);
    if at == 0 || now.saturating_sub(at) > STALE_ATTEMPT_SECS {
        return None;
    }
    let failed = current == from && current != to;
    Some(json!({
        "outcome": if failed { "failed" } else { "updated" },
        "from": from,
        "to": if failed { to } else { current },
        "at": v["at"],
    }))
}

/// The last update attempt's outcome, once: the window shows it at launch.
pub(crate) fn take_outcome() -> Value {
    OUTCOME.lock().unwrap_or_else(|p| p.into_inner()).take().unwrap_or(Value::Null)
}

/// The installer's own last lines (installer-hooks.nsh writes them) into
/// shell.log, beside the failure they explain.
fn log_installer_tail() {
    let Some(dir) = crate::logging::log_dir() else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(dir.join("installer.log")) else {
        log("the installer wrote no log (it may never have started)");
        return;
    };
    let lines: Vec<&str> = text.lines().collect();
    for line in &lines[lines.len().saturating_sub(12)..] {
        log(&format!("installer.log: {line}"));
    }
}

/// Delete the programs an update moved aside because they were still running
/// (installer-hooks.nsh `VD_MOVE_ASIDE_IF_BUSY`): Windows can rename a running
/// program but not overwrite it. One still running stays for a later launch.
pub(crate) fn remove_moved_aside() {
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_moved_aside(&name) && std::fs::remove_file(entry.path()).is_ok() {
            log(&format!("removed {name}, moved aside by the last update"));
        }
    }
}

/// `videodubber-orchestrator.exe.old-12345`: the installer's name for a busy program.
fn is_moved_aside(name: &str) -> bool {
    name.split_once(".exe.old-")
        .is_some_and(|(stem, ticks)| !stem.is_empty() && !ticks.is_empty() && ticks.bytes().all(|b| b.is_ascii_digit()))
}

/// A JSON-encoded `AppError`, the shape every command error has.
fn error_json(code: &str, message: &str, remediation: Option<&str>) -> String {
    let mut err = json!({ "code": code, "message": message });
    if let Some(r) = remediation {
        err["remediation"] = json!(r);
    }
    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn record(from: &str, to: &str, at: u64) -> String {
        json!({ "from": from, "to": to, "at": "2027-01-15T08:00:00Z", "atSecs": at }).to_string()
    }

    /// Still the version the update started from: the installer never finished.
    #[test]
    fn the_old_version_running_again_is_a_failed_update() {
        let out = outcome_of(&record("0.17.0", "0.17.1", NOW - 60), "0.17.0", NOW).unwrap();
        assert_eq!(out["outcome"], "failed");
        assert_eq!(out["to"], "0.17.1");
    }

    #[test]
    fn the_new_version_running_is_a_finished_update() {
        let out = outcome_of(&record("0.17.0", "0.17.1", NOW - 60), "0.17.1", NOW).unwrap();
        assert_eq!(out["outcome"], "updated");
        assert_eq!(out["to"], "0.17.1");
    }

    /// The user installed something else by hand meanwhile: the version moved,
    /// which is what they wanted, so it reads as updated to what runs now.
    #[test]
    fn another_version_running_reads_as_updated_to_it() {
        let out = outcome_of(&record("0.17.0", "0.17.1", NOW - 60), "0.17.2", NOW).unwrap();
        assert_eq!(out["outcome"], "updated");
        assert_eq!(out["to"], "0.17.2");
    }

    #[test]
    fn an_old_or_unreadable_record_is_ignored() {
        assert!(outcome_of(&record("0.17.0", "0.17.1", NOW - STALE_ATTEMPT_SECS - 1), "0.17.0", NOW).is_none());
        assert!(outcome_of("not json", "0.17.0", NOW).is_none());
        assert!(outcome_of(r#"{"from":"0.17.0"}"#, "0.17.0", NOW).is_none());
    }

    #[test]
    fn only_the_installers_moved_aside_names_are_removed() {
        assert!(is_moved_aside("videodubber-orchestrator.exe.old-123456"));
        assert!(is_moved_aside("vd-piper.exe.old-9"));
        assert!(!is_moved_aside("videodubber-orchestrator.exe"));
        assert!(!is_moved_aside("notes.exe.old-"));
        assert!(!is_moved_aside(".exe.old-12"));
        assert!(!is_moved_aside("ffmpeg.exe.old-12.bak"));
    }

    #[test]
    fn an_error_is_described_with_its_causes() {
        #[derive(Debug)]
        struct Inner;
        impl std::fmt::Display for Inner {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("operation timed out")
            }
        }
        impl std::error::Error for Inner {}
        #[derive(Debug)]
        struct Outer(Inner);
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("error decoding response body")
            }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        assert_eq!(describe(&Outer(Inner)), "error decoding response body: operation timed out");
    }
}
