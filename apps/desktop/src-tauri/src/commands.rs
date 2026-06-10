//! Tauri command handlers.
//!
//! Every command here maps 1:1 to the orchestrator REST API (see the project
//! brief, "ORCHESTRATOR HTTP API") or provides a native capability that the
//! webview cannot do on its own (file dialog, open-in-OS).
//!
//! Conventions:
//!   * All commands are `async` and return `Result<serde_json::Value, String>`.
//!     The `Err(String)` is a JSON-encoded `AppError` (see `orchestrator_client`).
//!   * Proxy commands accept their request body as a flexible `serde_json::Value`
//!     so the Rust shell does not have to re-declare every `@videodubber/shared`
//!     interface; the orchestrator is the source of truth for validation.
//!   * IMPORTANT: progress (SSE) is consumed by the webview directly from
//!     `ORCHESTRATOR_URL/projects/:id/events` — it is intentionally NOT proxied
//!     through Rust. See the brief: "do NOT forward SSE through Rust".

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
// Self-update plumbing:
//   * `UpdaterExt` adds `app.updater()` -> a `Updater` whose `.check().await`
//     returns `Result<Option<Update>, Error>` (Some when a newer version is on
//     the endpoint). `Update` carries `.version`, `.current_version`, `.body`
//     (release notes), `.date`, and `.download_and_install(on_chunk, on_done)`.
//   * `tauri_plugin_process` exposes `app.restart()` (via `ProcessExt`-less free
//     fn on AppHandle once the plugin is initialised) to relaunch after install.
use tauri_plugin_updater::UpdaterExt;

use crate::orchestrator_client as orch;

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

/// `create_project` -> `POST /projects`.
///
/// `input` is a `CreateProjectInput` (`{ name, inputVideoPath, settings, outputDir? }`).
/// Returns the created `Project`.
#[tauri::command]
pub async fn create_project(input: Value) -> Result<Value, String> {
    orch::post_json("/projects", &input).await
}

/// `list_projects` -> `GET /projects`. Returns `Project[]`.
#[tauri::command]
pub async fn list_projects() -> Result<Value, String> {
    orch::get_json("/projects").await
}

/// `get_project` -> `GET /projects/:id`.
/// Returns `{ project: Project, pipeline: PipelineState }`.
#[tauri::command]
pub async fn get_project(project_id: String) -> Result<Value, String> {
    orch::get_json(&format!("/projects/{}", project_id)).await
}

/// `open_project` is a UI-level alias of `get_project` (the orchestrator has a
/// single GET endpoint). Kept as a distinct command because the Tauri brief
/// lists both; the frontend may treat "open" differently (e.g. push a route).
#[tauri::command]
pub async fn open_project(project_id: String) -> Result<Value, String> {
    orch::get_json(&format!("/projects/{}", project_id)).await
}

// ---------------------------------------------------------------------------
// Media / pipeline control
// ---------------------------------------------------------------------------

/// `probe_video` -> `POST /projects/:id/probe`. Returns `MediaInfo`.
#[tauri::command]
pub async fn probe_video(project_id: String) -> Result<Value, String> {
    orch::post_json(&format!("/projects/{}/probe", project_id), &json!({})).await
}

/// `run_pipeline` -> `POST /projects/:id/run`. Orchestrator runs async and
/// returns `202 { started: true }`; progress is observed over SSE.
#[tauri::command]
pub async fn run_pipeline(project_id: String) -> Result<Value, String> {
    orch::post_json(&format!("/projects/{}/run", project_id), &json!({})).await
}

/// `cancel_pipeline` -> `POST /projects/:id/cancel`. Returns `{ ok: true }`.
#[tauri::command]
pub async fn cancel_pipeline(project_id: String) -> Result<Value, String> {
    orch::post_json(&format!("/projects/{}/cancel", project_id), &json!({})).await
}

