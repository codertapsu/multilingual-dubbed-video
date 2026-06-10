import { Injectable } from '@angular/core';

import { environment } from '../environment';
import type {
  CreateProjectInput,
  MediaInfo,
  PipelineStepId,
  Project,
  RenderFinalVideoResult,
} from '../models';
import type {
  LanguagesResponse,
  ProjectWithPipeline,
  SegmentWithAlignment,
  RenderFinalVideoBody,
  SaveTranslatedSegmentsBody,
  SynthesizeSingleSegmentBody,
  SynthesizeSingleSegmentResult,
  WorkersHealth,
} from '../models/view-models';
import type {
  CloudCredentialInfo,
  CloudServiceId,
  CredentialTestResult,
  PreflightResult,
  ProvidersResponse,
  SaveCredentialRequest,
  SetupCatalog,
  SetupInstallRequest,
  SetupStatus,
  SystemProfileResponse,
  UpdateInfo,
  UpdatePreferences,
} from '../models/setup';

/** HTTP verbs the fetch fallback understands. */
type HttpMethod = 'GET' | 'POST' | 'PUT';

/**
 * Detect whether we are running inside the Tauri webview. Tauri 2 injects
 * `window.__TAURI_INTERNALS__` (and historically `window.__TAURI__`). We treat
 * either as "in Tauri".
 */
function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    typeof window.__TAURI_INTERNALS__ !== 'undefined' ||
    typeof window.__TAURI__ !== 'undefined'
  );
}

/** Minimal structural type for the lazily-loaded Tauri `invoke` function. */
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * IpcService — the single transport seam for the whole UI.
 *
 * DUAL MODE:
 *  - In Tauri: dynamically import `@tauri-apps/api/core` and call
 *    `invoke(command, args)`. The Rust side proxies to the orchestrator.
 *  - In a plain browser (`ng serve`): call the matching orchestrator REST
 *    endpoint directly with fetch.
 *
 * Every Tauri command has a typed method here. The HTTP fallback maps each
 * command 1:1 to the REST contract documented for the orchestrator.
 *
 * SSE (pipeline events) is intentionally NOT handled here — it is a direct
 * EventSource to the orchestrator from {@link PipelineEventsService}, in both
 * Tauri and browser modes.
 */
@Injectable({ providedIn: 'root' })
export class IpcService {
  private readonly baseUrl = environment.orchestratorUrl;
  private readonly tauri = isTauri();

  /** Lazily-resolved Tauri `invoke` function (only loaded inside Tauri). */
  private invokeFn: InvokeFn | null = null;

  /** True when running inside the desktop shell. Useful for UI affordances. */
  get inTauri(): boolean {
    return this.tauri;
  }

  // ------------------------------------------------------------------ //
  // Public typed command API                                            //
  // ------------------------------------------------------------------ //

  createProject(input: CreateProjectInput): Promise<Project> {
    return this.call<Project>('create_project', { input }, 'POST', '/projects', input);
  }

  /** open_project / get_project both return the { project, pipeline } envelope. */
  openProject(projectId: string): Promise<ProjectWithPipeline> {
    return this.getProject(projectId);
  }

  getProject(projectId: string): Promise<ProjectWithPipeline> {
    return this.call<ProjectWithPipeline>(
      'get_project',
      { projectId },
      'GET',
      `/projects/${encodeURIComponent(projectId)}`,
    );
  }

  listProjects(): Promise<Project[]> {
    return this.call<Project[]>('list_projects', {}, 'GET', '/projects');
  }

  probeVideo(projectId: string): Promise<MediaInfo> {
    return this.call<MediaInfo>(
      'probe_video',
      { projectId },
      'POST',
      `/projects/${encodeURIComponent(projectId)}/probe`,
    );
  }

  /** Starts the pipeline asynchronously (202 from the orchestrator). */
  runPipeline(projectId: string): Promise<{ started: boolean }> {
    return this.call<{ started: boolean }>(
      'run_pipeline',
      { projectId },
      'POST',
      `/projects/${encodeURIComponent(projectId)}/run`,
    );
  }

  cancelPipeline(projectId: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>(
      'cancel_pipeline',
      { projectId },
      'POST',
      `/projects/${encodeURIComponent(projectId)}/cancel`,
    );
  }

