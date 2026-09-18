//! Managed backend services for the desktop shell (auto start/stop).
//!
//! When the VideoDubber desktop app **opens**, it boots the backend — the Node
//! orchestrator (5100) and the three Python workers (5101/5102/5103) — and when
//! the app **quits**, the whole backend shuts down with the window. The user
//! never has to run `pnpm dev` (or anything else) by hand.
//!
//! There are TWO ways the backend is launched, selected automatically:
//!
//! ## DEV path (source checkout)
//! When a source checkout is detected (a `pnpm-workspace.yaml` is found by
//! walking up from the cwd/exe, and `VIDEODUBBER_BUNDLED` is not set), the shell
//! launches `scripts/start-services.sh` (`scripts\start-services.ps1` on
//! Windows) as a child **in its own process group**. On quit the whole group is
//! terminated (the launcher's trap stops every child). This is the existing,
//! unchanged behaviour used during development.
//!
//! ## PRODUCTION path (fully self-contained bundle)
//! In a packaged installer there is no source checkout, no Python venv, and no
//! Node on PATH — everything ships as Tauri `externalBin` SIDECARS:
//!   * `videodubber-orchestrator`  (Node, port 5100)
//!   * `vd-stt-worker`             (PyInstaller, port 5101)
//!   * `vd-translation-worker`     (PyInstaller, port 5102)
//!   * `vd-tts-worker`             (PyInstaller, port 5103)
//!   * `ffmpeg` / `ffprobe`        (static, libass-enabled)
//! When bundled (no `pnpm-workspace.yaml`, OR `VIDEODUBBER_BUNDLED=1`), the shell
//! launches the four service sidecars via the Tauri shell plugin
//! (`app.shell().sidecar("…")`), wiring each one's environment (ports, model
//! dirs, and `FFMPEG_PATH`/`FFPROBE_PATH` pointed at the bundled ffmpeg/ffprobe
//! sidecar binaries). The spawned `CommandChild` handles are tracked and killed
//! on exit. See docs/PRODUCTION.md.
//!
//! ## Control
//! - Enabled by default. Set `VIDEODUBBER_MANAGE_SERVICES=0` (or `false`/`no`)
//!   to disable — e.g. when you run the backend yourself via `pnpm dev` and just
//!   want the shell to attach to the already-running services.
//! - Force the production path in dev with `VIDEODUBBER_BUNDLED=1` (handy when
//!   testing a built bundle from a source tree).
//!
//! ## Lifecycle wiring (see `lib.rs`)
//! - `maybe_spawn_services()` runs in Tauri's `.setup()`.
//! - `SidecarManager` is stored in managed state; `shutdown()` runs on
//!   `RunEvent::Exit`, terminating both the dev process group AND any
//!   production sidecar children.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::logging::LogSink;
// Shell plugin: `ShellExt` adds `app.shell()`; `Command::spawn()` returns
// `(Receiver<CommandEvent>, CommandChild)`. `CommandChild::kill()` terminates a
// spawned sidecar. `app.shell().sidecar("name")` resolves the externalBin for
// the current target triple.
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds handles to spawned children so they can be stopped on shutdown.
/// Stored in Tauri's managed state (`app.manage(SidecarManager::default())`).
///
/// Two kinds of children are tracked because the two launch paths differ:
///   * `dev_children`  — `std::process::Child` for the dev launcher script
///                       (terminated together with its process group).
///   * `prod_children` — `CommandChild` for each production sidecar spawned via
///                       the Tauri shell plugin.
#[derive(Default)]
pub struct SidecarManager {
    dev_children: Mutex<Vec<Child>>,
    prod_children: Mutex<Vec<CommandChild>>,
}

/// How long we let the orchestrator wind itself down before we SIGKILL it.
///
/// Sized for what it is actually waiting on: `engineManager.stopAll()` stopping
/// a resident llama.cpp / whisper.cpp / neural-TTS server, each of which is
/// holding gigabytes it has to release. Quitting the app must still *feel*
/// immediate, so this is a ceiling, not a sleep — we poll and return the moment
/// the process is gone.
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(8);

/// The same courtesy for the one-dir workers / dev launcher — shorter, because
/// nothing downstream of them holds a multi-GB model: uvicorn answers SIGTERM in
/// well under a second. Worst case a quit therefore blocks for
/// `GRACEFUL_STOP_TIMEOUT + GROUP_STOP_TIMEOUT`, and only when something is
/// genuinely refusing to die — which is exactly when waiting is right.
const GROUP_STOP_TIMEOUT: Duration = Duration::from_secs(4);

/// Poll interval while waiting for a graceful stop.
const GRACEFUL_POLL_INTERVAL: Duration = Duration::from_millis(100);

impl SidecarManager {
    /// Register a dev-launcher child (`std::process::Child`) so it is terminated
    /// when the app exits.
    pub fn track(&self, child: Child) {
        if let Ok(mut guard) = self.dev_children.lock() {
            guard.push(child);
        }
    }

    /// Register a production sidecar child (`CommandChild`) so it is killed when
    /// the app exits.
    pub fn track_sidecar(&self, child: CommandChild) {
        if let Ok(mut guard) = self.prod_children.lock() {
            guard.push(child);
        }
    }

