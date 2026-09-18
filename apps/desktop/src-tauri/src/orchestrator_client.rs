//! HTTP client for the Node orchestrator (default `http://127.0.0.1:5100`).
//!
//! Tauri commands in `commands.rs` are *thin proxies*: they take typed params,
//! forward to the matching orchestrator REST endpoint, and return the JSON
//! response verbatim. All the real pipeline logic lives in the orchestrator —
//! the Rust shell only adds native capabilities (dialogs, opening paths) and a
//! single place to read the base URL / shape errors.
//!
//! ## Error shape
//! Command results are `Result<serde_json::Value, String>`. Tauri serializes the
//! `Err(String)` to the webview as the rejected promise value. To keep the UI's
//! error handling uniform, the `String` is always a JSON-encoded `AppError`
//! (see `@videodubber/shared`): `{ code, message, remediation?, docsRef? }`.
//!
//! Two failure sources are normalized here:
//!   * transport errors (orchestrator down, timeout) -> `WORKER_UNAVAILABLE` /
//!     `WORKER_TIMEOUT`,
//!   * orchestrator-returned error bodies (it already speaks the `AppError`
//!     contract: `{ "error": { code, message, ... } }`) -> passed through.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Default base URL of the Node orchestrator. Overridable via `ORCHESTRATOR_URL`.
const DEFAULT_ORCHESTRATOR_URL: &str = "http://127.0.0.1:5100";

/// Reads the orchestrator base URL from the `ORCHESTRATOR_URL` env var, falling
/// back to the local default. Trailing slashes are trimmed so callers can build
/// paths with a leading `/`.
pub fn base_url() -> String {
    let raw = std::env::var("ORCHESTRATOR_URL")
        .unwrap_or_else(|_| DEFAULT_ORCHESTRATOR_URL.to_string());
    raw.trim_end_matches('/').to_string()
}

/// Builds a full URL by joining the base URL with a path that should start
/// with `/` (e.g. `"/projects"`).
fn url(path: &str) -> String {
    format!("{}{}", base_url(), path)
}

/// Ceiling for an ordinary proxy call.
///
/// Pipeline-adjacent calls (probe, render kick-off) may take a little while; the
/// long-running work itself is async on the orchestrator and observed over SSE,
/// so these proxy calls should still return quickly. 120s is a safe ceiling.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Ceiling for the two proxy calls that genuinely BLOCK on multi-minute work.
///
/// The 120s assumption above is false for exactly two routes, and both of them
/// shipped broken in the packaged app (never in `ng serve`, where the TypeScript
/// path allows 10 minutes — ipc.service.ts's `AbortSignal.timeout`):
///   * `POST /projects` copies the whole source video into the workspace
///     (projectStore.ts `fsp.copyFile`), so importing a multi-GB file — or any
///     file from a USB stick or a network share — threw WORKER_TIMEOUT in the
///     wizard while the copy went on to succeed and silently create a project.
///   * `POST /projects/:id/render` AWAITS `renderFinalVideo` to completion
///     (server.ts) — it is not a kick-off. Re-rendering with burned-in
///     subtitles reported a failed export while FFmpeg ran on to success, and
///     pressing the button again started a SECOND render.
///
/// This is a ceiling against a wedged orchestrator, not a budget: it has to
/// outlast a CPU-only render of a long video.
pub const LONG_OPERATION_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

/// Has the orchestrator ever answered us in this process?
///
/// Drives how patient a connection-refused retry is (see `send_with_boot_wait`).
/// A plain `AtomicBool` rather than per-call state because the question is about
/// the BACKEND, not about any one request.
static BACKEND_SEEN: AtomicBool = AtomicBool::new(false);

/// How long to keep retrying a refused connection before the backend has ever
/// answered — i.e. while the sidecar is still booting.
///
/// Matches the TypeScript path's boot wait (ipc.service.ts `fetchWaitingForBackend`)
/// on purpose. In the PACKAGED app the first calls at launch (`setup_get_status`,
/// `list_projects`, `get_workers_health`) go through `invoke` -> this module,
/// which retried nothing — so the careful 60s cold-start handling in the UI was
/// unreachable in the only build that needs it. A cold Windows first launch, with
/// Defender scanning the ~100 MB orchestrator SEA and the one-dir worker trees,
/// is exactly the case it was written for.
const FIRST_CONTACT_BUDGET: Duration = Duration::from_secs(60);

/// Once the backend has answered, a refused connection means it DIED rather than
/// that it has not started. Retry briefly (it may be restarting) and then report
/// it, so the UI's recovery banner appears instead of the app hanging.
const RECONNECT_BUDGET: Duration = Duration::from_secs(2);

