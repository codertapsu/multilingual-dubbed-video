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
    return this.invoke<string | null>('pick_video_file');
  }

  getWorkersHealth(): Promise<WorkersHealth> {
    return this.call<WorkersHealth>('get_workers_health', {}, 'GET', '/workers/health');
  }

  getLanguages(): Promise<LanguagesResponse> {
    return this.call<LanguagesResponse>('get_languages', {}, 'GET', '/languages');
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
    return this.invokeFn!<T>(command, args);
  }

  /** HTTP fallback. Parses the worker/orchestrator JSON error envelope. */
  private async http<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: { Accept: 'application/json' },
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