    /// Best-effort termination of every tracked child.
    ///
    /// * Production sidecars (the orchestrator): a GRACEFUL stop first, then
    ///   `CommandChild::kill()` as the backstop.
    /// * Dev launcher / one-dir workers: SIGTERM to the process **group** first
    ///   (so the launcher's trap and the workers shut down cleanly), then
    ///   SIGKILL.
    ///
    /// WHY THE GRACEFUL STEP EXISTS: `CommandChild::kill()` is a SIGKILL on
    /// Unix and a TerminateProcess on Windows — neither of which the Node
    /// orchestrator can intercept. Its SIGTERM/SIGINT handler
    /// (server.ts, `app.close()` -> `engineManager.stopAll()`) is what stops the
    /// engine-pack children, and those children bind EPHEMERAL ports, so the
    /// port sweep below cannot see them either. Killing the orchestrator
    /// outright therefore left a `llama-server` holding 8-20 GB of RAM/VRAM
    /// alive with no window and no app to close — and on Windows that orphan
    /// also keeps its venv/exe open, which is what makes the next NSIS update
    /// fail with "Error opening file for writing".
    ///
    /// Called on app exit (`RunEvent::Exit`) and before an update installs.
    pub fn shutdown(&self) {
        // Production sidecars first — each is an independent process.
        let mut had_prod = false;
        if let Ok(mut guard) = self.prod_children.lock() {
            had_prod = !guard.is_empty();
            let pids: Vec<u32> = guard.iter().map(|c| c.pid()).collect();
            if !pids.is_empty() {
                request_graceful_stop(&pids);
                wait_for_exit(&pids, GRACEFUL_STOP_TIMEOUT);
            }
            for child in guard.drain(..) {
                // `kill()` consumes the handle. A no-op for anything that
                // already exited above; the backstop for anything that didn't.
                let _ = child.kill();
            }
        }
        // One-dir worker / dev launcher process group(s).
        //
        // Signal them ALL first and then wait once: waiting per child would sum
        // three graceful windows into a quit that can take half a minute, which
        // is the kind of "the app won't close" report this teardown is supposed
        // to prevent.
        if let Ok(mut guard) = self.dev_children.lock() {
            let mut children: Vec<Child> = guard.drain(..).collect();
            for child in &children {
                signal_group_terminate(child.id());
            }
            wait_for_children(&mut children, GROUP_STOP_TIMEOUT);
            for child in &mut children {
                // Force-kill ONLY what we can still positively see running.
                // A reaped pid is free for the kernel to reuse immediately, and
                // a group kill aimed at a RECYCLED id would take down some
                // unrelated process tree on the user's machine — so an
                // `Err` here (status unknowable, see `wait_for_children`) must
                // skip too, not fall through to the kill. `try_wait` caches the
                // status, so this is just a read of what we learned above.
                if !matches!(child.try_wait(), Ok(None)) {
                    continue;
                }
                // Backstop on the group and on the direct handle, in case the
                // graceful signal missed (or, on Windows, never existed).
                terminate_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        // LAST: PyInstaller one-file workers run a bootloader that forks a child;
        // killing the tracked bootloader can orphan that child (which still holds
        // the port). Sweep the known service ports to guarantee a clean teardown.
        // Gated on `had_prod` so we never touch a user's separately-run dev stack,
        // and deliberately after the graceful passes above — sweeping first would
        // SIGKILL the very processes we just asked to shut down cleanly.
        if had_prod {
            sweep_service_ports();
        }
    }
}

/// Entry point called from `lib.rs` during `.setup()`.
///
/// Returns `Ok(())` even on failure so a missing toolchain never blocks the
/// window from opening — the UI reports backend availability via
/// `GET /workers/health`.
/// App handle captured at startup so teardown can run from callbacks that get
/// no handle of their own — specifically the updater's `on_before_exit` hook,
/// which must stop the backend before an installer overwrites its files.
static APP_FOR_TEARDOWN: OnceLock<AppHandle> = OnceLock::new();

/// Stop every backend process, callable without an `AppHandle`.
///
/// The Windows updater runs the NSIS installer over the install directory while
/// our four sidecars are still alive and holding their `.exe`/`.dll` files open,
/// which makes the installer fail with "Error opening file for writing" and can
/// leave a half-updated install. This is the pre-install teardown.
///
/// Falls back to a port sweep if the handle was never captured (e.g. service
/// management disabled), so the ports are freed either way.
pub fn shutdown_all() {
    match APP_FOR_TEARDOWN.get() {
        Some(app) => app.state::<SidecarManager>().shutdown(),
        None => sweep_service_ports(),
    }
}

pub fn maybe_spawn_services(app: &AppHandle) -> Result<(), String> {
    // Capture once; ignored if already set.
    let _ = APP_FOR_TEARDOWN.set(app.clone());

    if !management_enabled() {
        log_info("service management disabled (VIDEODUBBER_MANAGE_SERVICES=0); assuming the backend is already running.");
        return Ok(());
    }

    // Choose the launch path. Production wins when explicitly forced
    // (VIDEODUBBER_BUNDLED=1) or when no source checkout can be located.
    if is_bundled() {
        log_info("running as a bundled app; launching backend sidecars.");
        return spawn_bundled_sidecars(app);
    }

    spawn_dev_services(app)
}

/// Whether the shell should manage the backend lifecycle (default: yes).
fn management_enabled() -> bool {
    match std::env::var("VIDEODUBBER_MANAGE_SERVICES") {
        Ok(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"),
        Err(_) => true,
    }
}

/// Decide whether we are running as a packaged/bundled app (production path).
///
/// Priority:
///   1. `VIDEODUBBER_BUNDLED` override (truthy => bundled, falsey => dev).
///   2. A real bundled build (NOT `tauri dev`) is ALWAYS the production path —
///      `tauri::is_dev()` is a compile-time flag, so this is true even when the
///      freshly-built `.app` happens to sit inside the source tree (a developer
///      double-clicking their own build). This is the bug fix: previously we
///      walked up from the executable, found the repo's `pnpm-workspace.yaml`,
///      and wrongly took the dev path — so the bundled sidecars never launched.
///   3. In a dev build, bundled only if no source checkout can be found.
fn is_bundled() -> bool {
    if let Ok(v) = std::env::var("VIDEODUBBER_BUNDLED") {
        let v = v.trim().to_ascii_lowercase();
        if matches!(v.as_str(), "1" | "true" | "yes" | "on") {
            return true;
        }
        // An explicit falsey value forces the DEV path even from a bundle.
        if matches!(v.as_str(), "0" | "false" | "no" | "off") {
            return false;
        }
    }
    // A compiled bundle (anything other than `tauri dev`) is production.
    if !tauri::is_dev() {
        return true;
    }
    // Dev build: bundled only if we cannot find a source checkout.
    resolve_repo_dir().is_none()
}

// ===========================================================================
// PRODUCTION path — launch the bundled externalBin sidecars via the shell plugin
// ===========================================================================

/// Launch the orchestrator + 3 workers as Tauri shell sidecars.
///
/// Each sidecar is configured purely through environment variables (the
/// capability ACL forbids passing CLI args — see capabilities/default.json),
/// matching the env contract the orchestrator (`config.ts`) and workers
/// (`config.py`) already read:
///   orchestrator: ORCHESTRATOR_PORT, STT/TRANSLATION/TTS_WORKER_URL,
///                 VIDEODUBBER_PROJECTS_DIR, FFMPEG_PATH, FFPROBE_PATH
///   stt:          STT_HOST, STT_PORT, STT_MODEL_CACHE_DIR / HF_HOME
///   translation:  TRANSLATION_WORKER_HOST, TRANSLATION_WORKER_PORT
///   tts:          TTS_WORKER_HOST, TTS_WORKER_PORT, FFMPEG_PATH
///
/// All four are spawned best-effort; a failure to launch one is logged and the
/// UI surfaces it as unavailable via `/workers/health`. Never blocks startup.
fn spawn_bundled_sidecars(app: &AppHandle) -> Result<(), String> {
    // Resolve the bundled ffmpeg/ffprobe sidecar paths so we can hand them to
    // the orchestrator + TTS worker via FFMPEG_PATH/FFPROBE_PATH. Tauri places
    // the per-triple sidecar next to the main executable in the bundle; we ask
    // the shell to resolve the configured externalBin name to a path.
    let (ffmpeg_path, ffprobe_path) = resolve_ffmpeg_paths();

    // Shared dirs (the orchestrator OWNS the config dir; workers read model dirs
    // from it). See the SHARED CONTRACT: config = VIDEODUBBER_CONFIG_DIR or
    // ~/VideoDubber; models live under <config>/models, piper under .../piper.
    let config_dir = resolve_config_dir();
    let projects_dir = config_dir.join("projects");
    let models_dir = config_dir.join("models");
    let piper_dir = models_dir.join("piper");
    let hf_cache = config_dir.join("models").join("huggingface");
    let argos_dir = models_dir.join("argos");

    // Seed the bundled default-pipeline models (whisper 'small' + en->vi Argos +
    // vi Piper voice) into the writable model dirs so a FIRST dub works fully
    // offline, before the user downloads anything. No-op in a dev build and a
    // cheap stat on every launch after the first. See seed_default_models.
    seed_default_models(app, &models_dir);

    // Common loopback host + ports.
    const ORCH_PORT: &str = "5100";
    const STT_PORT: &str = "5101";
    const TRANSLATION_PORT: &str = "5102";
    const TTS_PORT: &str = "5103";
    const LOOPBACK: &str = "127.0.0.1";

    // --- STT worker (5101) -------------------------------------------------
    spawn_worker(
        app,
        "vd-stt-worker",
        &[
            ("STT_HOST", LOOPBACK.to_string()),
            ("STT_PORT", STT_PORT.to_string()),
            // Cache Whisper weights under the app's models dir (not the user's
            // global HF cache) so everything lives in ~/VideoDubber.
            ("STT_MODEL_CACHE_DIR", hf_cache.to_string_lossy().into_owned()),
            ("HF_HOME", hf_cache.to_string_lossy().into_owned()),
            // The STT worker no longer bundles PyAV (which embedded a second
            // FFmpeg to decode audio we had already normalised to 16 kHz mono
            // WAV). It reads that WAV with the stdlib and shells out to the
            // bundled ffmpeg for anything else, so it needs FFMPEG_PATH like the
            // orchestrator and TTS worker. Empty when unresolved — the worker
            // then falls back to `ffmpeg` on PATH.
            ("FFMPEG_PATH", ffmpeg_path.clone().unwrap_or_default()),
        ],
    );

    // --- Translation worker (5102) ----------------------------------------
    spawn_worker(
        app,
        "vd-translation-worker",
        &[
            ("TRANSLATION_WORKER_HOST", LOOPBACK.to_string()),
            ("TRANSLATION_WORKER_PORT", TRANSLATION_PORT.to_string()),
            // Argos packages live under the app's models dir (seeded with the
            // en->vi default, extended by Settings downloads) — not argostranslate's
            // global ~/.local share — so everything stays inside ~/VideoDubber.
            ("ARGOS_PACKAGES_DIR", argos_dir.to_string_lossy().into_owned()),
        ],
    );

    // --- TTS worker (5103) -------------------------------------------------
    {
        let mut env: Vec<(&str, String)> = vec![
            ("TTS_WORKER_HOST", LOOPBACK.to_string()),
            ("TTS_WORKER_PORT", TTS_PORT.to_string()),
            // Where the orchestrator downloaded Piper voices on first run.
            ("PIPER_VOICES_DIR", piper_dir.to_string_lossy().into_owned()),
            ("VIDEODUBBER_CACHE_DIR", config_dir.join("cache").to_string_lossy().into_owned()),
        ];
        if let Some(ffmpeg) = ffmpeg_path.as_ref() {
            env.push(("FFMPEG_PATH", ffmpeg.clone()));
        }
        // The bundled Piper CLI (frozen piper-tts) — without it the worker can
        // only use system/fallback TTS, which silently produced English audio
        // for Vietnamese dubs before this was wired up.
        if let Some(piper) = resolve_sidecar_bin("vd-piper") {
            env.push(("PIPER_BINARY_PATH", piper));
        } else {
            log_info("bundled 'vd-piper' not found; the TTS worker will use system/fallback voices only.");
        }
        spawn_worker(app, "vd-tts-worker", &env);
    }

    // --- Orchestrator (5100) ----------------------------------------------
    // Launch LAST so the workers are coming up by the time it starts probing
    // them (it tolerates not-yet-ready workers and re-checks via /workers/health).
    {
        let mut env: Vec<(&str, String)> = vec![
            ("ORCHESTRATOR_PORT", ORCH_PORT.to_string()),
            ("ORCHESTRATOR_HOST", LOOPBACK.to_string()),
            (
                "STT_WORKER_URL",
                format!("http://{LOOPBACK}:{STT_PORT}"),
            ),
            (
                "TRANSLATION_WORKER_URL",
                format!("http://{LOOPBACK}:{TRANSLATION_PORT}"),
            ),
            (
                "TTS_WORKER_URL",
                format!("http://{LOOPBACK}:{TTS_PORT}"),
            ),
            ("VIDEODUBBER_PROJECTS_DIR", projects_dir.to_string_lossy().into_owned()),
            ("VIDEODUBBER_CONFIG_DIR", config_dir.to_string_lossy().into_owned()),
            ("VIDEODUBBER_MODELS_DIR", models_dir.to_string_lossy().into_owned()),
            // We reached this code path, so this is the bundled/production launch.
            // The orchestrator uses this to own its whole toolchain (e.g. never
            // fall back to a system `uv` when the bundled one is broken). See uv.ts.
            ("VIDEODUBBER_BUNDLED", "1".to_string()),
            // Same HF hub cache the STT worker downloads into (above), so the
            // orchestrator can watch whisper-model downloads and report a true
            // percentage during first-run setup / project resource ensure.
            ("STT_MODEL_CACHE_DIR", hf_cache.to_string_lossy().into_owned()),
        ];
        if let Some(ffmpeg) = ffmpeg_path.as_ref() {
            env.push(("FFMPEG_PATH", ffmpeg.clone()));
        }
        if let Some(ffprobe) = ffprobe_path.as_ref() {
            env.push(("FFPROBE_PATH", ffprobe.clone()));
        }
        // The bundled `uv` lets the orchestrator install the optional Python
        // engine packs (neural TTS / separation / alignment) — and uv fetches
        // its own Python — so the user needs NOTHING preinstalled. Without it,
        // those packs surface an "install uv" remediation in the UI.
        if let Some(uv) = resolve_sidecar_bin("vd-uv") {
            env.push(("VIDEODUBBER_UV_PATH", uv));
        } else {
            log_info("bundled 'vd-uv' not found; Python engine packs will require uv on PATH.");
        }
        // The first-party engine-pack worker source (vd_tts_engine, the VieNeu
        // neural-TTS server). It runs inside the uv venv and is imported from
        // PYTHONPATH; bundling it as a resource means the user installs nothing.
        if let Some(src) = resolve_engine_src_dir(app) {
            env.push(("VIDEODUBBER_ENGINE_SRC_DIR", src));
        } else {
            log_info("bundled engine-src not found; the neural-TTS pack will fall back to the repo path (dev only).");
        }
        // Point uv at the BUNDLED standalone CPython so engine-pack installs don't
        // download an interpreter from GitHub at runtime (which fails on flaky
        // international links). Staged into resources/python by fetch-python.*.
        // only-managed + downloads=never => uv uses ONLY the bundled runtime.
        if let Some(py_dir) = resolve_bundled_python_dir(app) {
            env.push(("UV_PYTHON_INSTALL_DIR", py_dir));
            env.push(("UV_PYTHON_DOWNLOADS", "never".to_string()));
            env.push(("UV_PYTHON_PREFERENCE", "only-managed".to_string()));
        } else {
            log_info("bundled Python runtime not found; uv will download CPython on first engine-pack install (needs network).");
        }
        spawn_one(app, "videodubber-orchestrator", &env);
    }

    Ok(())
}

/// Spawn a single externalBin sidecar with the given environment.
///
/// `name` is the externalBin entry exactly as declared in tauri.conf.json
/// (e.g. `"videodubber-orchestrator"`) — this must match the shell
/// capability scope `name` in capabilities/default.json so the ACL permits it.
/// Tauri resolves it to the per-target-triple binary inside the bundle.
///
/// Uses `app.shell().sidecar(name)` -> a `Command` builder; `.env(k, v)` sets
/// each variable; `.spawn()` returns `(Receiver<CommandEvent>, CommandChild)`.
/// The receiver (stdout/stderr/close events) is dropped — we don't stream worker
/// logs to the webview — and the child handle is tracked for shutdown.
fn spawn_one(app: &AppHandle, name: &str, env: &[(&str, String)]) {
    let mut sidecar = match app.shell().sidecar(name) {
        Ok(cmd) => cmd,
        Err(e) => {
            log_info(&format!(
                "could not resolve sidecar '{name}': {e} (the UI will show it as unavailable)."
            ));
            return;
        }
    };

    // Force UTF-8 stdio for every sidecar. Windows defaults the Python console
    // encoding to cp1252, which raises UnicodeEncodeError the moment a worker (or
    // a dependency like the VieNeu SDK) prints a non-Latin-1 string — e.g. a
    // Vietnamese voice name "Ngọc Lan" or a "…" — crashing the process. PYTHONUTF8
    // and PYTHONIOENCODING make stdout/stderr UTF-8 on every platform; harmless
    // for the Node orchestrator, which also passes them to the engine-pack Python
    // workers it spawns. Set first so explicit per-sidecar env can still override.
    sidecar = sidecar.env("PYTHONUTF8", "1");
    sidecar = sidecar.env("PYTHONIOENCODING", "utf-8");

    // Trust the OS certificate store for outbound HTTPS. uv (rustls), Node, and
    // Python all ship their OWN bundled CA roots and ignore the Windows store, so
    // behind a proxy / antivirus that does HTTPS inspection — whose CA is in the
    // Windows store but not in those bundled roots — downloads fail with "invalid
    // peer certificate" even though the browser works. Export the Windows store
    // once, MERGE it with the workers' certifi roots (SSL_CERT_FILE and
    // REQUESTS_CA_BUNDLE replace the trust store rather than extend it — see
    // merge_with_certifi), and point Node (NODE_EXTRA_CA_CERTS, additive) and
    // Python at the result. Engine-pack workers + uv inherit
    // it via the orchestrator; uv additionally uses UV_NATIVE_TLS. No-op off Windows.
    if let Some(ca) = system_ca_bundle(app) {
        sidecar = sidecar.env("NODE_EXTRA_CA_CERTS", ca);
        sidecar = sidecar.env("SSL_CERT_FILE", ca);
        sidecar = sidecar.env("REQUESTS_CA_BUNDLE", ca);
    }

    // `Command::env(key, value)` (tauri-plugin-shell 2.x) takes `self` by value
    // and returns the builder, so we rebind on each call. Chained per-var sets
    // are the most version-stable form of the shell `Command` env API.
    for (key, value) in env {
        sidecar = sidecar.env(*key, value.clone());
    }

    match sidecar.spawn() {
        Ok((rx, child)) => {
            // The whole descendant tree joins the Windows job object, so the
            // engine-pack servers the orchestrator spawns die with the app even
            // if the app crashes. No-op on Unix (process groups cover it).
            adopt_into_process_tree(child.pid());
            // Drain the event receiver into `<config>/logs/<name>.log`. This used
            // to be dropped on the floor ("we don't stream worker logs to the
            // webview"), which meant a packaged build kept NO record of why the
            // orchestrator failed to start — the single biggest hole in
            // diagnosing a user's broken install.
            pipe_command_events_to_log(name, rx);
            // Track the child so it is killed on app exit. Fetch the managed
            // SidecarManager here (avoids threading a `State` borrow through the
            // builder, which would tangle lifetimes with the `Command`).
            app.state::<SidecarManager>().track_sidecar(child);
            log_info(&format!("launched sidecar '{name}'."));
        }
        Err(e) => log_info(&format!(
            "failed to launch sidecar '{name}': {e} (the UI will show it as unavailable)."
        )),
    }
}

/// Launch a ONE-DIR Python worker (stt/translation/tts) from its bundled resource
/// tree at `resources/workers/<name>/<name>[.exe]`.
///
/// One-dir workers can't be Tauri `externalBin` (those are single files), so they
/// ship as a resource folder and we launch the exe directly via std `Command`.
/// Launching by its real path lets the PyInstaller bootloader find its sibling
/// `_internal/` dir — and avoids the per-launch one-file extraction (~25s for the
/// three workers together) that prompted this. Mirrors `spawn_one`'s env
/// (UTF-8 stdio, OS trust store) + the per-sidecar env, and tracks the child for
/// shutdown. The `env` is the same `(key, value)` list `spawn_one` takes.
fn spawn_worker(app: &AppHandle, name: &str, env: &[(&str, String)]) {
    let exe = match resolve_worker_exe(app, name) {
        Some(p) => p,
        None => {
            log_info(&format!(
                "one-dir worker '{name}' not found under resources/workers (the UI will show it as unavailable)."
            ));
            return;
        }
    };

    let mut cmd = Command::new(&exe);
    // UTF-8 stdio + OS trust store, same as spawn_one gives the shell sidecars.
    cmd.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
    if let Some(ca) = system_ca_bundle(app) {
        cmd.env("SSL_CERT_FILE", ca).env("REQUESTS_CA_BUNDLE", ca);
    }
    for (key, value) in env {
        cmd.env(*key, value);
    }
    // No console window / its own process group (Windows: CREATE_NO_WINDOW |
    // CREATE_NEW_PROCESS_GROUP; unix: setpgid) so we can kill the tree on exit.
    // stdin stays null; stdout/stderr are PIPED and pumped into
    // `<config>/logs/<name>.log` below. They used to be `Stdio::null()` — a
    // valid handle (so the windowed build's sys.stdout/stderr stay non-None)
    // but one that threw every traceback away, leaving a user whose dub failed
    // on an installed build with literally nothing to send back. A pipe is
    // equally valid as a handle and keeps the output.
    cmd.stdin(Stdio::null());
    let capture = worker_log_sink(name);
    if capture.is_some() {
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    } else {
        // No writable log dir — fall back to the old behaviour rather than
        // leaving pipes nobody drains, which would block the worker once the
        // pipe buffer filled.
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }
    configure_process_group(&mut cmd);

    match cmd.spawn() {
        Ok(mut child) => {
            adopt_into_process_tree(child.id());
            if let Some(sink) = capture {
                pipe_child_output_to_log(&mut child, sink);
            }
            app.state::<SidecarManager>().track(child);
            log_info(&format!("launched one-dir worker '{name}'."));
        }
        Err(e) => log_info(&format!(
            "failed to launch one-dir worker '{name}': {e} (the UI will show it as unavailable)."
        )),
    }
}

/// Resolve the launchable executable of a bundled one-dir worker, trying the
/// layouts Tauri may use for a declared `resources/workers` resource.
fn resolve_worker_exe(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    let exe_name = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    [
        res.join("workers").join(name).join(&exe_name),
        res.join("resources").join("workers").join(name).join(&exe_name),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

/// Resolve the bundled `ffmpeg`/`ffprobe` sidecar paths to hand to the
/// orchestrator + TTS worker via `FFMPEG_PATH`/`FFPROBE_PATH`.
///
/// ffmpeg/ffprobe are plain executables (not services we run), so we don't spawn
/// them — we just need their on-disk path. Tauri lays the per-triple sidecar
/// next to the main app binary. We derive that path from `current_exe()` and the
/// configured base name + the platform extension. Returns `(ffmpeg, ffprobe)`,
/// each `None` if it can't be located (the orchestrator then falls back to PATH,
/// which in a clean bundle means it reports ffmpeg as unavailable).
fn resolve_ffmpeg_paths() -> (Option<String>, Option<String>) {
    (resolve_sidecar_bin("ffmpeg"), resolve_sidecar_bin("ffprobe"))
}

/// Resolve a bundled executable sidecar (`externalBin`) to its on-disk path.
///
/// Tauri strips the `-<target-triple>` suffix when placing the sidecar in the
/// bundle, so the resolved file is just `<base>`/`<base>.exe` next to the main
/// app binary. Returns `None` if the file does not exist there (e.g. a local
/// build made without that optional sidecar).
fn resolve_sidecar_bin(base: &str) -> Option<String> {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))?;

    #[cfg(windows)]
    let bin = dir.join(format!("{base}.exe"));
    #[cfg(not(windows))]
    let bin = dir.join(base);

    bin.exists().then(|| bin.to_string_lossy().into_owned())
}

/// Resolve the bundled engine-pack worker SOURCE dir — the parent of the staged
/// worker packages (`vd_tts_engine/`; more as packs ship) — to hand the
/// orchestrator as VIDEODUBBER_ENGINE_SRC_DIR.
///
/// Bundled via tauri.conf `resources` (staged by scripts/package/stage-engine-src.mjs).
/// Tauri's exact on-disk resource layout can differ (it may or may not preserve
/// the `resources/` prefix), so we try the likely locations and accept the first
/// that actually contains the `vd_tts_engine` package. Returns `None` when the
/// resource isn't bundled (e.g. a build made without staging it).
fn resolve_engine_src_dir(app: &AppHandle) -> Option<String> {
    let res = app.path().resource_dir().ok()?;
    let candidates = [res.join("engine-src"), res.join("resources").join("engine-src")];
    candidates
        .into_iter()
        .find(|c| c.join("vd_tts_engine").is_dir())
        .map(|c| c.to_string_lossy().into_owned())
}

/// Resolve the bundled default-pipeline models dir (`resources/default-models`,
/// staged at build by scripts/package/fetch-default-models.sh). `None` in a
/// dev/source build (those rely on the first-run wizard download).
fn resolve_default_models_dir(app: &AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    [res.join("default-models"), res.join("resources").join("default-models")]
        .into_iter()
        .find(|c| c.is_dir())
}

/// Recursively copy `src` into `dst`, NEVER clobbering an existing destination
/// file — so a model the user later downloaded (e.g. large-v3-turbo in the same
/// hf cache) is preserved. Cheap on repeat launches: present files are just stat'd.
fn copy_if_absent(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_if_absent(&from, &to)?;
        } else if !to.exists() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Seed the bundled default-pipeline models (whisper 'small' + en->vi Argos + the
/// vi Piper voice) into the WRITABLE model dirs (`<config>/models/{huggingface,
/// argos,piper}`) on launch, so a FIRST dub works fully offline, out of the box.
/// Copy-if-absent, so user-downloaded models are never touched. Best-effort —
/// logged, never fatal; a dev build (no bundled models) is a no-op.
fn seed_default_models(app: &AppHandle, models_dir: &Path) {
    let Some(src_root) = resolve_default_models_dir(app) else {
        return;
    };
    for sub in ["huggingface", "argos", "piper"] {
        let src = src_root.join(sub);
        if !src.is_dir() {
            continue;
        }
        if let Err(e) = copy_if_absent(&src, &models_dir.join(sub)) {
            log_info(&format!("seeding bundled default models: '{sub}' copy failed: {e}"));
        }
    }
    log_info("seeded bundled default-pipeline models (offline out-of-box dub).");
}

/// Resolve the bundled standalone-CPython install dir — a `UV_PYTHON_INSTALL_DIR`
/// uv can use offline — staged by scripts/package/fetch-python.* into
/// `resources/python`. Returns the dir that contains a `cpython-*` runtime, or
/// `None` when it isn't bundled (dev build, or the optional pre-install was
/// skipped/failed — the runtime then has uv download CPython on first use).
fn resolve_bundled_python_dir(app: &AppHandle) -> Option<String> {
    let res = app.path().resource_dir().ok()?;
    let candidates = [res.join("python"), res.join("resources").join("python")];
    candidates
        .into_iter()
        .find(|c| dir_has_cpython(c))
        .map(|c| c.to_string_lossy().into_owned())
}

/// True if `dir` directly contains a `cpython-*` entry (the python-build-standalone
/// runtime uv installs), i.e. it's usable as a UV_PYTHON_INSTALL_DIR.
fn dir_has_cpython(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with("cpython-"))
        })
        .unwrap_or(false)
}

/// Resolve the app config dir per the SHARED CONTRACT: `VIDEODUBBER_CONFIG_DIR`
/// env if set, else `~/VideoDubber`.
pub(crate) fn resolve_config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("VIDEODUBBER_CONFIG_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    home_dir().join("VideoDubber")
}

/// Best-effort home directory (`$HOME` / `%USERPROFILE%`), falling back to ".".
fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

// ===========================================================================
// DEV path — launch scripts/start-services.sh (unchanged behaviour)
// ===========================================================================

/// Launch the dev launcher script in its own process group (source checkout).
fn spawn_dev_services(app: &AppHandle) -> Result<(), String> {
    let repo_dir = match resolve_repo_dir() {
        Some(dir) => dir,
        None => {
            log_info(
                "could not locate the project root (pnpm-workspace.yaml). Skipping managed start; \
                 set VIDEODUBBER_REPO_DIR or start the backend with `pnpm dev`.",
            );
            return Ok(());
        }
    };

    let (program, args, script) = launcher(&repo_dir);
    if !script.exists() {
        log_info(&format!(
            "launcher script not found at {}; skipping managed start.",
            script.display()
        ));
        return Ok(());
    }

    log_info(&format!("starting backend services via {}", script.display()));
    let mut cmd = Command::new(program);
    cmd.args(&args).current_dir(&repo_dir);
    configure_process_group(&mut cmd);

    match cmd.spawn() {
        Ok(child) => {
            // Same job object as the production spawns: on Windows the launcher
            // is a PowerShell script whose node/python grandchildren are NOT
            // reachable from `terminate_group` once the launcher itself is gone.
            // No-op off Windows.
            adopt_into_process_tree(child.id());
            app.state::<SidecarManager>().track(child);
            log_info("backend services launching (orchestrator + STT/translation/TTS workers).");
        }
        Err(e) => log_info(&format!("could not launch backend services: {e} (the UI will show them as unavailable).")),
    }

    Ok(())
}

/// Resolve the project root that contains `scripts/` + `pnpm-workspace.yaml`.
/// Priority: `VIDEODUBBER_REPO_DIR` env, then walk up from the current dir, then
/// from the executable's directory.
fn resolve_repo_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("VIDEODUBBER_REPO_DIR") {
        let p = PathBuf::from(dir);
        if p.join("pnpm-workspace.yaml").is_file() {
            return Some(p);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(found) = walk_up_for_workspace(&cwd) {
            return Some(found);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(found) = walk_up_for_workspace(parent) {
                return Some(found);
            }
        }
    }
    None
}

/// Walk up the directory tree looking for `pnpm-workspace.yaml`.
fn walk_up_for_workspace(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        if dir.join("pnpm-workspace.yaml").is_file() {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

/// The per-OS launcher: program, args, and the resolved script path.
fn launcher(repo_dir: &Path) -> (&'static str, Vec<String>, PathBuf) {
    #[cfg(windows)]
    {
        let script = repo_dir.join("scripts").join("start-services.ps1");
        (
            "pwsh",
            vec![
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                script.to_string_lossy().into_owned(),
            ],
            script,
        )
    }
    #[cfg(not(windows))]
    {
        let script = repo_dir.join("scripts").join("start-services.sh");
        ("bash", vec![script.to_string_lossy().into_owned()], script)
    }
}

/// Put the child in its own process group so we can signal the whole tree on
/// exit (orchestrator + workers + the launcher's trapped cleanup).
#[cfg(unix)]
fn configure_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // process_group(0) => the child becomes leader of a new group whose id == its pid.
    cmd.process_group(0);
}

#[cfg(windows)]
fn configure_process_group(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // New process group so we can taskkill /T the whole tree on exit; CREATE_NO_WINDOW
    // so a one-dir worker (or the dev launcher) never flashes a console window.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

/// Ask the process group led by `pid` to stop cleanly (SIGTERM), so the dev
/// launcher's trap runs and uvicorn finishes its own shutdown.
///
/// Paired with `wait_for_children` + `terminate_group`, which are the backstop.
#[cfg(unix)]
fn signal_group_terminate(pid: u32) {
    // SAFETY: `killpg` on a group id with a valid signal is safe; a group that
    // has already exited just returns ESRCH.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGTERM);
    }
}

/// Windows has no SIGTERM and our sidecars are spawned with CREATE_NO_WINDOW,
/// so there is no console to send a CTRL_BREAK to either. Nothing graceful is
/// available here — `terminate_group` (taskkill /T /F) plus the Job Object is
/// the whole story.
#[cfg(windows)]
fn signal_group_terminate(_pid: u32) {}

/// Wait for every child to exit, or until `budget` elapses — ONE shared window
/// for the whole set, not one per child.
///
/// Reaps as it goes (`try_wait`), which is also why this cannot be expressed
/// with the pid-based `process_alive`: a child we own but have not waited on
/// stays a zombie, and a zombie answers `kill(pid, 0)` as alive forever.
fn wait_for_children(children: &mut [Child], budget: Duration) {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        // `Ok(None)` — still running — is the ONLY state worth waiting for.
        // `Err` means we can never learn this child's status (`waitpid` answers
        // ECHILD once something else has reaped it, which happens as soon as
        // anything in the process sets SIGCHLD to SIG_IGN), so treating it as
        // "alive" would spend the entire budget on a status that can never
        // arrive — a four-second stall on every quit.
        let still_running = children
            .iter_mut()
            .any(|c| matches!(c.try_wait(), Ok(None)));
        if !still_running {
            return;
        }
        std::thread::sleep(GRACEFUL_POLL_INTERVAL);
    }
    log_info("a backend worker did not stop within the graceful window; forcing termination.");
}

/// Terminate the process group led by `pid` (the forceful backstop).
#[cfg(unix)]
fn terminate_group(pid: u32) {
    // `killpg` targets the whole group the child leads (see
    // `configure_process_group`); this used to shell out to /bin/kill with a
    // negative pid, which spawned two processes per service on every quit.
    //
    // SAFETY: as in `signal_group_terminate`.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate_group(pid: u32) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: don't flash a console window for the kill on app quit.
    // /T kills the whole process tree; /F forces it.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

// ===========================================================================
// Graceful stop — give the orchestrator a chance to reap its OWN children
// ===========================================================================

/// Ask every tracked production sidecar to stop cleanly.
///
/// Two channels, because neither one covers both platforms:
///   * **HTTP** — `POST /shutdown` on the orchestrator. This is the only
///     graceful channel that can work on Windows, where Node cannot receive
///     SIGTERM at all and our sidecars have no console to send a CTRL_BREAK to.
///     Tolerates a 404 (see the handoff note below).
///   * **SIGTERM** — Unix only, and the channel that works today: the
///     orchestrator installs SIGTERM/SIGINT handlers that run `app.close()` ->
///     `engineManager.stopAll()`, which is what stops the engine-pack children.
///
/// NOTE: the HTTP half is deliberately written against a route the orchestrator
/// does not expose yet; until it does, Windows still relies on the Job Object
/// (see `job`) to take the tree down, which is abrupt but never orphans.
fn request_graceful_stop(pids: &[u32]) {
    post_shutdown_over_http();
    signal_terminate(pids);
}

/// A minimal, blocking `POST /shutdown` written straight onto a socket.
///
/// WHY NOT `reqwest`: this runs from `RunEvent::Exit` and from the updater's
/// `on_before_exit` hook. The first is the main thread outside any async
/// context; the second may already be inside one, where `block_on` panics. A
/// 20-line blocking request with its own deadline is safe from both, and the
/// dependency-free version cannot fail to build on either platform.
fn post_shutdown_over_http() {
    use std::io::Write as _;
    use std::net::{TcpStream, ToSocketAddrs};

    let base = crate::orchestrator_client::base_url();
    let Some(authority) = base.split("://").nth(1) else {
        return;
    };
    let Ok(mut addrs) = authority.to_socket_addrs() else {
        return;
    };
    let Some(addr) = addrs.next() else {
        return;
    };
    // Short connect deadline: if the orchestrator is not listening there is
    // nothing to shut down and quitting must not stall on it.
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let _ = stream.write_all(
        format!("POST /shutdown HTTP/1.1\r\nHost: {authority}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    );
    let _ = stream.flush();
}

/// Unix: SIGTERM each sidecar so its own signal handler runs.
#[cfg(unix)]
fn signal_terminate(pids: &[u32]) {
    for &pid in pids {
        // SAFETY: `kill` with a positive pid and a valid signal is always safe;
        // a stale pid just returns ESRCH, which we ignore.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

/// Windows has no SIGTERM. The graceful channel there is the HTTP request
/// above; the guaranteed one is the Job Object.
#[cfg(windows)]
fn signal_terminate(_pids: &[u32]) {}

/// Block until every pid has exited, or `budget` elapses. Returns early the
/// moment they are all gone so quitting still feels instant.
fn wait_for_exit(pids: &[u32], budget: Duration) {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if !pids.iter().copied().any(process_alive) {
            return;
        }
        std::thread::sleep(GRACEFUL_POLL_INTERVAL);
    }
    log_info("backend did not stop within the graceful window; forcing termination.");
}

/// Is the process still running? (Reaped/zombie counts as gone — the shell
/// plugin's waiter thread reaps the child as soon as it exits.)
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 performs the permission/existence check without
    // delivering anything.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: a failed OpenProcess returns null (checked); the handle is closed
    // on every path.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

// ===========================================================================
// Windows Job Object — the backstop that makes orphans impossible
// ===========================================================================

/// Windows-only: a process Job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
///
/// WHY: on Unix a process group plus a SIGTERM/SIGKILL pair reaches the whole
/// tree, and a killed parent's children are at least reparented somewhere we
/// can sweep. Windows has neither — `taskkill /T` walks the tree we know about
/// at that instant, and if the app CRASHES nothing runs at all. The result was
/// llama.cpp / whisper.cpp / neural-TTS servers surviving with gigabytes
/// resident and no window to close, and holding their venv `.exe`s open so the
/// next NSIS update failed with "Error opening file for writing".
///
/// A Job fixes both: every backend process we spawn is assigned to it, the
/// handle is deliberately LEAKED into a `OnceLock` for the app's lifetime, and
/// when the last handle closes — normal exit, crash, or Task Manager — Windows
/// terminates every process still in the job, descendants included.
#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// The job handle as a `usize` so it is `Send + Sync` in the `OnceLock`.
    /// Never closed: closing it is exactly what kills the backend, so it must
    /// outlive everything and be released by the OS at process teardown.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn handle() -> Option<HANDLE> {
        let raw = JOB.get_or_init(|| {
            // SAFETY: a null name/attrs creates an anonymous job; the limit
            // struct is fully initialised before it is handed over.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return 0;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) != 0;
                if !ok {
                    CloseHandle(job);
                    return 0;
                }
                job as usize
            }
        });
        (*raw != 0).then_some(*raw as HANDLE)
    }

    /// Put a spawned backend process (and therefore everything it spawns) into
    /// the job. Best-effort: a failure only costs us the backstop, never the
    /// launch, so it is logged and ignored.
    pub fn assign(pid: u32) {
        let Some(job) = handle() else {
            super::log_info("could not create the Windows job object; backend processes may survive a crash.");
            return;
        };
        // SAFETY: the handle is checked for null and closed on every path.
        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc.is_null() {
                return;
            }
            if AssignProcessToJobObject(job, proc) == 0 {
                super::log_info(&format!("could not add pid {pid} to the job object."));
            }
            CloseHandle(proc);
        }
    }
}

/// Assign a freshly spawned backend process to the Windows job object. No-op
/// elsewhere — Unix uses process groups (see `configure_process_group`).
#[cfg(windows)]
fn adopt_into_process_tree(pid: u32) {
    job::assign(pid);
}

#[cfg(not(windows))]
fn adopt_into_process_tree(_pid: u32) {}

/// The backend service ports the bundled app owns. Kept in sync with the env we
/// hand the sidecars in `spawn_bundled_sidecars` (orchestrator + 3 workers).
const SERVICE_PORTS: [&str; 4] = ["5100", "5101", "5102", "5103"];

/// Kill whatever is still listening on the backend service ports. Used on quit
/// to guarantee teardown even when a sidecar (e.g. a PyInstaller one-file
/// bootloader) leaves an orphaned child holding the port.
#[cfg(unix)]
fn sweep_service_ports() {
    for port in SERVICE_PORTS {
        let _ = Command::new("sh")
            .arg("-c")
            .arg(format!(
                "lsof -ti tcp:{port} -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null"
            ))
            .status();
    }
}

#[cfg(windows)]
fn sweep_service_ports() {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: this runs on app quit; without it each port sweep flashes
    // a PowerShell console window (the "CMD windows flashing when closing" report).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    for port in SERVICE_PORTS {
        let _ = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Get-NetTCPConnection -State Listen -LocalPort {port} -ErrorAction SilentlyContinue | \
                     ForEach-Object {{ taskkill /PID $_.OwningProcess /T /F }}"
                ),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

/// A PEM bundle of the OS trust store, exported once per run and cached. Lets the
/// bundled Node + Python downloaders trust a locally-installed HTTPS-inspection CA
/// (corporate proxy / antivirus) that lives in the OS store but not in their
/// bundled roots. Returns `None` off Windows (the platform defaults already
/// consult the system store there) or if the export fails.
fn system_ca_bundle(app: &AppHandle) -> Option<&'static str> {
    static BUNDLE: OnceLock<Option<String>> = OnceLock::new();
    if let Some(cached) = BUNDLE.get() {
        return cached.as_deref();
    }
    let built = export_system_ca_bundle().map(|os_pem| merge_with_certifi(app, os_pem));
    BUNDLE.set(built).ok();
    BUNDLE.get().and_then(|b| b.as_deref())
}