/// First and last steps of the exponential backoff between retries. Starting
/// small keeps a warm launch (the common case) from paying for the patience.
const INITIAL_BACKOFF: Duration = Duration::from_millis(150);
const MAX_BACKOFF: Duration = Duration::from_secs(2);

/// How long to keep retrying a refused connection, given whether the backend has
/// ever answered in this process.
fn retry_budget(backend_seen: bool) -> Duration {
    if backend_seen {
        RECONNECT_BUDGET
    } else {
        FIRST_CONTACT_BUDGET
    }
}

/// Next backoff step, capped.
fn next_backoff(current: Duration) -> Duration {
    (current * 2).min(MAX_BACKOFF)
}

/// Builds a `reqwest` client with a per-operation timeout.
fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        // Talking to localhost only — no proxy.
        .no_proxy()
        .build()
        .map_err(|e| app_error_json("UNKNOWN", &format!("failed to build HTTP client: {e}"), None))
}

/// Produces a JSON-encoded `AppError` string for the `Err` arm of command results.
///
/// Mirrors `@videodubber/shared`'s `AppError`:
/// `{ code, message, remediation?, docsRef? }`.
fn app_error_json(code: &str, message: &str, remediation: Option<&str>) -> String {
    let mut err = json!({
        "code": code,
        "message": message,
    });
    if let Some(r) = remediation {
        err["remediation"] = json!(r);
    }
    // Stringify so it round-trips cleanly through Tauri's `Err(String)`.
    serde_json::to_string(&err).unwrap_or_else(|_| {
        // Extremely unlikely; fall back to a plain message.
        format!("{{\"code\":\"UNKNOWN\",\"message\":\"{message}\"}}")
    })
}

/// Maps a transport-level `reqwest::Error` to an `AppError` JSON string.
fn map_transport_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        app_error_json(
            "WORKER_TIMEOUT",
            &format!("orchestrator request timed out: {e}"),
            Some("The orchestrator did not respond in time. Check that it is running and not overloaded."),
        )
    } else if e.is_connect() {
        app_error_json(
            "WORKER_UNAVAILABLE",
            &format!("could not reach the orchestrator at {}: {e}", base_url()),
            // END-USER wording, matching ipc.service.ts's packaged-app branch.
            // This string is printed verbatim by <vd-error-banner>, and in the
            // packaged app it is the FIRST thing a non-technical user sees when
            // the backend is slow to boot. It used to read "Start the local
            // services with `pnpm dev` (see scripts/dev.sh)" — advice about a
            // directory their install does not contain.
            Some(
                "The built-in backend did not start. Quit and reopen VideoDubber; if it keeps \
                 happening, reinstall the app, and check that no other program is using port 5100 \
                 (some antivirus and VPN tools block local ports).",
            ),
        )
    } else {
        app_error_json("UNKNOWN", &format!("orchestrator request failed: {e}"), None)
    }
}

/// Consumes a `reqwest::Response` and produces either the parsed JSON body or an
/// `AppError` JSON string.
///
/// On non-2xx, the orchestrator is expected to return `{ "error": AppError }`.
/// If it does, the inner `AppError` is re-stringified and returned in `Err`. If
/// the body is missing/not JSON, a synthetic error carrying the status is built.
async fn handle_response(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    // Read the body as text first so we can salvage non-JSON error pages.
    let body = resp
        .text()
        .await
        .map_err(|e| app_error_json("UNKNOWN", &format!("failed to read response body: {e}"), None))?;

    if status.is_success() {
        if body.trim().is_empty() {
            // Some endpoints (e.g. 202 with no body) — represent as empty object.
            return Ok(json!({}));
        }
        return serde_json::from_str::<Value>(&body).map_err(|e| {
            app_error_json(
                "UNKNOWN",
                &format!("orchestrator returned non-JSON success body: {e}"),
                None,
            )
        });
    }

    // Non-2xx. Try to surface the orchestrator's structured AppError.
    if let Ok(parsed) = serde_json::from_str::<Value>(&body) {
        if let Some(err) = parsed.get("error") {
            // Re-stringify the inner AppError object verbatim.
            return Err(serde_json::to_string(err).unwrap_or_else(|_| body.clone()));
        }
    }

    // Fall back to a generic error tagged with the HTTP status.
    Err(app_error_json(
        "UNKNOWN",
        &format!("orchestrator returned HTTP {status}: {body}"),
        None,
    ))
}

/// The HTTP verbs this proxy speaks.
#[derive(Clone, Copy)]
enum Method {
    Get,
    Post,
    Put,
}