  retryPipelineStep(projectId: string, stepId: PipelineStepId): Promise<{ started?: boolean }> {
    return this.call<{ started?: boolean }>(
      'retry_pipeline_step',
      { projectId, stepId },
      'POST',
      `/projects/${encodeURIComponent(projectId)}/retry`,
      { stepId },
    );
  }

  getSegments(projectId: string): Promise<SegmentWithAlignment[]> {
    return this.call<SegmentWithAlignment[]>(
      'get_segments',
      { projectId },
      'GET',
      `/projects/${encodeURIComponent(projectId)}/segments`,
    );
  }

  saveTranslatedSegments(
    projectId: string,
    segments: SaveTranslatedSegmentsBody['segments'],
  ): Promise<{ ok: boolean }> {
    const body: SaveTranslatedSegmentsBody = { segments };
    return this.call<{ ok: boolean }>(
      'save_translated_segments',
      { projectId, segments },
      'PUT',
      `/projects/${encodeURIComponent(projectId)}/segments`,
      body,
    );
  }

  synthesizeSingleSegment(
    projectId: string,
    segmentId: string,
    overrides: SynthesizeSingleSegmentBody = {},
  ): Promise<SynthesizeSingleSegmentResult> {
    return this.call<SynthesizeSingleSegmentResult>(
      'synthesize_single_segment',
      // Tauri's `synthesize_single_segment` takes an `options` param; nest the
      // overrides under it (the HTTP fallback still sends `overrides` as body).
      { projectId, segmentId, options: overrides },
      'POST',
      `/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(
        segmentId,
      )}/tts`,
      overrides,
    );
  }

  renderFinalVideo(
    projectId: string,
    options: RenderFinalVideoBody = {},
  ): Promise<RenderFinalVideoResult> {
    return this.call<RenderFinalVideoResult>(
      'render_final_video',
      // Tauri's `render_final_video` takes an `options` param (HTTP body uses it too).
      { projectId, options },
      'POST',
      `/projects/${encodeURIComponent(projectId)}/render`,
      options,
    );
  }

  /**
   * Opens a folder/file in the OS file manager. In Tauri this hits the native
   * `open_output_folder` command; in the browser the orchestrator runs
   * `open`/`xdg-open` on the host.
   */
  openOutputFolder(path: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('open_output_folder', { path }, 'POST', '/open', {
      path,
    });
  }

  /**
   * Native file picker. Only available inside Tauri (uses tauri-plugin-dialog).
   * In the browser there is no native dialog, so we resolve `null` and the UI
   * falls back to a manual path text input.
   */
  async pickVideoFile(): Promise<string | null> {
    if (!this.tauri) return null;
    // The Tauri command returns `{ path: string | null }` — extract the string
    // (returning the object made the UI show "[object Object]").
    const res = await this.invoke<{ path: string | null }>('pick_video_file');
    return res?.path ?? null;
  }

  getWorkersHealth(): Promise<WorkersHealth> {
    return this.call<WorkersHealth>('get_workers_health', {}, 'GET', '/workers/health');
  }

  getLanguages(): Promise<LanguagesResponse> {
    return this.call<LanguagesResponse>('get_languages', {}, 'GET', '/languages');
  }

  // ------------------------------------------------------------------ //
  // First-run setup / onboarding                                        //
  // ------------------------------------------------------------------ //

  /** GET /setup/status — first-run completion flag + installed inventory. */
  setupGetStatus(): Promise<SetupStatus> {
    return this.call<SetupStatus>('setup_get_status', {}, 'GET', '/setup/status');
  }

  /** GET /setup/preflight — environment self-checks (sidecars, disk, network). */
  setupPreflight(): Promise<PreflightResult> {
    return this.call<PreflightResult>('setup_preflight', {}, 'GET', '/setup/preflight');
  }

  /** GET /setup/catalog — curated models/languages/voices the wizard offers. */
  setupGetCatalog(): Promise<SetupCatalog> {
    return this.call<SetupCatalog>('setup_get_catalog', {}, 'GET', '/setup/catalog');
  }

  /**
   * POST /setup/install — kicks off the async model download. Returns once the
   * job is *started* (202); progress is delivered over the /setup/events SSE
   * stream consumed by {@link SetupEventsService}.
   */
  setupInstallModels(body: SetupInstallRequest): Promise<{ started: boolean }> {
    // Tauri's `setup_install_models` takes a `request` param; the HTTP fallback
    // sends the same object as the JSON body.
    return this.call<{ started: boolean }>(
      'setup_install_models',
      { request: body },
      'POST',
      '/setup/install',
      body,
    );
  }