/// Locate a bundled worker's `certifi/cacert.pem` (all three ship the same
/// Mozilla root bundle, so the first one found will do).
fn bundled_certifi(app: &AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    for base in [res.join("workers"), res.join("resources").join("workers")] {
        for worker in ["vd-stt-worker", "vd-translation-worker", "vd-tts-worker"] {
            let p = base.join(worker).join("_internal").join("certifi").join("cacert.pem");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Produce the PEM the Python workers should trust: the public Mozilla roots
/// FOLLOWED BY the OS store export.
///
/// WHY MERGE: `NODE_EXTRA_CA_CERTS` is additive, but `SSL_CERT_FILE` and
/// `REQUESTS_CA_BUNDLE` REPLACE the trust store — httpx/requests use the named
/// file *instead of* certifi. Pointing them at an OS-only dump therefore made
/// the workers trust only what happens to be materialised in the Windows root
/// store, which Windows seeds sparsely and fills in lazily via CryptoAPI —
/// something Python never triggers. The result: on a freshly imaged or
/// update-restricted machine, the mandatory first-run Whisper model download
/// fails with CERTIFICATE_VERIFY_FAILED against huggingface.co (whose chain
/// needs Amazon Root CA 1) while the browser on the same box works.
///
/// Merging keeps the proxy/antivirus CA fix that motivated the export while
/// restoring the public roots. Falls back to the OS-only file if certifi isn't
/// found — still better than nothing behind an inspecting proxy.
fn merge_with_certifi(app: &AppHandle, os_pem: String) -> String {
    let Some(certifi) = bundled_certifi(app) else {
        log_info("bundled certifi not found; Python TLS will use the OS trust store only.");
        return os_pem;
    };
    let (Ok(roots), Ok(os_certs)) = (std::fs::read_to_string(&certifi), std::fs::read_to_string(&os_pem)) else {
        return os_pem;
    };
    let merged_path = std::env::temp_dir().join("videodubber-ca-merged.pem");
    match std::fs::write(&merged_path, format!("{roots}\n{os_certs}")) {
        Ok(()) => {
            log_info(&format!("merged certifi + OS trust store for Python TLS -> {}", merged_path.display()));
            merged_path.to_string_lossy().into_owned()
        }
        Err(e) => {
            log_info(&format!("could not write the merged CA bundle ({e}); using the OS store only."));
            os_pem
        }
    }
}

#[cfg(windows)]
fn export_system_ca_bundle() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::env::temp_dir().join("videodubber-system-ca.pem");
    // PowerShell: concatenate every cert in the user + machine Root/CA stores into
    // a PEM. `\` continuations keep it a single command line; `__OUT__` is replaced
    // with the (single-quote-escaped) output path so no format-brace juggling.
    let template = "\
$ErrorActionPreference='SilentlyContinue'; \
$sb=New-Object System.Text.StringBuilder; \
foreach($s in 'Cert:\\LocalMachine\\Root','Cert:\\CurrentUser\\Root','Cert:\\LocalMachine\\CA','Cert:\\CurrentUser\\CA'){ \
  Get-ChildItem $s -ErrorAction SilentlyContinue | ForEach-Object { \
    [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----'); \
    [void]$sb.AppendLine([Convert]::ToBase64String($_.RawData,'InsertLineBreaks')); \
    [void]$sb.AppendLine('-----END CERTIFICATE-----') } }; \
[IO.File]::WriteAllText('__OUT__', $sb.ToString())";
    let script = template.replace("__OUT__", &out.to_string_lossy().replace('\'', "''"));

    let ok = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    let nonempty = out.metadata().map(|m| m.len() > 0).unwrap_or(false);
    if ok && nonempty {
        log_info(&format!("exported OS trust store for Node/Python TLS -> {}", out.display()));
        Some(out.to_string_lossy().into_owned())
    } else {
        log_info("could not export the OS trust store; downloads behind an HTTPS-inspecting proxy/AV may fail with a certificate error.");
        None
    }
}

#[cfg(not(windows))]
fn export_system_ca_bundle() -> Option<String> {
    // macOS/Linux: Node, Python, and uv resolve the platform trust store well
    // enough for our downloads without an explicit export, so there's nothing to do.
    None
}

// ===========================================================================
// Logging — see logging.rs for why a packaged build needs a file sink at all
// ===========================================================================

/// The shell's own append-only log (`<config>/logs/shell.log`), opened once.
/// `None` when the config dir is not writable; logging then degrades to the
/// `println!` that a windowed release build has nobody to read.
fn shell_log() -> &'static Mutex<Option<LogSink>> {
    static SHELL_LOG: OnceLock<Mutex<Option<LogSink>>> = OnceLock::new();
    SHELL_LOG.get_or_init(|| {
        Mutex::new(crate::logging::log_dir().and_then(|dir| LogSink::open(&dir, "shell")))
    })
}

/// Open the per-service log sink for a spawned backend process.
fn worker_log_sink(name: &str) -> Option<std::sync::Arc<Mutex<LogSink>>> {
    let dir = crate::logging::log_dir()?;
    LogSink::open(&dir, name).map(|s| std::sync::Arc::new(Mutex::new(s)))
}

/// Pump a one-dir worker's piped stdout/stderr into its log file.
///
/// One thread per stream, each owning the pipe end: a blocking line reader is
/// the simplest thing that cannot deadlock the child (the pipe is always being
/// drained) and it costs two idle threads per worker.
fn pipe_child_output_to_log(child: &mut Child, sink: std::sync::Arc<Mutex<LogSink>>) {
    if let Some(out) = child.stdout.take() {
        spawn_line_pump(out, sink.clone(), "out");
    }
    if let Some(err) = child.stderr.take() {
        spawn_line_pump(err, sink, "err");
    }
}

/// Largest chunk written as a single log line.
///
/// A pump that only ever returns on a `\n` is a memory leak waiting for a
/// progress bar: `tqdm`, `huggingface_hub` and llama.cpp's loader all redraw
/// with a bare `\r` and can run for minutes without ever emitting a newline.
/// Capping each read flushes such output in slices instead of buffering the
/// whole run.
const MAX_LOG_LINE_BYTES: u64 = 16 * 1024;

fn spawn_line_pump<R: std::io::Read + Send + 'static>(
    reader: R,
    sink: std::sync::Arc<Mutex<LogSink>>,
    stream: &'static str,
) {
    // `by_ref` (used with `take` below) is a provided method on `Read`.
    use std::io::Read as _;
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            // BYTES, not `BufRead::lines()`. `lines()` yields
            // `Err(InvalidData)` for a line that is not valid UTF-8, and
            // stopping the pump there would leave the pipe undrained — which
            // BLOCKS the worker for good once the ~64 KB pipe buffer fills, a
            // strictly worse failure than the `Stdio::null()` this replaced.
            // The workers load native libraries (llama.cpp, whisper.cpp,
            // torch) that print raw bytes, so that is a matter of when, not
            // if. Lossy decoding keeps the pump alive on any byte sequence.
            match reader
                .by_ref()
                .take(MAX_LOG_LINE_BYTES)
                .read_until(b'\n', &mut buf)
            {
                // EOF: the child closed the pipe (or exited).
                Ok(0) => break,
                Ok(_) => {}
                // A real I/O error on the pipe: there is nothing left to drain.
                Err(_) => break,
            }
            let line = String::from_utf8_lossy(&buf);
            if let Ok(mut sink) = sink.lock() {
                sink.write_line(&format!("[{stream}] {line}"));
            }
        }
    });
}