/// Send a request, waiting out a backend that is still booting.
///
/// Only CONNECTION-REFUSED failures are retried, which is what makes retrying a
/// POST/PUT safe: a refused connection means the request was never delivered, so
/// there is no side effect to duplicate. A timeout, a TLS error or any response
/// at all (including a 500) is returned on the first attempt.
async fn send_with_boot_wait(
    client: &reqwest::Client,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<reqwest::Response, String> {
    let deadline = Instant::now() + retry_budget(BACKEND_SEEN.load(Ordering::Relaxed));
    let mut backoff = INITIAL_BACKOFF;

    loop {
        let req = match method {
            Method::Get => client.get(url(path)),
            Method::Post => client.post(url(path)),
            Method::Put => client.put(url(path)),
        };
        let req = match body {
            Some(b) => req.json(b),
            None => req,
        };
        match req.send().await {
            Ok(resp) => {
                // First contact: every later call gets the short budget, so a
                // backend that genuinely died reports promptly instead of
                // hanging the UI for a minute.
                BACKEND_SEEN.store(true, Ordering::Relaxed);
                return Ok(resp);
            }
            Err(e) => {
                if !e.is_connect() || Instant::now() + backoff >= deadline {
                    return Err(map_transport_error(e));
                }
                tokio::time::sleep(backoff).await;
                backoff = next_backoff(backoff);
            }
        }
    }
}

/// Shared request path: build a client with `timeout`, send with the boot wait,
/// then normalise the response.
async fn request(
    method: Method,
    path: &str,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let client = client(timeout)?;
    let resp = send_with_boot_wait(&client, method, path, body).await?;
    handle_response(resp).await
}

/// Performs a GET request to `path` and returns the parsed JSON body.
pub async fn get_json(path: &str) -> Result<Value, String> {
    request(Method::Get, path, None, DEFAULT_TIMEOUT).await
}

/// Performs a POST request to `path` with a JSON body and returns the parsed
/// JSON response. Pass `Value::Null` (or `json!({})`) for an empty body.
pub async fn post_json(path: &str, body: &Value) -> Result<Value, String> {
    request(Method::Post, path, Some(body), DEFAULT_TIMEOUT).await
}

/// `post_json` with an explicit timeout, for the routes whose work is genuinely
/// long (see [`LONG_OPERATION_TIMEOUT`]).
pub async fn post_json_with_timeout(
    path: &str,
    body: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    request(Method::Post, path, Some(body), timeout).await
}

/// Performs a PUT request to `path` with a JSON body and returns the parsed
/// JSON response.
pub async fn put_json(path: &str, body: &Value) -> Result<Value, String> {
    request(Method::Put, path, Some(body), DEFAULT_TIMEOUT).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The boot wait is the whole point of this module's retry loop: before
    /// first contact it must be patient enough to cover a cold Windows launch
    /// (Defender scanning the sidecars), and afterwards short enough that a
    /// backend which actually died surfaces the recovery banner promptly
    /// instead of hanging the UI for a minute.
    #[test]
    fn retry_budget_is_patient_only_before_first_contact() {
        assert_eq!(retry_budget(false), FIRST_CONTACT_BUDGET);
        assert_eq!(retry_budget(true), RECONNECT_BUDGET);
        assert!(FIRST_CONTACT_BUDGET >= Duration::from_secs(60));
        assert!(RECONNECT_BUDGET <= Duration::from_secs(5));
    }

    #[test]
    fn backoff_doubles_up_to_the_cap() {
        assert_eq!(next_backoff(INITIAL_BACKOFF), Duration::from_millis(300));
        assert_eq!(next_backoff(Duration::from_millis(1500)), MAX_BACKOFF);
        assert_eq!(next_backoff(MAX_BACKOFF), MAX_BACKOFF);
    }

    /// The two blocking routes must be allowed to outlast a long CPU render;
    /// everything else keeps the tight ceiling that protects the UI.
    #[test]
    fn long_operations_get_a_much_larger_ceiling() {
        assert_eq!(DEFAULT_TIMEOUT, Duration::from_secs(120));
        assert!(LONG_OPERATION_TIMEOUT >= Duration::from_secs(30 * 60));
    }

    #[test]
    fn base_url_trims_trailing_slashes_and_url_joins_cleanly() {
        assert_eq!(url("/projects"), format!("{}/projects", base_url()));
        assert!(!base_url().ends_with('/'));
    }

    /// The remediation the user reads must not send them to a dev checkout —
    /// the packaged app has no `scripts/` directory and no pnpm.
    #[test]
    fn unavailable_remediation_is_written_for_end_users() {
        let err = app_error_json(
            "WORKER_UNAVAILABLE",
            "could not reach the orchestrator",
            Some(
                "The built-in backend did not start. Quit and reopen VideoDubber; if it keeps \
                 happening, reinstall the app, and check that no other program is using port 5100 \
                 (some antivirus and VPN tools block local ports).",
            ),
        );
        assert!(!err.contains("pnpm dev"));
        assert!(err.contains("Quit and reopen VideoDubber"));
    }
}
