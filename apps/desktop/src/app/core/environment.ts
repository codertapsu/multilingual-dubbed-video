/**
 * Runtime environment configuration.
 *
 * The orchestrator URL is the single source of truth for both the HTTP
 * fallback (browser / `ng serve`) and for the SSE event stream (which is
 * always a direct EventSource to the orchestrator, even inside Tauri, per the
 * architecture: SSE is NOT forwarded through Rust).
 *
 * We allow an override via a global injected by the Tauri shell (or a dev
 * bookmarklet) without needing a rebuild:
 *   window.__VIDEODUBBER_ORCHESTRATOR_URL__ = "http://127.0.0.1:5100";
 */
declare global {
  interface Window {
    __VIDEODUBBER_ORCHESTRATOR_URL__?: string;
    // Present (object) when running inside the Tauri webview.
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

const DEFAULT_ORCHESTRATOR_URL = 'http://127.0.0.1:5100';

function resolveOrchestratorUrl(): string {
  if (
    typeof window !== 'undefined' &&
    typeof window.__VIDEODUBBER_ORCHESTRATOR_URL__ === 'string' &&
    window.__VIDEODUBBER_ORCHESTRATOR_URL__.length > 0
  ) {
    return window.__VIDEODUBBER_ORCHESTRATOR_URL__.replace(/\/+$/, '');
  }
  return DEFAULT_ORCHESTRATOR_URL;
}

export const environment = {
  /** Base URL of the node-orchestrator HTTP API (port 5100). */
  orchestratorUrl: resolveOrchestratorUrl(),
} as const;