  /** POST /setup/complete — marks first run as done (writes setup.json). */
  setupComplete(): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('setup_complete', {}, 'POST', '/setup/complete');
  }

  // ------------------------------------------------------------------ //
  // Preferences + auto-update                                           //
  // ------------------------------------------------------------------ //

  /** GET /preferences — the persisted update preference. */
  getPreferences(): Promise<UpdatePreferences> {
    return this.call<UpdatePreferences>('get_preferences', {}, 'GET', '/preferences');
  }

  /** PUT /preferences — persist the update preference. */
  setPreferences(body: UpdatePreferences): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>(
      'set_preferences',
      { preferences: body },
      'PUT',
      '/preferences',
      body,
    );
  }

  /**
   * Convenience: read just the autoUpdate flag. The shell uses the same
   * `/preferences` endpoint, so in the browser we read it via HTTP too.
   */
  async getUpdatePreference(): Promise<UpdatePreferences> {
    if (this.tauri) {
      return this.invoke<UpdatePreferences>('get_update_preference');
    }
    return this.getPreferences();
  }

  /** Convenience: persist just the autoUpdate flag. */
  async setUpdatePreference(body: UpdatePreferences): Promise<{ ok: boolean }> {
    if (this.tauri) {
      return this.invoke<{ ok: boolean }>('set_update_preference', {
        preferences: body,
      });
    }
    return this.setPreferences(body);
  }

  // ------------------------------------------------------------------ //
  // Providers / system profile / cloud credentials                      //
  //                                                                     //
  // These endpoints are consumed over HTTP in BOTH modes: the Tauri     //
  // webview's CSP already allows the orchestrator origin (it's how SSE  //
  // works), and skipping the Rust proxy keeps the surface small.        //
  // ------------------------------------------------------------------ //

  /** GET /providers — selectable providers per phase, with availability. */
  getProviders(): Promise<ProvidersResponse> {
    return this.http<ProvidersResponse>('GET', '/providers');
  }

  /** GET /system — hardware profile + hardware-aware recommendation. */
  getSystemProfile(): Promise<SystemProfileResponse> {
    return this.http<SystemProfileResponse>('GET', '/system');
  }

  /** GET /credentials — masked per-service credential status. */
  getCredentials(): Promise<{ services: CloudCredentialInfo[] }> {
    return this.http<{ services: CloudCredentialInfo[] }>('GET', '/credentials');
  }

  /** PUT /credentials — set/replace/clear one service's key. */
  saveCredential(body: SaveCredentialRequest): Promise<{ ok: boolean; services: CloudCredentialInfo[] }> {
    return this.http<{ ok: boolean; services: CloudCredentialInfo[] }>('PUT', '/credentials', body);
  }

  /** POST /credentials/test — live round-trip to the cloud service. */
  testCredential(service: CloudServiceId): Promise<CredentialTestResult> {
    return this.http<CredentialTestResult>('POST', '/credentials/test', { service });
  }

  /**
   * GET/PUT /preferences over HTTP in both modes — the Rust proxy only knows
   * the autoUpdate field, and these calls need the full preferences object
   * (provider defaults included).
   */
  getAppPreferences(): Promise<UpdatePreferences> {
    return this.http<UpdatePreferences>('GET', '/preferences');
  }

  saveAppPreferences(body: Partial<UpdatePreferences>): Promise<{ ok: boolean }> {
    return this.http<{ ok: boolean }>('PUT', '/preferences', body);
  }

  /**
   * Check GitHub Releases for an available update (tauri-plugin-updater).
   * Tauri-only — in the browser there is no updater, so we resolve a safe
   * "not available" shape (available=false, currentVersion="browser").
   */
  async checkForUpdate(): Promise<UpdateInfo> {
    if (!this.tauri) {
      return { available: false, currentVersion: 'browser' };
    }
    return this.invoke<UpdateInfo>('check_for_update');
  }

  /**
   * The installed app version (from bundle metadata). Network-free, so Settings
   * can show the version even when the updater endpoint is unreachable. In the
   * browser there is no bundle version, so we resolve `null`.
   */
  async getAppVersion(): Promise<string | null> {
    if (!this.tauri) return null;
    const res = await this.invoke<{ version?: string }>('get_app_version');
    return res?.version ?? null;
  }

  /**
   * Download + install the pending update then relaunch. Tauri-only; resolves
   * `{ ok: false }` in the browser (the UI disables this control there).
   */
  async downloadAndInstallUpdate(): Promise<{ ok: boolean }> {
    if (!this.tauri) {
      return { ok: false };
    }
    return this.invoke<{ ok: boolean }>('download_and_install_update');
  }

  /**
   * Open a URL in the OS default browser (tauri-plugin-opener). In the browser
   * we fall back to `window.open` so release-notes links still work in dev.
   */
  async openExternal(url: string): Promise<void> {
    if (this.tauri) {
      await this.invoke<void>('open_external', { url });
      return;
    }
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  // ------------------------------------------------------------------ //
  // Transport internals                                                 //
  // ------------------------------------------------------------------ //

  /**
   * Dispatch a command either via Tauri invoke or HTTP fetch.
   *
   * @param command      Tauri command name (snake_case).
   * @param tauriArgs    Args object passed to invoke().
   * @param method       HTTP verb for the fallback.
   * @param path         REST path (relative to orchestrator base) for fallback.
   * @param httpBody     Optional JSON body for POST/PUT fallbacks.
   */
  private async call<T>(
    command: string,
    tauriArgs: Record<string, unknown>,
    method: HttpMethod,
    path: string,
    httpBody?: unknown,
  ): Promise<T> {
    if (this.tauri) {
      return this.invoke<T>(command, tauriArgs);
    }
    return this.http<T>(method, path, httpBody);
  }

  /** Tauri invoke wrapper with lazy module load. */
  private async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.invokeFn) {
      // Dynamic import keeps @tauri-apps/api out of the browser code path's
      // critical bootstrap and avoids errors when the module's globals are
      // absent during pure-browser dev.
      const mod = await import('@tauri-apps/api/core');
      // Tauri's invoke has an extra optional `options` param; structurally
      // compatible with InvokeFn. Cast via unknown to bridge the arg-type
      // nominal differences (InvokeArgs vs Record<string, unknown>).
      this.invokeFn = mod.invoke as unknown as InvokeFn;
    }
    try {
      return await this.invokeFn!<T>(command, args);
    } catch (err) {
      // Tauri commands reject with a JSON-encoded AppError string (see
      // commands.rs `app_error_json`). Parse it back into a structured AppError
      // object so the UI renders message/remediation instead of raw JSON.
      throw parseTauriError(err);
    }
  }

  /** HTTP fallback. Parses the worker/orchestrator JSON error envelope. */
  private async http<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: { Accept: 'application/json' },
      // Generous ceiling so a hung orchestrator can't wedge the UI forever.
      // Long-running work (pipeline runs) returns 202 immediately, but project
      // creation copies the source video, which can take minutes for large files.
      signal: AbortSignal.timeout(10 * 60 * 1000),
    };
    if (body !== undefined && method !== 'GET') {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (cause) {
      // Network-level failure: orchestrator likely not running.
      throw {
        code: 'WORKER_UNAVAILABLE',
        message: `Could not reach the orchestrator at ${this.baseUrl}.`,
        cause: String(cause),
        remediation:
          'Start the local services (run scripts/dev.sh or scripts/dev.ps1) and ensure port 5100 is free.',
        docsRef: 'docs/LOCAL_SETUP.md',
      };
    }

    const text = await res.text();
    const json = text.length > 0 ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      // Prefer the structured { error } envelope; otherwise synthesize one.
      const envelope = json as { error?: unknown } | undefined;
      if (envelope && typeof envelope.error === 'object' && envelope.error !== null) {
        throw envelope.error;
      }
      throw {
        code: 'UNKNOWN',
        message: `Request failed (${res.status} ${res.statusText}) for ${method} ${path}.`,
        cause: typeof json === 'string' ? json : text.slice(0, 500),
      };
    }

    return json as T;
  }
}

/** JSON.parse that returns the raw string on failure instead of throwing. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Normalize a rejected Tauri `invoke` error. Tauri commands return
 * `Err(String)` where the string is a JSON-encoded AppError; parse it back to
 * the structured object so `toAppError`/the error banner show a clean message
 * + remediation instead of the raw JSON blob.
 */
function parseTauriError(err: unknown): unknown {
  if (typeof err === 'string') {
    const parsed = safeJsonParse(err);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { code?: unknown }).code === 'string' &&
      typeof (parsed as { message?: unknown }).message === 'string'
    ) {
      return parsed;
    }
  }
  return err;
}