/// Drain a shell-plugin sidecar's `CommandEvent` stream into its log file.
///
/// Also records the exit status, which is the one line that actually answers
/// "why is the backend unavailable?" — a missing DLL, a port already in use, or
/// an antivirus quarantine all show up here and nowhere else.
fn pipe_command_events_to_log(
    name: &str,
    mut rx: tauri::async_runtime::Receiver<tauri_plugin_shell::process::CommandEvent>,
) {
    use tauri_plugin_shell::process::CommandEvent;
    let Some(sink) = worker_log_sink(name) else {
        return;
    };
    let name = name.to_string();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let line = match event {
                CommandEvent::Stdout(bytes) => {
                    format!("[out] {}", String::from_utf8_lossy(&bytes))
                }
                CommandEvent::Stderr(bytes) => {
                    format!("[err] {}", String::from_utf8_lossy(&bytes))
                }
                CommandEvent::Error(e) => format!("[shell] error: {e}"),
                CommandEvent::Terminated(payload) => format!(
                    "[shell] '{name}' terminated (code={:?}, signal={:?})",
                    payload.code, payload.signal
                ),
                _ => continue,
            };
            if let Ok(mut sink) = sink.lock() {
                sink.write_line(&line);
            }
        }
    });
}

/// Log a shell-level event.
///
/// Goes to BOTH stdout (visible under `tauri dev`) and `<config>/logs/shell.log`.
/// The file half is the load-bearing one: `main.rs` sets
/// `windows_subsystem = "windows"` in release, so a packaged build has no
/// console and every one of these lines used to vanish — including the ones
/// that say a sidecar could not be resolved or failed to launch.
fn log_info(msg: &str) {
    println!("[videodubber:services] {msg}");
    if let Ok(mut guard) = shell_log().lock() {
        if let Some(sink) = guard.as_mut() {
            sink.write_line(msg);
        }
    }
}
