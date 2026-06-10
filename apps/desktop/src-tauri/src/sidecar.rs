//! Sidecar (managed child process) scaffold — DEFAULT-OFF.
//!
//! In **development**, the backend services are started separately:
//!
//! ```sh
//! pnpm dev            # scripts/dev.sh  (macOS/Linux) — boots:
//!                     #   * Node orchestrator   (port 5100)
//!                     #   * STT worker          (port 5101)
//!                     #   * Translation worker  (port 5102)
//!                     #   * TTS worker          (port 5103)
//!                     #   * Angular dev server  (port 1420)
//! ```
//!
//! …and the desktop shell simply talks to `http://127.0.0.1:5100`. The shell
//! therefore does **not** spawn anything by default — see [`maybe_spawn_services`].
//!
//! In **production**, the services should be packaged and launched as Tauri
//! "sidecars" (externalBin) or as managed child processes. That packaging is a
//! follow-up; the functions below are a compiling scaffold with the wiring and
//! TODOs in place. They are only invoked when the `spawn-sidecars` cargo
//! feature is enabled.
//!
//! ## Production packaging TODO
//! 1. Add the orchestrator + Python workers to `tauri.conf.json`
//!    `bundle.externalBin` (one entry per platform triple, e.g.
//!    `binaries/videodubber-orchestrator`). Build/bundle them with
//!    `pkg`/`nexe` (Node) and `pyinstaller` (Python) during CI.
//! 2. Resolve their paths at runtime via `app.path().resource_dir()` or the
//!    sidecar API (`tauri_plugin_shell::process::CommandEvent`) instead of the
//!    raw `std::process::Command` used in this dev scaffold.
//! 3. Health-check each service (GET /health) with backoff before reporting the
//!    UI as "ready"; emit a `tauri::Emitter` event the splash screen listens to.
//! 4. On window close / app exit, terminate the children (store handles in a
//!    managed [`SidecarManager`] in Tauri state and kill on `RunEvent::Exit`).

use std::process::Child;
use std::sync::Mutex;

use tauri::AppHandle;

/// Holds handles to spawned child processes so they can be killed on shutdown.
///
/// Stored in Tauri's managed state (`app.manage(SidecarManager::default())`).
/// Wrapped in a `Mutex` because Tauri state is shared across threads/commands.
#[derive(Default)]
pub struct SidecarManager {
    children: Mutex<Vec<Child>>,
}

impl SidecarManager {
    /// Registers a spawned child so it is killed when the app exits.
    #[allow(dead_code)] // Used only when the `spawn-sidecars` feature is enabled.
    pub fn track(&self, child: Child) {
        if let Ok(mut guard) = self.children.lock() {
            guard.push(child);
        }
    }

    /// Best-effort termination of all tracked children. Call on app exit.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.children.lock() {
            for mut child in guard.drain(..) {
                // Ignore errors: the process may have already exited.
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Entry point called from `lib.rs` during setup.
///
/// By default this is a no-op: dev services are assumed to be running already
/// (started via `pnpm dev`). When built with `--features spawn-sidecars`, it
/// delegates to [`spawn_dev_services`].
///
/// Returning `Ok(())` (rather than failing setup) keeps the shell launchable
/// even if a service is missing — the UI surfaces unavailability via
/// `GET /workers/health`.
pub fn maybe_spawn_services(app: &AppHandle) -> Result<(), String> {
    #[cfg(feature = "spawn-sidecars")]
    {
        return spawn_dev_services(app);
    }

    // Default path: do nothing. Silence the unused-arg warning.
    #[cfg(not(feature = "spawn-sidecars"))]
    {
        let _ = app;
        log_info("sidecar spawning disabled (default). Assuming `pnpm dev` services are running.");
        Ok(())
    }
}

/// Dev-mode managed spawning (feature-gated). NOT compiled by default.
///
/// This uses raw `std::process::Command`, which is fine for a developer's
/// machine where the toolchain (node/python) is on PATH. It deliberately does
/// NOT use the production sidecar/externalBin mechanism — see the module TODO.
#[cfg(feature = "spawn-sidecars")]
pub fn spawn_dev_services(app: &AppHandle) -> Result<(), String> {
    use std::process::Command;

    let manager: tauri::State<SidecarManager> = {
        use tauri::Manager;
        app.state::<SidecarManager>()
    };

    // --- Node orchestrator (port 5100) ---------------------------------
    // TODO(prod): replace with a bundled sidecar binary resolved via
    // resource_dir(); this assumes a workspace checkout + `pnpm` on PATH.
    match Command::new("pnpm")
        .args(["--filter", "@videodubber/node-orchestrator", "start"])
        .spawn()
    {
        Ok(child) => {
            manager.track(child);
            log_info("spawned node-orchestrator (dev)");
        }
        Err(e) => log_info(&format!("could not spawn orchestrator: {e} (continuing)")),
    }

    // --- Python workers (5101/5102/5103) -------------------------------
    // TODO(prod): bundle each worker (pyinstaller) and launch the frozen
    // binary; here we shell out to the dev launcher script.
    for (label, script) in [
        ("stt-worker", "workers/stt-worker/run.sh"),
        ("translation-worker", "workers/translation-worker/run.sh"),
        ("tts-worker", "workers/tts-worker/run.sh"),
    ] {
        match Command::new("sh").arg(script).spawn() {
            Ok(child) => {
                manager.track(child);
                log_info(&format!("spawned {label} (dev)"));
            }
            Err(e) => log_info(&format!("could not spawn {label}: {e} (continuing)")),
        }
    }

    Ok(())
}

/// Minimal structured-ish logging to stdout. Replace with the `log`/`tracing`
/// crate + `tauri-plugin-log` when richer logging is wired up.
fn log_info(msg: &str) {
    println!("[videodubber:sidecar] {msg}");
}
