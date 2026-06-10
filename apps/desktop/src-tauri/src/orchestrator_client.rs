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

use std::time::Duration;

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

/// A lazily-built `reqwest` client with a generous timeout.
///
/// Pipeline-adjacent calls (probe, render kick-off) may take a little while; the
/// long-running work itself is async on the orchestrator and observed over SSE,
/// so these proxy calls should still return quickly. 120s is a safe ceiling.
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
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
            Some("Start the local services with `pnpm dev` (see scripts/dev.sh) or verify ORCHESTRATOR_URL."),
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

/// Performs a GET request to `path` and returns the parsed JSON body.
pub async fn get_json(path: &str) -> Result<Value, String> {
    let resp = client()?
        .get(url(path))
        .send()
        .await
        .map_err(map_transport_error)?;
    handle_response(resp).await
}

/// Performs a POST request to `path` with a JSON body and returns the parsed
/// JSON response. Pass `Value::Null` (or `json!({})`) for an empty body.
pub async fn post_json(path: &str, body: &Value) -> Result<Value, String> {
    let resp = client()?
        .post(url(path))
        .json(body)
        .send()
        .await
        .map_err(map_transport_error)?;
    handle_response(resp).await
}

/// Performs a PUT request to `path` with a JSON body and returns the parsed
/// JSON response.
pub async fn put_json(path: &str, body: &Value) -> Result<Value, String> {
    let resp = client()?
        .put(url(path))
        .json(body)
        .send()
        .await
        .map_err(map_transport_error)?;
    handle_response(resp).await
}