/// `retry_pipeline_step` -> `POST /projects/:id/retry` with `{ stepId }`.
/// Resets that step + everything downstream and reruns from there (202).
#[tauri::command]
pub async fn retry_pipeline_step(project_id: String, step_id: String) -> Result<Value, String> {
    orch::post_json(
        &format!("/projects/{}/retry", project_id),
        &json!({ "stepId": step_id }),
    )
    .await
}

// ---------------------------------------------------------------------------
// Segments (transcript / translation editing)
// ---------------------------------------------------------------------------

/// `save_translated_segments` -> `PUT /projects/:id/segments`.
///
/// `segments` is `[{ id, translatedText }]`. Returns `{ ok: true }`.
#[tauri::command]
pub async fn save_translated_segments(
    project_id: String,
    segments: Value,
) -> Result<Value, String> {
    orch::put_json(
        &format!("/projects/{}/segments", project_id),
        &json!({ "segments": segments }),
    )
    .await
}

/// `synthesize_single_segment` -> `POST /projects/:id/segments/:segId/tts`.
///
/// Body `{ text?, voiceId?, speed? }`. Returns `{ segment: TtsSegment, alignment: AlignedSegment }`.
/// `options` is forwarded verbatim so the UI can send any subset of the fields.
#[tauri::command]
pub async fn synthesize_single_segment(
    project_id: String,
    segment_id: String,
    options: Option<Value>,
) -> Result<Value, String> {
    let body = options.unwrap_or_else(|| json!({}));
    orch::post_json(
        &format!("/projects/{}/segments/{}/tts", project_id, segment_id),
        &body,
    )
    .await
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/// `render_final_video` -> `POST /projects/:id/render`.
///
/// Body `{ subtitleExportMode?, burnSubtitleStyle? }`. Returns `RenderFinalVideoResult`.
/// `options` is forwarded verbatim (may be omitted to use project settings).
#[tauri::command]
pub async fn render_final_video(
    project_id: String,
    options: Option<Value>,
) -> Result<Value, String> {
    let body = options.unwrap_or_else(|| json!({}));
    orch::post_json(&format!("/projects/{}/render", project_id), &body).await
}

// ---------------------------------------------------------------------------
// Native: open path / output folder
// ---------------------------------------------------------------------------

/// `open_output_folder` opens the given filesystem path with the OS default
/// handler via the opener plugin (Finder/Explorer/file manager for a folder).
///
/// Unlike the dev-mode orchestrator `POST /open` (which shells out to
/// `open`/`xdg-open`), inside the packaged app we use the native opener plugin
/// so it works without a shell and respects the capability ACL.
#[tauri::command]
pub async fn open_output_folder(app: AppHandle, path: String) -> Result<Value, String> {
    // `open_path(path, with)` — `with: None` uses the system default app.
    app.opener()
        .open_path(path.clone(), None::<&str>)
        .map_err(|e| {
            app_error_json(
                "UNKNOWN",
                &format!("failed to open path '{path}': {e}"),
                Some("Verify the path exists and the app has permission to open it."),
            )
        })?;
    Ok(json!({ "ok": true }))
}

/// `open_path` — generic native open for an arbitrary file/folder/URL.
/// Mirrors `open_output_folder` but is the explicitly-listed native helper.
#[tauri::command]
pub async fn open_path(app: AppHandle, path: String) -> Result<Value, String> {
    app.opener()
        .open_path(path.clone(), None::<&str>)
        .map_err(|e| {
            app_error_json("UNKNOWN", &format!("failed to open path '{path}': {e}"), None)
        })?;
    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// Native: file picker
// ---------------------------------------------------------------------------

/// `pick_video_file` opens a native open-file dialog filtered to common video
/// containers and returns `{ path: string | null }` (null if the user cancels).
///
/// Tauri 2's dialog plugin is callback-based; we bridge it to async with a
/// oneshot channel so the command can `await` the user's choice.
#[tauri::command]
pub async fn pick_video_file(app: AppHandle) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();

    app.dialog()
        .file()
        .set_title("Select a video to dub")
        .add_filter(
            "Video",
            &["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "flv", "mpg", "mpeg", "ts"],
        )
        .add_filter("All files", &["*"])
        // `pick_file` invokes the closure on the dialog thread with the picked
        // path (or None on cancel). `FilePath` -> string via its Display impl.
        .pick_file(move |maybe_path| {
            let as_string = maybe_path.map(|p| p.to_string());
            // Receiver may have been dropped if the command future was cancelled;
            // ignore the send error in that case.
            let _ = tx.send(as_string);
        });

    let picked = rx.await.map_err(|e| {
        app_error_json(
            "UNKNOWN",
            &format!("file dialog channel closed before a selection was made: {e}"),
            None,
        )
    })?;

    Ok(json!({ "path": picked }))
}

// ---------------------------------------------------------------------------
// Workers / languages (handy proxies the UI uses on startup)
// ---------------------------------------------------------------------------

/// `get_workers_health` -> `GET /workers/health`.
/// Returns `{ stt, translation, tts, ffmpeg, ffprobe : { available, detail? } }`.
/// Name must match the IPC service's `invoke('get_workers_health')`.
#[tauri::command]
pub async fn get_workers_health() -> Result<Value, String> {
    orch::get_json("/workers/health").await
}

/// `get_languages` -> `GET /languages`.
/// Returns the orchestrator's curated + worker-reported language list.
/// Name must match the IPC service's `invoke('get_languages')`.
#[tauri::command]
pub async fn get_languages() -> Result<Value, String> {
    orch::get_json("/languages").await
}

/// `get_segments` -> `GET /projects/:id/segments`. Returns `TranscriptSegment[]`
/// merged with alignment status when present.
#[tauri::command]
pub async fn get_segments(project_id: String) -> Result<Value, String> {
    orch::get_json(&format!("/projects/{}/segments", project_id)).await
}

// ---------------------------------------------------------------------------
// First-run setup / model download (proxies to the orchestrator /setup API).
//
// These back the onboarding wizard. They are thin proxies — the orchestrator
// owns the config dir (~/VideoDubber), the catalog, and the install state
// machine; download progress is streamed to the webview directly over SSE
// (GET /setup/events), NOT through Rust (same rule as /projects/:id/events).
// ---------------------------------------------------------------------------

/// `setup_get_status` -> `GET /setup/status`. Returns `SetupStatus`
/// (`{ firstRunComplete, installed }`). The shell/UI calls this on boot to
/// decide whether to show the onboarding wizard or Home.
#[tauri::command]
pub async fn setup_get_status() -> Result<Value, String> {
    orch::get_json("/setup/status").await
}

/// `setup_preflight` -> `GET /setup/preflight`. Returns `PreflightResult`
/// (`{ ok, checks: PreflightCheck[] }`) — ffmpeg/ffprobe + the 3 workers
/// reachable, network reachability, free disk space in the models dir.
#[tauri::command]
pub async fn setup_preflight() -> Result<Value, String> {
    orch::get_json("/setup/preflight").await
}

/// `setup_get_catalog` -> `GET /setup/catalog`. Returns `SetupCatalog`
/// (curated whisper models, languages, argos pairs, piper voices).
#[tauri::command]
pub async fn setup_get_catalog() -> Result<Value, String> {
    orch::get_json("/setup/catalog").await
}

/// `setup_install_models` -> `POST /setup/install` with a `SetupInstallRequest`
/// (`{ whisperModel?, argosPairs?, piperVoices? }`). Orchestrator returns
/// `202 { started: true }` and runs the download async; progress is observed by
/// the webview over the `/setup/events` SSE channel. `options` is forwarded
/// verbatim so the UI can send any subset of the fields.
#[tauri::command]
pub async fn setup_install_models(options: Option<Value>) -> Result<Value, String> {
    let body = options.unwrap_or_else(|| json!({}));
    orch::post_json("/setup/install", &body).await
}

/// `setup_complete` -> `POST /setup/complete`. Marks `firstRunComplete=true` in
/// `~/VideoDubber/setup.json`. Returns `{ ok: true }`.
#[tauri::command]
pub async fn setup_complete() -> Result<Value, String> {
    orch::post_json("/setup/complete", &json!({})).await
}

// ---------------------------------------------------------------------------
// Update preferences (proxies to the orchestrator /preferences API).
//
// The orchestrator's `preferences.json` is the SOURCE OF TRUTH for the UI. The
// shell reads `autoUpdate` on startup (see lib.rs) to decide whether to run a
// background update check.
// ---------------------------------------------------------------------------

/// `get_preferences` -> `GET /preferences`. Returns `UpdatePreferences`
/// (`{ autoUpdate }`).
#[tauri::command]
pub async fn get_preferences() -> Result<Value, String> {
    orch::get_json("/preferences").await
}

/// `set_preferences` -> `PUT /preferences` with `UpdatePreferences`. Persists
/// `preferences.json`. Returns `{ ok: true }`.
#[tauri::command]
pub async fn set_preferences(prefs: Value) -> Result<Value, String> {
    orch::put_json("/preferences", &prefs).await
}

/// `get_update_preference` is the updater-screen alias of `get_preferences`
/// (the brief lists both). Returns `UpdatePreferences`.
#[tauri::command]
pub async fn get_update_preference() -> Result<Value, String> {
    orch::get_json("/preferences").await
}

/// `set_update_preference` -> `PUT /preferences`. Accepts the full
/// `UpdatePreferences` body (`{ autoUpdate }`) so the Updates screen can flip
/// the toggle. Returns `{ ok: true }`.
#[tauri::command]
pub async fn set_update_preference(prefs: Value) -> Result<Value, String> {
    orch::put_json("/preferences", &prefs).await
}

// ---------------------------------------------------------------------------
// Native: open an external URL in the default browser (release notes, etc.)
// ---------------------------------------------------------------------------

/// `open_external` opens an http(s) URL with the OS default browser via the
/// opener plugin. Used by the Updates screen to show release notes / GitHub.
#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<Value, String> {
    // `open_url(url, with)` — `with: None` uses the system default browser.
    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|e| {
            app_error_json(
                "UNKNOWN",
                &format!("failed to open URL '{url}': {e}"),
                Some("Verify the URL is a valid http(s) link."),
            )
        })?;
    Ok(json!({ "ok": true }))
}

