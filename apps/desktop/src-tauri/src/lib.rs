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
mod logging;
mod orchestrator_client;
mod sidecar;

use std::time::Duration;

use tauri::{AppHandle, Manager}; // for app.manage / state in setup

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
        // single-instance MUST be registered first (Tauri's own guidance): it
        // has to claim the lock before anything else in the second process
        // starts doing work.
        //
        // WHY IT MATTERS HERE, beyond tidiness: this app owns four fixed
        // loopback ports. A second copy finds them taken, fails to boot its own
        // backend — and then, when the user closes that useless second window,
        // its `RunEvent::Exit` runs `sweep_service_ports()`, which kills the
        // FIRST instance's orchestrator and workers out from under a running
        // dub. Double-clicking the icon twice was enough to do it.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Bring the window the user already has to the front instead.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
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
            // backend recovery (offered when the sidecar never came up)
            commands::restart_app,
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
    // Never auto-install an update this OS cannot launch — the background path
    // is the dangerous one, since the user isn't watching (see
    // commands::unsupported_host_reason).
    if let Some(reason) = commands::unsupported_host_reason() {
        println!("[videodubber:update] skipping auto-update: {reason}");
        return;
    }

    // Never start an unattended update on top of a running dub. Checked again
    // after the download, immediately before the install — see below.
    if let Some(reason) = commands::busy_with_a_run_reason().await {
        println!("[videodubber:update] skipping auto-update: {reason}.");
        return;
    }

    // Same builder as the manual path: the pre-install teardown must run here
    // too, or a background Windows update hits locked sidecar files.
    let updater = match crate::commands::updater_with_teardown(&app) {
        Ok(u) => u,
        Err(e) => {
            println!("[videodubber:update] updater unavailable (likely dev build): {e}");
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            println!(
                "[videodubber:update] update {} available; downloading…",
                update.version
            );
            // DOWNLOAD and INSTALL are deliberately split rather than using
            // `download_and_install`. Installing tears the backend down
            // (`updater_with_teardown`'s `on_before_exit`) and relaunches, and
            // the payload here is large enough that the download takes minutes
            // — long enough for the user to have started a dub since the check.
            // Splitting gives us a second idleness check at the only moment that
            // matters: after the bytes are on disk, immediately before the
            // install. If they are busy we simply drop the download and try
            // again on the next launch.
            let bytes = match update.download(|_chunk, _total| {}, || {}).await {
                Ok(bytes) => bytes,
                Err(e) => {
                    println!("[videodubber:update] auto-download failed: {e}");
                    return;
                }
            };
            if let Some(reason) = commands::busy_with_a_run_reason().await {
                println!("[videodubber:update] deferring install to the next launch — {reason}.");
                return;
            }
            // On success `restart()` diverges so nothing below runs; on failure
            // we just log and leave the running app untouched.
            match update.install(bytes) {
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

/// Config invariants that are easy to regress and impossible to notice.
///
/// `tauri.conf.json` is JSON, so it cannot carry the comments the rest of this
/// codebase uses to explain WHY a setting is what it is. These tests are where
/// that reasoning lives — and, like `commands::update_gate_tests`, they fail the
/// build rather than letting a silent drift ship. (Precedent: the macOS floor
/// gate, added after the updater offered a build the host could not launch.)
#[cfg(test)]
mod config_tests {
    fn config() -> serde_json::Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses")
    }

    fn csp() -> String {
        config()["app"]["security"]["csp"]
            .as_str()
            .expect("app.security.csp must be declared")
            .to_string()
    }

    /// `base-uri` and `form-action` have NO `default-src` fallback in the CSP
    /// spec, so omitting them left a `<base>` injection able to repoint every
    /// relative URL in the app. `object-src` does fall back, but stating it
    /// costs nothing and survives a future `default-src` change.
    #[test]
    fn csp_declares_the_directives_default_src_does_not_cover() {
        let csp = csp();
        for directive in ["base-uri 'none'", "form-action 'none'", "object-src 'none'"] {
            assert!(csp.contains(directive), "CSP is missing `{directive}`");
        }
    }

    /// Every `<video>`/`<audio>` preview in the app is an ELEMENT src pointing
    /// at the orchestrator's `/file?path=` route (editor.component.ts
    /// `previewUrl`, export.component.ts) — and an element src is governed by
    /// `media-src`, which does NOT fall back to `connect-src`. `media-src` was
    /// `'self' blob: asset: http://asset.localhost` and never named the
    /// orchestrator, so in the PACKAGED app (origin `tauri://localhost`) every
    /// preview was blocked and the editor fell back to its "preview
    /// unavailable" badge. Invisible in `pnpm dev`, where the page is served by
    /// the Angular dev server and Tauri injects no CSP at all.
    #[test]
    fn csp_lets_the_webview_play_media_served_by_the_orchestrator() {
        let csp = csp();
        let media = csp
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("media-src"))
            .expect("media-src must be declared");
        for origin in ["http://127.0.0.1:5100", "http://localhost:5100"] {
            assert!(media.contains(origin), "media-src is missing `{origin}`");
        }
    }

    /// The webview talks ONLY to the four loopback services and Tauri's own IPC.
    /// It carried grants for `https://github.com` and `*.githubusercontent.com`
    /// that nothing used — release links open in the native browser via
    /// `open_external`, and the updater fetches from Rust, outside the CSP — so
    /// they bought nothing and gave a future XSS somewhere to exfiltrate to.
    #[test]
    fn csp_grants_no_remote_origins() {
        let csp = csp();
        assert!(
            !csp.contains("githubusercontent"),
            "dead GitHub grant is back"
        );
        assert!(
            !csp.contains("https://github.com"),
            "dead GitHub grant is back"
        );
        // The asset protocol is not enabled (`app.security.assetProtocol` is
        // unset) and previews go through the orchestrator's /file route, so the
        // `asset:` grants were dead too.
        assert!(
            !csp.contains("asset:"),
            "asset: grant without assetProtocol"
        );
        assert!(
            !csp.contains("https://"),
            "the webview should reach nothing off this machine: {csp}"
        );
    }

    /// The WebView2 install step must be a deliberate choice, not the default.
    ///
    /// Tauri's default is `downloadBootstrapper`: the installer downloads the
    /// bootstrapper AND then the runtime. `embedBootstrapper` (what we ship)
    /// carries the ~1.8 MB bootstrapper in the installer, so it survives a
    /// blocked bootstrapper URL — but BE CLEAR THAT IT IS NOT AN OFFLINE
    /// INSTALL: it still fetches the runtime from Microsoft's CDN, and on a
    /// machine with no WebView2 and no internet the install still fails. The
    /// only fully offline modes are `offlineInstaller` (+127 MB) and
    /// `fixedRuntime` (+180 MB), both of which are an installer-size decision
    /// rather than a code one (docs/WINDOWS.md §6 still says WebView2 is
    /// preinstalled on Windows 10/11, which is the assumption in force).
    ///
    /// This test therefore pins "not the default", which is the part that can
    /// silently regress — not a claim about offline capability.
    #[test]
    fn windows_installer_does_not_rely_on_the_default_download_bootstrapper() {
        let cfg = config();
        let mode = cfg["bundle"]["windows"]["webviewInstallMode"]["type"]
            .as_str()
            .expect("bundle.windows.webviewInstallMode.type must be declared");
        assert_ne!(mode, "downloadBootstrapper");
        // `skip` would leave a machine without WebView2 with an app that opens
        // a blank window and no explanation — never an acceptable default here.
        assert_ne!(mode, "skip");
        // The install location is a deliberate choice given the multi-GB
        // payload, not whatever the NSIS default happens to be.
        assert!(cfg["bundle"]["windows"]["nsis"]["installMode"].is_string());
    }
}
