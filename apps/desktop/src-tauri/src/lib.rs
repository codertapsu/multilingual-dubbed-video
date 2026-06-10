//! VideoDubber desktop shell — Tauri 2 application wiring.
//!
//! This crate is the desktop shell. Its responsibilities are intentionally thin:
//!   1. Expose native commands (file dialog, open-path, open-external) the
//!      webview can't do.
//!   2. Proxy the rest of the commands to the Node orchestrator over HTTP
//!      (project lifecycle, pipeline, first-run /setup, /preferences).
//!   3. Spawn the orchestrator + Python workers as sidecars (dev: launcher
//!      script; prod: bundled externalBin via the shell plugin — see sidecar.rs).
//!   4. Self-update from GitHub Releases (tauri-plugin-updater + process
//!      restart): manual via commands, or a background check at launch when the
//!      user has `autoUpdate` enabled.
//!
//! All pipeline logic lives in `@videodubber/node-orchestrator`; progress is
//! streamed to the webview directly via SSE (`/projects/:id/events`,
//! `/setup/events`) and is NOT routed through Rust.

mod commands;
mod orchestrator_client;
mod sidecar;

use std::time::Duration;

use tauri::{AppHandle, Manager}; // for app.manage / state in setup
use tauri_plugin_updater::UpdaterExt;

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
        //           (commands::open_path / open_output_folder / open_external).
        .plugin(tauri_plugin_opener::init())
        // updater -> self-update from GitHub Releases (commands::check_for_update
        //            / download_and_install_update). Reads the endpoint + pubkey
        //            from tauri.conf.json plugins.updater.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // process -> relaunch after an update is installed (app.restart()).
        .plugin(tauri_plugin_process::init())
        // shell  -> spawn the bundled externalBin sidecars in production
        //           (sidecar.rs: app.shell().sidecar("…")). Dev path still uses
        //           std::process to launch scripts/start-services.sh.
        .plugin(tauri_plugin_shell::init())
        // --- Managed state ---------------------------------------------
        // Holds any spawned sidecar children so they can be killed on exit.
        .manage(SidecarManager::default())
        // --- Setup ------------------------------------------------------
        .setup(|app| {
            // Auto-start the backend (orchestrator + workers) when the app opens.
            // ON by default; disable with VIDEODUBBER_MANAGE_SERVICES=0. Never
            // fails startup — the UI reports availability via GET /workers/health.
            if let Err(e) = sidecar::maybe_spawn_services(&app.handle()) {
                eprintln!("[videodubber] service start warning: {e}");
            }

            // Background auto-update check (non-blocking). If the user has
            // `autoUpdate` enabled (orchestrator /preferences is the source of
            // truth), check the GitHub Releases endpoint shortly after launch
            // and, when an update is available, download + install it and
            // relaunch. The window never waits on any of this.
            //
            // We wait a few seconds first so the orchestrator sidecar has time to
            // come up and answer GET /preferences; if it isn't reachable we just
            // skip the check (the user can still update manually from Settings).
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                maybe_auto_update(app_handle).await;
            });

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
            commands::open_external,
            commands::pick_video_file,
            // convenience proxies
            commands::get_workers_health,
            commands::get_languages,
            // first-run setup / onboarding (proxy to /setup)
            commands::setup_get_status,
            commands::setup_preflight,
            commands::setup_get_catalog,
            commands::setup_install_models,
            commands::setup_complete,
            // preferences (proxy to /preferences)
            commands::get_preferences,
            commands::set_preferences,
            commands::get_update_preference,
            commands::set_update_preference,
            // auto-update (tauri-plugin-updater + process restart)
            commands::get_app_version,
            commands::check_for_update,
            commands::download_and_install_update,
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

/// Background, best-effort auto-update at launch.
///
/// Honours the user's `autoUpdate` preference (read from the orchestrator's
/// `/preferences`, the UI's source of truth). When enabled and a newer release
/// is published, this downloads + installs it and relaunches. Every failure is
/// swallowed (logged only) — auto-update must never disrupt normal startup, and
/// the user can always update manually from the Settings/Updates screen.
async fn maybe_auto_update(app: AppHandle) {
    // Give the orchestrator sidecar a moment to start answering /preferences.
    // (In dev/source mode the backend may take a few seconds to boot.)
    tokio::time::sleep(Duration::from_secs(5)).await;

    // 1) Is auto-update enabled? Default to OFF if we cannot read the pref, so
    //    we never surprise the user with an unsolicited install.
    let auto_update = match orchestrator_client::get_json("/preferences").await {
        Ok(prefs) => prefs
            .get("autoUpdate")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        Err(_) => {
            // Orchestrator not reachable yet (or no preferences saved). Skip the
            // auto-check; the user can still update manually.
            println!("[videodubber:update] preferences unavailable; skipping auto-update check.");
            return;
        }
    };

    if !auto_update {
        println!("[videodubber:update] autoUpdate is disabled; skipping background check.");
        return;
    }

    // 2) Check the updater endpoint. `app.updater()` only succeeds in a release
    //    bundle with plugins.updater configured; in dev it errors -> we skip.
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            println!("[videodubber:update] updater unavailable (likely dev build): {e}");
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            println!(
                "[videodubber:update] update {} available; downloading + installing…",
                update.version
            );
            // Download + install, then relaunch. On success `restart()` diverges
            // so nothing below runs; on failure we just log and leave the running
            // app untouched.
            match update
                .download_and_install(|_chunk, _total| {}, || {})
                .await
            {
                Ok(()) => {
                    println!("[videodubber:update] installed; relaunching.");
                    app.restart();
                }
                Err(e) => {
                    println!("[videodubber:update] auto-install failed: {e}");
                }
            }
        }
        Ok(None) => println!("[videodubber:update] already up to date."),
        Err(e) => println!("[videodubber:update] update check failed: {e}"),
    }
}
