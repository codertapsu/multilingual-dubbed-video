//! Native OS integration while a dub is running.
//!
//! Dubbing a feature-length video takes long enough that people start it and
//! walk away — and the OS then idles the machine to sleep, which suspends the
//! orchestrator, the workers and every engine mid-run. Nothing fails; the dub
//! just silently stops making progress until someone wakes the machine. So
//! while ANY run is active the shell holds the platform's "busy, don't idle-
//! sleep" assertion, and releases it the moment the queue drains:
//!
//! * macOS — an IOKit power assertion, `PreventUserIdleSystemSleep` (the
//!   display may still sleep; the system may not). Shows up, named, in
//!   `pmset -g assertions` and Activity Monitor's energy tab.
//! * Windows — `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`,
//!   held by a dedicated thread (the state is per-thread, and async tasks hop
//!   threads).
//!
//! The same poll drives the Dock tile / taskbar button progress bar, so a
//! running dub is visible from anywhere on the desktop.
//!
//! Driven by polling the orchestrator's `/queue` (and each running project's
//! progress) rather than by UI events: a run keeps going while the user is on
//! any screen — or none — and the queue is the one source of truth for it.

use std::time::Duration;

use serde_json::Value;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager};

use crate::orchestrator_client;

const POLL: Duration = Duration::from_secs(5);
const REASON: &str = "VideoDubber is dubbing a video";

/// Start the background poll (once, from `setup`).
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut awake: Option<keep_awake::Guard> = None;
        let mut shown: Option<u64> = None;
        loop {
            let progress = running_progress().await;
            match progress {
                Some(p) => {
                    if awake.is_none() {
                        awake = keep_awake::acquire(REASON);
                    }
                    if shown != Some(p) {
                        set_progress(&app, Some(p));
                        shown = Some(p);
                    }
                }
                None => {
                    awake = None; // dropping the guard releases the assertion
                    if shown.is_some() {
                        set_progress(&app, None);
                        shown = None;
                    }
                }
            }
            tokio::time::sleep(POLL).await;
            let _ = &awake; // keep the guard alive across the sleep
        }
    });
}

/// Average progress (0..=100) of the running dubs, or None when none is running
/// (or the backend is unreachable — then nothing should be held either).
async fn running_progress() -> Option<u64> {
    let queue = orchestrator_client::get_json("/queue").await.ok()?;
    let ids = running_ids(&queue);
    if ids.is_empty() {
        return None;
    }
    let mut percents = Vec::with_capacity(ids.len());
    for id in &ids {
        if let Ok(doc) = orchestrator_client::get_json(&format!("/projects/{id}")).await {
            percents.push(doc["pipeline"]["progressPercent"].as_f64().unwrap_or(0.0));
        }
    }
    Some(average_percent(&percents))
}

