//! VideoDubber desktop shell — Tauri 2 application wiring.
//!
//! This crate is the desktop shell. Its responsibilities are intentionally thin:
//!   1. Expose native commands (file dialog, open-path) the webview can't do.
//!   2. Proxy the rest of the commands to the Node orchestrator over HTTP.
//!   3. (future) Spawn the orchestrator + Python workers as sidecars in prod.
//!
//! All pipeline logic lives in `@videodubber/node-orchestrator`; progress is
//! streamed to the webview directly via SSE (`/projects/:id/events`) and is NOT
//! routed through Rust.

mod commands;
mod orchestrator_client;
mod sidecar;

use tauri::Manager; // for app.manage / state in setup

use sidecar::SidecarManager;

/// Builds and runs the Tauri application.
///
/// Called from `main.rs` (desktop) and reused for mobile entrypoints. The
/// `#[cfg_attr(mobile, tauri::mobile_entry_point)]` makes this the mobile entry
/// when targeting iOS/Android.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // --- Plugins ----------------------------------------------------
        // dialog -> native open-file picker (commands::pick_video_file).
        .plugin(tauri_plugin_dialog::init())
        // opener -> open files/folders/URLs with the OS default handler
        //           (commands::open_path / open_output_folder).
        .plugin(tauri_plugin_opener::init())
        // --- Managed state ---------------------------------------------
        // Holds any spawned sidecar children so they can be killed on exit.
        .manage(SidecarManager::default())
        // --- Setup ------------------------------------------------------
        .setup(|app| {
            // Default: no-op (dev services are started via `pnpm dev`).
            // Feature-gated `spawn-sidecars` enables managed spawning.
            if let Err(e) = sidecar::maybe_spawn_services(&app.handle()) {
                // Don't fail startup; the UI reports service availability via
                // GET /workers/health. Just log it.
                eprintln!("[videodubber] sidecar setup warning: {e}");
            }
            Ok(())
        })
        // --- Commands ---------------------------------------------------
        // Every command listed in the brief, plus a few convenience proxies the
        // UI uses on startup (workers_health, list_languages, get_segments).
        .invoke_handler(tauri::generate_handler![
            // project lifecycle
            commands::create_project,
            commands::open_project,
            commands::get_project,
            commands::list_projects,
            // media / pipeline control
            commands::probe_video,
            commands::run_pipeline,
            commands::cancel_pipeline,
            commands::retry_pipeline_step,
            // segments
            commands::save_translated_segments,
            commands::synthesize_single_segment,
            commands::get_segments,
            // render
            commands::render_final_video,
            // native helpers
            commands::open_output_folder,
            commands::open_path,
            commands::pick_video_file,
            // convenience proxies
            commands::get_workers_health,
            commands::get_languages,
        ])
        // --- Run loop ---------------------------------------------------
        // Use `build` + `run` (rather than the shorthand `.run`) so we can hook
        // `RunEvent::ExitRequested`/`Exit` to terminate any spawned sidecars.
        .build(tauri::generate_context!())
        .expect("error while building the VideoDubber Tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Best-effort: stop any managed sidecar children.
                let manager = app_handle.state::<SidecarManager>();
                manager.shutdown();
            }
        });
}
