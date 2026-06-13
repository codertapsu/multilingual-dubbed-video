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

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager};
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
    /// * Dev launcher: SIGTERM to the process **group** first (so the launcher's
    ///   trap and the workers shut down cleanly), then SIGKILL as a backstop.
    /// * Production sidecars: `CommandChild::kill()` each one.
    ///
    /// Called on app exit (`RunEvent::Exit`).
    pub fn shutdown(&self) {
        // Production sidecars first — each is an independent process.
        let mut had_prod = false;
        if let Ok(mut guard) = self.prod_children.lock() {
            had_prod = !guard.is_empty();
            for child in guard.drain(..) {
                // `kill()` consumes the handle and sends a terminate signal.
                let _ = child.kill();
            }
        }
        // PyInstaller one-file workers run a bootloader that forks a child;
        // killing the tracked bootloader can orphan that child (which still holds
        // the port). Sweep the known service ports to guarantee a clean teardown.
        // Gated on `had_prod` so we never touch a user's separately-run dev stack.
        if had_prod {
            sweep_service_ports();
        }

        // Dev launcher process group(s).
        if let Ok(mut guard) = self.dev_children.lock() {
            for mut child in guard.drain(..) {
                terminate_group(child.id());
                // Backstop on the direct handle in case the group signal missed.
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Entry point called from `lib.rs` during `.setup()`.
///
/// Returns `Ok(())` even on failure so a missing toolchain never blocks the
/// window from opening — the UI reports backend availability via
/// `GET /workers/health`.
pub fn maybe_spawn_services(app: &AppHandle) -> Result<(), String> {
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
        ],
    );

    // --- Translation worker (5102) ----------------------------------------
    spawn_worker(
        app,
        "vd-translation-worker",
        &[
            ("TRANSLATION_WORKER_HOST", LOOPBACK.to_string()),
            ("TRANSLATION_WORKER_PORT", TRANSLATION_PORT.to_string()),
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
    // once and point Node (NODE_EXTRA_CA_CERTS, additive to its roots) and Python
    // (SSL_CERT_FILE / REQUESTS_CA_BUNDLE) at it. Engine-pack workers + uv inherit
    // it via the orchestrator; uv additionally uses UV_NATIVE_TLS. No-op off Windows.
    if let Some(ca) = system_ca_bundle() {
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
        Ok((_rx, child)) => {
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
    if let Some(ca) = system_ca_bundle() {
        cmd.env("SSL_CERT_FILE", ca).env("REQUESTS_CA_BUNDLE", ca);
    }
    for (key, value) in env {
        cmd.env(*key, value);
    }
    // No console window / its own process group (Windows: CREATE_NO_WINDOW |
    // CREATE_NEW_PROCESS_GROUP; unix: setpgid) so we can kill the tree on exit.
    // Null stdio: we don't surface worker logs in the webview, and a valid (null)
    // handle keeps the windowed build's sys.stdout/stderr non-None.
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    configure_process_group(&mut cmd);

    match cmd.spawn() {
        Ok(child) => {
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

/// Resolve the bundled engine-pack worker SOURCE dir — the parent of
/// `vd_tts_engine/` — to hand the orchestrator as VIDEODUBBER_ENGINE_SRC_DIR.
///
/// Bundled via tauri.conf `resources` (staged by scripts/package/stage-engine-src.sh).
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
fn resolve_config_dir() -> PathBuf {
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

/// Terminate the process group led by `pid`.
#[cfg(unix)]
fn terminate_group(pid: u32) {
    // Negative pid targets the whole process group. SIGTERM lets the launcher's
    // trap and the workers exit cleanly; SIGKILL is the backstop.
    let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
    std::thread::sleep(std::time::Duration::from_millis(800));
    let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
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
fn system_ca_bundle() -> Option<&'static str> {
    static BUNDLE: OnceLock<Option<String>> = OnceLock::new();
    BUNDLE.get_or_init(export_system_ca_bundle).as_deref()
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

/// Minimal logging to stdout (visible in `tauri dev` / the app's console).
fn log_info(msg: &str) {
    println!("[videodubber:services] {msg}");
}
