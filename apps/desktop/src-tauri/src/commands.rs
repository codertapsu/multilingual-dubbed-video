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