/// Project ids of the running dubs in a `/queue` response. Pure.
pub fn running_ids(queue: &Value) -> Vec<String> {
    queue["running"]
        .as_array()
        .map(|runs| {
            runs.iter()
                .filter_map(|r| r["projectId"].as_str())
                .filter(|id| id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Mean of the given percentages, clamped to 0..=100 and rounded. Pure.
pub fn average_percent(percents: &[f64]) -> u64 {
    if percents.is_empty() {
        return 0;
    }
    let mean = percents.iter().map(|p| p.clamp(0.0, 100.0)).sum::<f64>() / percents.len() as f64;
    mean.round() as u64
}

fn set_progress(app: &AppHandle, progress: Option<u64>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let state = match progress {
        Some(p) => ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some(p) },
        None => ProgressBarState { status: Some(ProgressBarStatus::None), progress: None },
    };
    if let Err(e) = window.set_progress_bar(state) {
        eprintln!("[videodubber] taskbar progress unavailable: {e}");
    }
}

/// The per-OS "don't idle-sleep" assertion. Dropping the guard releases it.
mod keep_awake {
    #[cfg(target_os = "macos")]
    mod imp {
        use std::ffi::{c_void, CString};

        type CFStringRef = *const c_void;
        type IOPMAssertionID = u32;

        const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
        const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;

        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFStringCreateWithCString(alloc: *const c_void, cstr: *const i8, encoding: u32) -> CFStringRef;
            fn CFRelease(cf: *const c_void);
        }

        #[link(name = "IOKit", kind = "framework")]
        extern "C" {
            fn IOPMAssertionCreateWithName(
                assertion_type: CFStringRef,
                level: u32,
                name: CFStringRef,
                id: *mut IOPMAssertionID,
            ) -> i32;
            fn IOPMAssertionRelease(id: IOPMAssertionID) -> i32;
        }

        fn cf(s: &str) -> Option<CFStringRef> {
            let c = CString::new(s).ok()?;
            // SAFETY: a valid NUL-terminated UTF-8 C string; the result is
            // released by the caller.
            let r = unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8) };
            (!r.is_null()).then_some(r)
        }

        pub struct Guard(IOPMAssertionID);

        pub fn acquire(reason: &str) -> Option<Guard> {
            let kind = cf("PreventUserIdleSystemSleep")?;
            let name = match cf(reason) {
                Some(n) => n,
                None => {
                    // SAFETY: created above, released exactly once.
                    unsafe { CFRelease(kind) };
                    return None;
                }
            };
            let mut id: IOPMAssertionID = 0;
            // SAFETY: both CFStrings are valid for the call; IOKit copies them.
            let rc = unsafe { IOPMAssertionCreateWithName(kind, K_IOPM_ASSERTION_LEVEL_ON, name, &mut id) };
            // SAFETY: each created above, released exactly once.
            unsafe {
                CFRelease(kind);
                CFRelease(name);
            }
            (rc == 0).then_some(Guard(id))
        }

        impl Drop for Guard {
            fn drop(&mut self) {
                // SAFETY: an id returned by a successful create, released once.
                unsafe { IOPMAssertionRelease(self.0) };
            }
        }
    }

    #[cfg(windows)]
    mod imp {
        use std::sync::mpsc;
        use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};

        /// The execution state belongs to the thread that set it, so a
        /// dedicated thread holds it until the guard (the channel) is dropped.
        pub struct Guard(#[allow(dead_code)] mpsc::Sender<()>);

        pub fn acquire(_reason: &str) -> Option<Guard> {
            let (tx, rx) = mpsc::channel::<()>();
            // The holder thread reports whether the call took before a guard is
            // handed out: SetThreadExecutionState returns 0 on failure, and a
            // guard that holds nothing would make the poll loop believe the
            // machine is protected and never try again.
            let (ok_tx, ok_rx) = mpsc::channel::<bool>();
            std::thread::Builder::new()
                .name("vd-keep-awake".into())
                .spawn(move || {
                    // SAFETY: plain Win32 call with documented flag values.
                    let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
                    let _ = ok_tx.send(prev != 0);
                    if prev == 0 {
                        return;
                    }
                    // Blocks until the sender is dropped (recv -> Err).
                    let _ = rx.recv();
                    // SAFETY: as above; restores normal idle behaviour.
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                })
                .ok()?;
            ok_rx.recv().ok()?.then_some(Guard(tx))
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    mod imp {
        pub struct Guard;
        pub fn acquire(_reason: &str) -> Option<Guard> {
            None
        }
    }

    pub use imp::{acquire, Guard};
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_running_project_ids_from_the_queue() {
        let q = json!({ "running": [ { "projectId": "proj_ab12", "name": "A", "heavy": true }, { "projectId": "proj_cd34" } ] });
        assert_eq!(running_ids(&q), vec!["proj_ab12".to_string(), "proj_cd34".to_string()]);
    }

    #[test]
    fn an_empty_or_malformed_queue_means_nothing_is_running() {
        assert!(running_ids(&json!({ "running": [] })).is_empty());
        assert!(running_ids(&json!({})).is_empty());
        assert!(running_ids(&json!({ "running": "nope" })).is_empty());
    }

    #[test]
    fn ignores_ids_that_could_escape_the_url_path() {
        let q = json!({ "running": [ { "projectId": "../etc" }, { "projectId": "proj_ok" } ] });
        assert_eq!(running_ids(&q), vec!["proj_ok".to_string()]);
    }

    #[test]
    fn averages_and_clamps_progress() {
        assert_eq!(average_percent(&[]), 0);
        assert_eq!(average_percent(&[10.0, 30.0]), 20);
        assert_eq!(average_percent(&[150.0, -5.0]), 50);
        assert_eq!(average_percent(&[33.4]), 33);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_assertion_is_created_and_released() {
        let guard = keep_awake::acquire("VideoDubber test assertion");
        assert!(guard.is_some(), "IOPMAssertionCreateWithName failed");
        drop(guard);
    }

    /// The machine-wide execution state — what `powercfg /requests` reports
    /// from — readable without elevation, unlike powercfg itself.
    #[cfg(windows)]
    fn system_execution_state() -> u32 {
        use windows_sys::Win32::System::Power::{CallNtPowerInformation, SystemExecutionState};
        let mut state: u32 = 0;
        // SAFETY: documented call; the output buffer is a u32 of the size we pass.
        let status = unsafe {
            CallNtPowerInformation(
                SystemExecutionState,
                std::ptr::null(),
                0,
                (&mut state as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        };
        assert_eq!(status, 0, "CallNtPowerInformation failed: {status:#x}");
        state
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_execution_state_is_set_and_released() {
        use windows_sys::Win32::System::Power::ES_SYSTEM_REQUIRED;
        // Other software (a media player, a download) may already hold the
        // machine awake, so "before" can legitimately include the flag; what
        // must hold is that it IS set while we hold the guard and that we put
        // things back exactly as we found them.
        let before = system_execution_state() & ES_SYSTEM_REQUIRED;
        let guard = keep_awake::acquire("VideoDubber test");
        assert!(guard.is_some(), "SetThreadExecutionState failed");
        assert_ne!(system_execution_state() & ES_SYSTEM_REQUIRED, 0, "machine not held awake");
        drop(guard);
        // The holder thread clears its state as it exits; give it a moment.
        let mut after = system_execution_state() & ES_SYSTEM_REQUIRED;
        for _ in 0..50 {
            if after == before {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
            after = system_execution_state() & ES_SYSTEM_REQUIRED;
        }
        assert_eq!(after, before, "the keep-awake request outlived its guard");
        // And it can be taken again (the state is per-thread, not global).
        assert!(keep_awake::acquire("VideoDubber test").is_some(), "re-acquire failed");
    }
}