/// `get_app_version` -> the installed app version from the bundle metadata.
/// Network-free (unlike check_for_update), so the Settings page can always show
/// the current version even when the updater endpoint is unreachable.
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> Result<Value, String> {
    Ok(json!({ "version": app.package_info().version.to_string() }))
}

// ---------------------------------------------------------------------------
// Auto-update (tauri-plugin-updater + tauri-plugin-process).
//
// The updater runs entirely in Rust: it fetches the signed `latest.json`
// manifest from the GitHub Releases endpoint (tauri.conf.json plugins.updater),
// verifies the signature against the embedded pubkey, and downloads/installs the
// platform artifact. The webview only sees the resulting `UpdateInfo` /
// progress, never the network call.
// ---------------------------------------------------------------------------

/// `check_for_update` -> queries the updater endpoint and returns an
/// `UpdateInfo` (`{ available, version?, currentVersion, notes?, date? }`).
///
/// API shape (tauri-plugin-updater 2.x):
///   `app.updater()? -> Updater`
///   `updater.check().await? -> Option<Update>`
///   `Update { version: String, current_version: String, body: Option<String>,
///             date: Option<OffsetDateTime>, .. }`
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Value, String> {
    // Current installed version is always knowable from the package config.
    let current_version = app.package_info().version.to_string();

    let updater = app.updater().map_err(|e| {
        app_error_json(
            "UNKNOWN",
            &format!("updater is not configured: {e}"),
            Some("Ensure plugins.updater (endpoints + pubkey) is set in tauri.conf.json and the app is a release bundle."),
        )
    })?;

    match updater.check().await {
        Ok(Some(update)) => Ok(json!({
            "available": true,
            "version": update.version,
            "currentVersion": current_version,
            // `body` is the release notes from latest.json; `date` is an
            // OffsetDateTime — stringify to ISO-ish for the UI.
            "notes": update.body,
            "date": update.date.map(|d| d.to_string()),
        })),
        Ok(None) => Ok(json!({
            "available": false,
            "currentVersion": current_version,
        })),
        Err(e) => Err(app_error_json(
            "UNKNOWN",
            &format!("failed to check for updates: {e}"),
            Some("Check your internet connection and that the updater endpoint is reachable."),
        )),
    }
}

/// `download_and_install_update` -> downloads + installs the pending update,
/// then relaunches the app.
///
/// API shape:
///   `Update::download_and_install(on_chunk: Fn(usize, Option<u64>),
///                                 on_download_finished: Fn()) -> Result<()>`
///   then `app.restart()` (provided by tauri-plugin-process; this fn diverges /
///   never returns on success).
///
/// We don't stream chunk progress to the webview here (the closures just total
/// the bytes for logging); the UI shows an indeterminate "installing…" state.
#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<Value, String> {
    let updater = app.updater().map_err(|e| {
        app_error_json("UNKNOWN", &format!("updater is not configured: {e}"), None)
    })?;

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            return Err(app_error_json(
                "UNKNOWN",
                "no update is available to install",
                Some("Run check_for_update first; install only when `available` is true."),
            ))
        }
        Err(e) => {
            return Err(app_error_json(
                "UNKNOWN",
                &format!("failed to re-check for the update: {e}"),
                None,
            ))
        }
    };

    // Download + install. The two callbacks are:
    //   - on_chunk(chunk_len, content_length)  — bound `Fn`, so we use an
    //     atomic running total instead of a captured `&mut` (an FnMut closure
    //     would NOT satisfy the `Fn` bound).
    //   - on_download_finished()               — bound `FnOnce`.
    let downloaded = std::sync::atomic::AtomicUsize::new(0);
    update
        .download_and_install(
            move |chunk_len, _content_length| {
                let total = downloaded
                    .fetch_add(chunk_len, std::sync::atomic::Ordering::Relaxed)
                    + chunk_len;
                // Lightweight stdout trace; the UI shows an indeterminate state.
                println!("[videodubber:update] downloaded {total} bytes");
            },
            || {
                println!("[videodubber:update] download complete, installing…");
            },
        )
        .await
        .map_err(|e| {
            app_error_json(
                "UNKNOWN",
                &format!("failed to download/install the update: {e}"),
                Some("The update could not be applied. Try again, or download the latest installer manually."),
            )
        })?;

    // Relaunch into the freshly-installed version. `AppHandle::restart()`
    // terminates the current process and returns `!` (never), which coerces to
    // this fn's `Result<Value, String>` return type. Nothing after it runs.
    app.restart()
}

// ---------------------------------------------------------------------------
// Local error helper (duplicated tiny shape so commands.rs has no dep on the
// private fn in orchestrator_client). Keep in sync with that module's format.
// ---------------------------------------------------------------------------

/// Builds a JSON-encoded `AppError` string for native-command failures.
fn app_error_json(code: &str, message: &str, remediation: Option<&str>) -> String {
    let mut err = json!({ "code": code, "message": message });
    if let Some(r) = remediation {
        err["remediation"] = json!(r);
    }
    serde_json::to_string(&err)
        .unwrap_or_else(|_| format!("{{\"code\":\"UNKNOWN\",\"message\":\"{message}\"}}"))
}
