import { Injectable, signal } from '@angular/core';

import { environment } from '../environment';
import type {
  CreateProjectInput,
  ReviseProjectInput,
  MediaInfo,
  PipelineStepId,
  Project,
  ProjectSettings,
  RunScheduleResult,
  TranslationDocContext,
  SegmentPatch,
  TimelineDocument,
  TimelineFilmstrip,
  TimelineWaveform,
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
  ArgosPackagesResponse,
  ArgosPair,
  CloudCredentialInfo,
  CloudServiceId,
  CredentialTestResult,
  MotherClaudeStatus,
  PiperVoiceInfo,
  PreflightResult,
  ProvidersResponse,
  RunPreflightResult,
  ClaudeCodeAction,
  ClaudeIntegration,
  SaveCredentialRequest,
  SetupCatalog,
  SetupInstallRequest,
  SetupStatus,
  QueueState,
  SystemProfileResponse,
  UpdateInfo,
  UpdatePreferences,
} from '../models/setup';
import type { BrandAsset, GreetingPlacement, GreetingPlan, SeriesAiOption, SeriesView } from '@videodubber/shared';
import type {
  AddDownloadsResult,
  DownloadItem,
  DownloadProvider,
  DownloadRequest,
  DubDownloadResult,
  DubPreset,
  ResolvedVideo,
  SessionCheck,
  SessionInfo,
} from '../models/download';
import type {
  EnginePrerequisites,
  EngineRecommendationsResponse,
  EnginesResponse,
  StorageClearRequest,
  StorageClearResult,
  StorageInfo,
  ProjectsFolderInfo,
  TimeRange,
  VoiceConsentStatements,
  VoiceEngineState,
  VoiceInstallResult,
  VoiceLibraryResponse,
  VoiceProfile,
  VoiceReferenceAnalysis,
  VoiceReferenceChecks,
} from '../models';

/** HTTP verbs the fetch fallback understands. */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

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

  /**
   * PUT /projects/:id — New project after Back: the project Continue created,
   * as the form now is (only a project that has never run). Over HTTP in both
   * modes, like /providers: no Rust command needed.
   */
  reviseProject(projectId: string, input: ReviseProjectInput): Promise<Project> {
    return this.http<Project>('PUT', `/projects/${encodeURIComponent(projectId)}`, input);
  }

  /** DELETE /projects/:id — remove a project and its folder (refused while it is busy). */
  deleteProject(projectId: string): Promise<{ ok: boolean }> {
    return this.http<{ ok: boolean }>('DELETE', `/projects/${encodeURIComponent(projectId)}`);
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

  /**
   * Starts the pipeline asynchronously (202 from the orchestrator). When the
   * machine is already at its simultaneous-dub capacity the project is QUEUED
   * instead — `{ started: false, queued: true, position }`.
   */
  runPipeline(projectId: string): Promise<RunScheduleResult> {
    return this.call<RunScheduleResult>(
      'run_pipeline',
      { projectId },
      'POST',
      `/projects/${encodeURIComponent(projectId)}/run`,
    );
  }

  /** GET /queue — running + queued dubs and the capacity in force. */
  getQueue(): Promise<QueueState> {
    return this.http('GET', '/queue');
  }

  /** POST /projects/:id/run-next — move a queued project to the head. */
  runNext(projectId: string): Promise<{ ok: boolean }> {
    return this.http('POST', `/projects/${encodeURIComponent(projectId)}/run-next`, {});
  }

  cancelPipeline(projectId: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>(
      'cancel_pipeline',
      { projectId },
      'POST',
      `/projects/${encodeURIComponent(projectId)}/cancel`,
    );
  }

  /**
   * POST /projects/:id/pause — stop a dub and keep everything it has done;
   * {@link runPipeline} continues it, after a restart too. HTTP in both modes
   * (no Rust command needed).
   */
  pausePipeline(projectId: string): Promise<{ ok: boolean }> {
    return this.http<{ ok: boolean }>('POST', `/projects/${encodeURIComponent(projectId)}/pause`);
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

  /**
   * PUT /projects/:id/settings — change a whitelisted subset of project settings
   * (engine / model / voice / mix / render) after creation. Persists only; the
   * caller re-dubs by calling {@link retryPipelineStep} from the affected stage.
   * Consumed over HTTP in both modes (no Rust command needed — same as
   * /providers), so the editor can update settings without a shell round-trip.
   */
  updateProjectSettings(projectId: string, patch: Partial<ProjectSettings>): Promise<ProjectWithPipeline> {
    return this.http<ProjectWithPipeline>(
      'PUT',
      `/projects/${encodeURIComponent(projectId)}/settings`,
      patch,
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

  /** POST /projects/:id/segments/:segId/refit — re-translate the line shorter + re-synthesize to fit. */
  refitSegment(
    projectId: string,
    segmentId: string,
  ): Promise<SynthesizeSingleSegmentResult & { translatedText: string; shortened?: boolean; reason?: string }> {
    return this.http(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/refit`,
      {},
    );
  }

  // ---- Studio editor (HTTP in both modes: no Rust command needed) -------------

  /** GET /projects/:id/timeline — cues, synthesis units with their fit, media. */
  getTimeline(projectId: string): Promise<TimelineDocument> {
    return this.http('GET', `/projects/${encodeURIComponent(projectId)}/timeline`);
  }

  /** PATCH /projects/:id/timeline — move/trim/re-voice lines; returns the new document. */
  patchTimeline(projectId: string, segments: SegmentPatch[]): Promise<TimelineDocument> {
    return this.http('PATCH', `/projects/${encodeURIComponent(projectId)}/timeline`, { segments });
  }

  /** GET /projects/:id/waveform — the original audio's peaks (built + cached on first call). */
  getWaveform(projectId: string): Promise<TimelineWaveform> {
    return this.http('GET', `/projects/${encodeURIComponent(projectId)}/waveform`);
  }

  /** GET /projects/:id/filmstrip — the thumbnail sprite's layout (the image is served by /file). */
  getFilmstrip(projectId: string): Promise<TimelineFilmstrip> {
    return this.http('GET', `/projects/${encodeURIComponent(projectId)}/filmstrip`);
  }

  /**
   * URL of a project artifact through the orchestrator's `/file` route (the
   * webview cannot load `file://` from its http origin). `version` busts the
   * cache for files rewritten in place (a regenerated clip keeps its path).
   */
  fileUrl(path: string, version?: string | number): string {
    const v = version === undefined ? '' : `&v=${encodeURIComponent(String(version))}`;
    return `${this.baseUrl}/file?path=${encodeURIComponent(path)}${v}`;
  }

  /** URL of a dub clip trimmed and tempo-fitted to `ratio` exactly like the final mix (preview). */
  fittedClipUrl(
    projectId: string,
    unitId: string,
    ratio: number,
    version?: string | number,
    trim?: { startMs: number; endMs: number },
  ): string {
    const v = version === undefined ? '' : `&v=${encodeURIComponent(String(version))}`;
    const t = trim ? `&trimStart=${Math.round(trim.startMs)}&trimEnd=${Math.round(trim.endMs)}` : '';
    return `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/units/${encodeURIComponent(unitId)}/fitted?ratio=${ratio.toFixed(3)}${t}${v}`;
  }

  /** GET /projects/:id/translation-context — the project's character sheet (or null). */
  getTranslationContext(projectId: string): Promise<{ context: TranslationDocContext | null }> {
    return this.http('GET', `/projects/${encodeURIComponent(projectId)}/translation-context`);
  }

  /**
   * GET /projects/:id/translation-report — what the text passes did: the
   * character sheet's fate, the line checks, the review and auto-fit. Only the
   * sheet's status is read here; the rest is for the MCP server and support.
   */
  getTranslationReport(projectId: string): Promise<{
    translation: {
      characterSheet?: { status: string; engine?: string; reason?: string; attempts?: { mode: string; error?: string }[] };
    };
  }> {
    return this.http('GET', `/projects/${encodeURIComponent(projectId)}/translation-report`);
  }

  /** PUT /projects/:id/translation-context — save the (edited) character sheet. */
  saveTranslationContext(
    projectId: string,
    context: TranslationDocContext,
  ): Promise<{ context: TranslationDocContext }> {
    return this.http('PUT', `/projects/${encodeURIComponent(projectId)}/translation-context`, { context });
  }

  /**
   * POST /projects/:id/render — Export's "Render again": a run from the mix
   * when it is out of date, else from the render (202; follow it like a dub).
   */
  rerender(
    projectId: string,
    options: RenderFinalVideoBody = {},
  ): Promise<RunScheduleResult & { fromStep: PipelineStepId }> {
    return this.call<RunScheduleResult & { fromStep: PipelineStepId }>(
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

  /**
   * Native open-file dialog for the brand kit: a picture (`image`) or a sound
   * (`audio`: audio files and videos). Tauri only; `null` in the browser (the
   * UI offers a path field) and when the user cancels.
   */
  async pickMediaFile(kind: 'image' | 'audio', title?: string): Promise<string | null> {
    if (!this.tauri) return null;
    const res = await this.invoke<{ path: string | null }>('pick_media_file', { kind, title });
    return res?.path ?? null;
  }

  /**
   * Native choose-folder dialog, titled `title`, opening in `start` when that
   * folder exists. Only inside Tauri: in the browser there is no native
   * dialog, so this resolves `null` and the UI offers a text field instead.
   * Also `null` when the user cancels.
   */
  async pickFolder(title?: string, start?: string): Promise<string | null> {
    if (!this.tauri) return null;
    const res = await this.invoke<{ path: string | null }>('pick_folder', { title, start });
    return res?.path ?? null;
  }

  /**
   * PUT /projects/:id/output-dir — where this project saves its finished video
   * and subtitles: a folder, or `null` for its own folder in VideoDubber's
   * data. Files already rendered move along. HTTP in both modes (no Rust
   * command needed).
   */
  setProjectOutputDir(projectId: string, outputDir: string | null): Promise<Project> {
    return this.http<Project>('PUT', `/projects/${encodeURIComponent(projectId)}/output-dir`, { outputDir });
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

  /**
   * GET /setup/voices?language= — every Piper voice for a target language,
   * best-first, with the curated default flagged `recommended`. Consumed over
   * HTTP in both modes (no Rust command needed; same as /providers below).
   */
  async setupListVoices(language: string, engine?: 'piper' | 'neural-v2' | 'neural-v3' | 'omnivoice'): Promise<PiperVoiceInfo[]> {
    const eng = engine ? `&engine=${engine}` : '';
    const res = await this.http<{ language: string; voices: PiperVoiceInfo[] }>(
      'GET',
      `/setup/voices?language=${encodeURIComponent(language)}${eng}`,
    );
    return res.voices ?? [];
  }

  /**
   * POST /setup/install-voice — download a single Piper voice on demand (used
   * when the user selects a voice that isn't installed yet). Returns once the
   * job is started (202); progress streams over /setup/events.
   */
  setupInstallVoice(voiceId: string): Promise<{ started: boolean; voiceId: string }> {
    return this.http<{ started: boolean; voiceId: string }>('POST', '/setup/install-voice', { voiceId });
  }

  // ------------------------------------------------------------------ //
  // Voice library (docs/VOICES.md)                                       //
  // ------------------------------------------------------------------ //

  /** GET /voices — every voice (presets + profiles) with its state here. */
  voiceLibrary(params: { projectId?: string } = {}): Promise<VoiceLibraryResponse> {
    const q = params.projectId ? `?projectId=${encodeURIComponent(params.projectId)}` : '';
    return this.http<VoiceLibraryResponse>('GET', `/voices${q}`);
  }

  /** GET /voices/engines — each voice engine with its packs and install state. */
  async voiceEngines(): Promise<VoiceEngineState[]> {
    return (await this.http<{ engines: VoiceEngineState[] }>('GET', '/voices/engines')).engines ?? [];
  }

  /** URL of a voice's preview (served, verified and cached by the orchestrator). */
  voicePreviewUrl(voiceId: string): string {
    return `${this.baseUrl}/voices/${encodeURIComponent(voiceId)}/preview`;
  }

  /** POST /voices/:id/speak — an installed voice saying `text`, as a playable URL (object URL). */
  async speakVoice(voiceId: string, text: string, language?: string): Promise<string> {
    const res = await this.fetchWaitingForBackend(`${this.baseUrl}/voices/${encodeURIComponent(voiceId)}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav, application/json' },
      body: JSON.stringify({ text, ...(language ? { language } : {}) }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!res.ok) {
      const json = safeJsonParse(await res.text()) as { error?: unknown } | undefined;
      throw json?.error ?? { code: 'UNKNOWN', message: `The voice could not speak (${res.status}).` };
    }
    return URL.createObjectURL(await res.blob());
  }

  /** PUT /voices/:id/favorite */
  setVoiceFavorite(voiceId: string, favorite: boolean): Promise<{ id: string; favorite: boolean }> {
    return this.http('PUT', `/voices/${encodeURIComponent(voiceId)}/favorite`, { favorite });
  }

  /** POST /voices/:id/install — the voice, and its engine pack when missing (202). */
  installLibraryVoice(voiceId: string, packId?: string): Promise<VoiceInstallResult> {
    return this.http('POST', `/voices/${encodeURIComponent(voiceId)}/install`, packId ? { packId } : {});
  }

  // ------------------------------------------------------------------ //
  // Voice profiles: cloning (docs/VOICE_CLONING.md)                      //
  // ------------------------------------------------------------------ //

  async voiceProfiles(projectId?: string): Promise<VoiceProfile[]> {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return (await this.http<{ profiles: VoiceProfile[] }>('GET', `/voice-profiles${q}`)).profiles ?? [];
  }

  voiceConsent(locale: string): Promise<VoiceConsentStatements> {
    return this.http('GET', `/voice-profiles/consent?locale=${encodeURIComponent(locale)}`);
  }

  /** POST /voice-profiles/uploads — a recording's raw bytes. */
  async uploadVoiceRecording(blob: Blob): Promise<{ uploadId: string }> {
    const type = (blob.type || 'audio/wav').split(';')[0]!;
    const res = await this.fetchWaitingForBackend(`${this.baseUrl}/voice-profiles/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': type, Accept: 'application/json' },
      body: blob,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    const text = await res.text();
    const json = text ? safeJsonParse(text) : undefined;
    if (!res.ok) {
      const envelope = json as { error?: unknown } | undefined;
      throw envelope?.error ?? { code: 'UNKNOWN', message: `Upload failed (${res.status}).` };
    }
    return json as { uploadId: string };
  }

  analyzeVoiceReference(body: { uploadId?: string; path?: string; sourceName?: string }): Promise<VoiceReferenceAnalysis> {
    return this.http('POST', '/voice-profiles/analyze', { engine: 'vieneu', ...body });
  }

  /**
   * POST /projects/:id/voices/analyze — the project's own speech as a reference:
   * the whole track, or the chosen lines joined (one speaker of several).
   */
  analyzeProjectVoice(projectId: string, selection: { segmentIds?: readonly string[]; speakerId?: string } = {}): Promise<VoiceReferenceAnalysis> {
    return this.http('POST', `/projects/${encodeURIComponent(projectId)}/voices/analyze`, {
      engine: 'vieneu',
      ...(selection.segmentIds?.length ? { segmentIds: [...selection.segmentIds] } : {}),
      ...(selection.speakerId ? { speakerId: selection.speakerId } : {}),
    });
  }

  /**
   * POST /projects/:id/speakers/detect — detect who says each line again, on
   * the lines as they are (no new transcript). `numSpeakers` when known.
   */
  detectSpeakers(projectId: string, numSpeakers?: number): Promise<TimelineDocument> {
    return this.http('POST', `/projects/${encodeURIComponent(projectId)}/speakers/detect`, numSpeakers ? { numSpeakers } : {});
  }

  /**
   * POST /projects/:id/voices/speakers — a cloned voice for every speaker (or
   * the ones named), under one source-video declaration, each assigned to its
   * speaker. Takes about ten seconds per speaker.
   */
  makeSpeakerVoices(
    projectId: string,
    body: {
      consent: { relation: 'source-video'; statementVersion: string; locale: string; accepted: boolean };
      speakerIds?: string[];
      names?: Record<string, string>;
    },
  ): Promise<{
    made: { speakerId: string; profile: VoiceProfile }[];
    skipped: { speakerId: string; reason: 'too-short' | 'failed'; speechMs?: number; message?: string }[];
  }> {
    return this.http('POST', `/projects/${encodeURIComponent(projectId)}/voices/speakers`, { engine: 'vieneu', ...body });
  }

  checkVoiceWindow(analysisId: string, window: TimeRange): Promise<{ window: TimeRange; checks: VoiceReferenceChecks }> {
    return this.http('POST', `/voice-profiles/analysis/${encodeURIComponent(analysisId)}/check`, { window, engine: 'vieneu' });
  }

  voiceAnalysisAudioUrl(analysisId: string): string {
    return `${this.baseUrl}/voice-profiles/analysis/${encodeURIComponent(analysisId)}/audio`;
  }

  createVoiceProfile(body: {
    analysisId: string;
    window: TimeRange;
    name: string;
    note?: string;
    consent: { relation: string; statementVersion: string; locale: string; accepted: boolean };
    keepRecording: boolean;
    denoise: boolean;
    projectId?: string;
    source?: { kind: 'recording' | 'file'; fileName?: string };
  }): Promise<VoiceProfile> {
    return this.http('POST', '/voice-profiles', { engine: 'vieneu', ...body });
  }

  renameVoiceProfile(id: string, patch: { name?: string; note?: string }): Promise<VoiceProfile> {
    return this.http('PATCH', `/voice-profiles/${encodeURIComponent(id)}`, patch);
  }

  deleteVoiceProfile(id: string): Promise<{ ok: boolean }> {
    return this.http('DELETE', `/voice-profiles/${encodeURIComponent(id)}`);
  }

  /** A profile's kept recording or its preview; `v` busts the cache after a re-render. */
  voiceProfileAudioUrl(id: string, kind: 'reference' | 'preview', v?: string | number): string {
    return `${this.baseUrl}/voice-profiles/${encodeURIComponent(id)}/audio/${kind}${v !== undefined ? `?v=${encodeURIComponent(String(v))}` : ''}`;
  }

  /** A .vdvoice file: written into a folder (desktop app), or its download URL (browser). */
  async exportVoiceProfile(id: string, includeRecording: boolean, dir: string | null): Promise<{ path?: string; url?: string }> {
    if (dir) {
      return this.http('POST', `/voice-profiles/${encodeURIComponent(id)}/export`, { dir, includeRecording });
    }
    return { url: `${this.baseUrl}/voice-profiles/${encodeURIComponent(id)}/export${includeRecording ? '?recording=1' : ''}` };
  }

  importVoiceProfile(bundle: unknown, consent: { relation: string; statementVersion: string; locale: string; accepted: boolean }): Promise<VoiceProfile> {
    return this.http('POST', '/voice-profiles/import', { bundle, consent });
  }

  /** Speak `text` (or the standard sentence) in a cloned voice; then play its preview. */
  previewVoiceProfile(id: string, text?: string): Promise<{ ok: boolean }> {
    return this.http('POST', `/voice-profiles/${encodeURIComponent(id)}/preview`, text ? { text } : {});
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
      // The Rust command's parameter is `prefs` (commands.rs); Tauri matches
      // args BY NAME, so sending `preferences` fails the invoke outright.
      return this.invoke<{ ok: boolean }>('set_update_preference', { prefs: body });
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

  /** GET /projects/:id/run-preflight — readiness of the project's SELECTED providers. */
  runPreflight(projectId: string): Promise<RunPreflightResult> {
    return this.http<RunPreflightResult>('GET', `/projects/${encodeURIComponent(projectId)}/run-preflight`);
  }

  /** GET /providers/ollama/models — pulled models + whether the configured one is present. */
  getOllamaModels(): Promise<{ models: string[]; configured: string; present: boolean }> {
    return this.http('GET', '/providers/ollama/models');
  }

  /** POST /providers/ollama/pull — start pulling a (large, optional) model in the background. */
  pullOllamaModel(model?: string): Promise<{ model: string; status: string; percent: number }> {
    return this.http('POST', '/providers/ollama/pull', model ? { model } : {});
  }

  /** GET /providers/ollama/pull-status — poll a model pull's progress. */
  getOllamaPullStatus(
    model: string,
  ): Promise<{ model: string; status: string; percent: number; error?: string }> {
    return this.http('GET', `/providers/ollama/pull-status?model=${encodeURIComponent(model)}`);
  }

  /** POST /projects/:id/ensure-resources — background-install the required local models. */
  ensureProjectResources(projectId: string): Promise<{ installing: boolean }> {
    return this.http('POST', `/projects/${encodeURIComponent(projectId)}/ensure-resources`, {});
  }

  /** GET /providers — selectable providers per phase, with availability + readiness. */
  getProviders(): Promise<ProvidersResponse> {
    return this.http<ProvidersResponse>('GET', '/providers');
  }

  /** GET /integrations/claude — Claude Desktop / Claude Code connection status. */
  getClaudeIntegration(): Promise<ClaudeIntegration> {
    return this.http<ClaudeIntegration>('GET', '/integrations/claude');
  }

  /**
   * POST /integrations/claude/code — connect, reconnect or disconnect Claude
   * Code. The orchestrator runs Claude Code's own CLI (`claude mcp add|remove`);
   * it never writes Claude Code's files itself.
   */
  setClaudeCodeConnection(action: ClaudeCodeAction): Promise<ClaudeIntegration> {
    return this.http<ClaudeIntegration>('POST', '/integrations/claude/code', { action });
  }

  /** POST /integrations/claude/desktop — add (or remove) VideoDubber in Claude Desktop's config. */
  setClaudeDesktopConnection(connect: boolean): Promise<ClaudeIntegration> {
    return this.http<ClaudeIntegration>('POST', '/integrations/claude/desktop', { connect });
  }

  /**
   * GET /project-defaults — engines for a new project: saved choices where
   * usable, else the best installed engines for this machine (with a note per
   * phase the app picked).
   */
  getProjectDefaults(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<{ settings: ProjectSettings; notes: string[] }> {
    const q = new URLSearchParams({ sourceLanguage, targetLanguage });
    return this.http('GET', `/project-defaults?${q.toString()}`);
  }

  // ----- Source-video downloader (experimental) -----

  /** POST /download/expand — the videos of a list link (collection, favourites, uploader); null for another link. */
  expandDownload(input: string): Promise<{ list: { kind: string; title: string; total: number; videos: { input: string; title: string; durationSec: number }[] } | null }> {
    return this.http('POST', '/download/expand', { input });
  }

  /** POST /download/resolve — look up a pasted link without downloading. */
  resolveDownload(input: string): Promise<ResolvedVideo> {
    return this.http<ResolvedVideo>('POST', '/download/resolve', { input });
  }

  /**
   * POST /downloads — add links to the download list (two download at once,
   * the rest wait; a video already there is returned, not added twice).
   * Progress arrives on the `/download/events` SSE stream.
   */
  addDownloads(items: DownloadRequest[], allParts = false): Promise<AddDownloadsResult> {
    return this.http<AddDownloadsResult>('POST', '/downloads', { items, allParts });
  }

  cancelDownload(id: string): Promise<DownloadItem> {
    return this.http<DownloadItem>('POST', `/downloads/${encodeURIComponent(id)}/cancel`, {});
  }

  retryDownload(id: string): Promise<DownloadItem> {
    return this.http<DownloadItem>('POST', `/downloads/${encodeURIComponent(id)}/retry`, {});
  }

  /** Take a download off the list; `deleteFile` deletes its video too (projects keep their own). */
  removeDownload(id: string, deleteFile: boolean): Promise<{ ok: boolean }> {
    return this.http<{ ok: boolean }>('DELETE', `/downloads/${encodeURIComponent(id)}?deleteFile=${deleteFile ? 'true' : 'false'}`);
  }

  // ----- Series: a long video dubbed in parts (series/seriesService.ts) -----

  /** The AIs Settings has set up for choosing cuts and naming parts. */
  seriesAiOptions(): Promise<SeriesAiOption[]> {
    return this.http<SeriesAiOption[]>('GET', '/series/ai-options');
  }

  getSeries(projectId: string): Promise<SeriesView> {
    return this.http<SeriesView>('GET', `/projects/${encodeURIComponent(projectId)}/series`);
  }

  /** Move the cuts and rename the parts before they are made. */
  reviseSeriesPlan(projectId: string, edit: { cuts?: number[]; titles?: { title: string; summary: string }[] }): Promise<unknown> {
    return this.http('PUT', `/projects/${encodeURIComponent(projectId)}/series/plan`, edit);
  }

  /** Make the parts (once) and queue them in order. */
  startSeries(projectId: string): Promise<unknown> {
    return this.http('POST', `/projects/${encodeURIComponent(projectId)}/series/start`, {});
  }

  /** Plan the cuts again (after the AI failed). */
  replanSeries(projectId: string): Promise<unknown> {
    return this.http('POST', `/projects/${encodeURIComponent(projectId)}/series/replan`, {});
  }

  // ----- Logo & greeting (the brand kit, branding/brandKit.ts) -----

  listBrandKit(): Promise<BrandAsset[]> {
    return this.http<BrandAsset[]>('GET', '/branding');
  }

  addLogo(name: string, path: string): Promise<BrandAsset> {
    return this.http<BrandAsset>('POST', '/branding/logos', { name, path });
  }

  /** A greeting from a file (`path`), or said by an installed voice (`text` + `voiceId`). */
  addGreeting(body: { name: string; path?: string; text?: string; voiceId?: string; language?: string }): Promise<BrandAsset> {
    return this.http<BrandAsset>('POST', '/branding/greetings', body);
  }

  deleteBrandAsset(id: string): Promise<{ ok: boolean }> {
    return this.http<{ ok: boolean }>('DELETE', `/branding/${encodeURIComponent(id)}`);
  }

  /** The logo picture / greeting sound, for an <img> or <audio>. */
  brandAssetUrl(id: string): string {
    return `${this.baseUrl}/branding/${encodeURIComponent(id)}/file`;
  }

  /** Where a project's greeting plays (the last mix's plan, or a `preview`). */
  getGreetingPlan(projectId: string): Promise<{ plan: (GreetingPlan & { preview?: boolean; edited?: boolean }) | null }> {
    return this.http('GET', `/projects/${encodeURIComponent(projectId)}/greeting-plan`);
  }

  /** The editor moved, added or removed greetings (kept until the greeting settings change). */
  saveGreetingPlan(projectId: string, placements: GreetingPlacement[]): Promise<{ plan: GreetingPlan }> {
    return this.http('PUT', `/projects/${encodeURIComponent(projectId)}/greeting-plan`, { placements });
  }

  /** POST /downloads/clear-finished — Settings → Storage: finished downloads and their videos. */
  clearFinishedDownloads(): Promise<{ removed: number }> {
    return this.http<{ removed: number }>('POST', '/downloads/clear-finished', {});
  }

  /** POST /downloads/dub — a project per finished download, from a preset. */
  dubDownloads(body: {
    downloadIds: string[];
    presetId?: string;
    start?: boolean;
    /** Dub the downloads longer than `longerThanMinutes` as series of parts. */
    series?: { minMinutes: number; maxMinutes: number; aiProviderId: string; longerThanMinutes: number; autoStart: boolean };
  }): Promise<{ results: DubDownloadResult[] }> {
    return this.http<{ results: DubDownloadResult[] }>('POST', '/downloads/dub', body);
  }

  /** Dub presets ("Mẫu lồng tiếng"). */
  listPresets(): Promise<DubPreset[]> {
    return this.http<DubPreset[]>('GET', '/presets');
  }

  savePreset(
    preset: Pick<DubPreset, 'name' | 'targetLanguage' | 'settings'> & Partial<Pick<DubPreset, 'sourceLanguage' | 'outputDir' | 'start'>>,
    id?: string,
  ): Promise<DubPreset> {
    return id
      ? this.http<DubPreset>('PUT', `/presets/${encodeURIComponent(id)}`, preset)
      : this.http<DubPreset>('POST', '/presets', preset);
  }

  deletePreset(id: string): Promise<{ ok: boolean }> {
    return this.http<{ ok: boolean }>('DELETE', `/presets/${encodeURIComponent(id)}`);
  }

  /** The sources this build can download from, with credential status. */
  getDownloadProviders(): Promise<DownloadProvider[]> {
    return this.http<DownloadProvider[]>('GET', '/download/providers');
  }

  /**
   * A provider's optional credential. Only ever MASKED status crosses this
   * boundary — the raw value travels one way, into the orchestrator.
   */
  getProviderSession(providerId: string): Promise<SessionInfo> {
    return this.http<SessionInfo>('GET', `/download/providers/${encodeURIComponent(providerId)}/session`);
  }

  setProviderSession(providerId: string, value: string): Promise<SessionInfo> {
    return this.http<SessionInfo>(
      'PUT',
      `/download/providers/${encodeURIComponent(providerId)}/session`,
      { value },
    );
  }

  clearProviderSession(providerId: string): Promise<SessionInfo> {
    return this.http<SessionInfo>(
      'DELETE',
      `/download/providers/${encodeURIComponent(providerId)}/session`,
    );
  }

  /** Ask the site whether the stored credential is still live. */
  testProviderSession(providerId: string): Promise<SessionCheck> {
    return this.http<SessionCheck>(
      'POST',
      `/download/providers/${encodeURIComponent(providerId)}/session/test`,
      {},
    );
  }

  // ----- Argos translation packs (browse the full index + install/remove) -----

  /**
   * GET /providers/argos/packages — installed pairs always; pass `refresh=true`
   * to also fetch the full downloadable Argos index (a network call).
   */
  getArgosPackages(refresh = false): Promise<ArgosPackagesResponse> {
    return this.http<ArgosPackagesResponse>(
      'GET',
      `/providers/argos/packages${refresh ? '?refresh=true' : ''}`,
    );
  }

  /** POST /providers/argos/packages/ensure — download+install one pair (synchronous). */
  ensureArgosPackage(pair: ArgosPair): Promise<{ ok: boolean; installed: boolean }> {
    return this.http<{ ok: boolean; installed: boolean }>(
      'POST',
      '/providers/argos/packages/ensure',
      pair,
    );
  }

  /** POST /providers/argos/packages/remove — uninstall one pair. */
  removeArgosPackage(pair: ArgosPair): Promise<{ ok: boolean; removed: boolean }> {
    return this.http<{ ok: boolean; removed: boolean }>(
      'POST',
      '/providers/argos/packages/remove',
      pair,
    );
  }

  /** GET /system — hardware profile + hardware-aware recommendation. */
  getSystemProfile(): Promise<SystemProfileResponse> {
    return this.http<SystemProfileResponse>('GET', '/system');
  }

  /** GET /credentials — masked per-service credential status. */
  getCredentials(): Promise<{ services: CloudCredentialInfo[] }> {
    return this.http<{ services: CloudCredentialInfo[] }>('GET', '/credentials');
  }

  // ----- Engine packs (optional accelerated/heavy local engines) -----

  /** GET /engines — packs runnable on this machine + installed set. */
  getEngines(): Promise<EnginesResponse> {
    return this.http<EnginesResponse>('GET', '/engines');
  }

  /** GET /engines/recommended — hardware-aware suggested packs. */
  getRecommendedEngines(): Promise<EngineRecommendationsResponse> {
    return this.http<EngineRecommendationsResponse>('GET', '/engines/recommended');
  }

  /** GET /engines/prerequisites — uv (bundled?) + Ollama availability. */
  getEnginePrerequisites(): Promise<EnginePrerequisites> {
    return this.http<EnginePrerequisites>('GET', '/engines/prerequisites');
  }

  /** POST /engines/install — start a pack download (progress via SSE). */
  installEngine(packId: string): Promise<{ started: boolean; alsoInstalling?: string[] }> {
    return this.http<{ started: boolean; alsoInstalling?: string[] }>('POST', '/engines/install', { packId });
  }

  /** POST /engines/uninstall — remove an installed pack. */
  uninstallEngine(packId: string): Promise<{ ok: boolean }> {
    return this.http<{ ok: boolean }>('POST', '/engines/uninstall', { packId });
  }

  /** GET /storage — the app's deletable on-disk footprint (packs/models/caches). */
  getStorage(): Promise<StorageInfo> {
    return this.http<StorageInfo>('GET', '/storage');
  }

  /** POST /storage/clear — delete downloaded packages/models/caches to free space. */
  clearStorage(req: StorageClearRequest = {}): Promise<StorageClearResult> {
    return this.http<StorageClearResult>('POST', '/storage/clear', req);
  }

  /** GET /storage/projects-folder — where the projects live, and a move in progress. */
  getProjectsFolder(): Promise<ProjectsFolderInfo> {
    return this.http<ProjectsFolderInfo>('GET', '/storage/projects-folder');
  }

  /** PUT /storage/projects-folder — move every project to `<root>/projects` (null: VideoDubber's own folder). */
  moveProjectsFolder(root: string | null): Promise<ProjectsFolderInfo> {
    return this.http<ProjectsFolderInfo>('PUT', '/storage/projects-folder', { root });
  }

  /**
   * Reveal an app-managed folder in the OS file manager (Finder / File Explorer).
   * Native `open_path` in Tauri; the guarded `/open` endpoint in the browser.
   */
  openManagedFolder(path: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('open_path', { path }, 'POST', '/open', { path });
  }

  /** PUT /credentials — set/replace/clear one service's key. */
  saveCredential(body: SaveCredentialRequest): Promise<{ ok: boolean; services: CloudCredentialInfo[] }> {
    return this.http<{ ok: boolean; services: CloudCredentialInfo[] }>('PUT', '/credentials', body);
  }

  /** POST /credentials/test — live round-trip to the cloud service. */
  testCredential(service: CloudServiceId): Promise<CredentialTestResult> {
    return this.http<CredentialTestResult>('POST', '/credentials/test', { service });
  }

  /** GET /credentials/mother-claude — is Mother Claude's HTTP API running (no tokens spent)? */
  getMotherClaudeStatus(): Promise<MotherClaudeStatus> {
    return this.http<MotherClaudeStatus>('GET', '/credentials/mother-claude');
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
      await this.awaitBackend();
      const result = await this.invoke<T>(command, tauriArgs);
      // Every `call()` command proxies the orchestrator, so one succeeding IS
      // first contact. Without this, a session whose boot probe timed out kept
      // the app-wide "backend isn't running" notice up forever even though the
      // Rust client was getting answers. (Deliberately not inside `invoke()`:
      // that also serves native-only commands like the file picker, which say
      // nothing about the orchestrator.)
      this.backendSeen = true;
      this._backendDown.set(false);
      return result;
    }
    return this.http<T>(method, path, httpBody);
  }

  /**
   * Block the first desktop-shell command until the orchestrator answers.
   *
   * The boot-wait loop and the ONLY two writes to `_backendDown` live in
   * {@link fetchWaitingForBackend}, which is reached solely from {@link http} —
   * so in the packaged app, where every startup command (`setup_get_status`,
   * `list_projects`, `get_workers_health`) takes the invoke branch, neither
   * existed. Within ~3 s the first-run guard concluded "setup complete" against
   * an unreachable backend, Home's own fetch failed, and the app-wide notice
   * with the Restart button never appeared because nothing on that path ever
   * set `_backendDown`.
   *
   * `orchestrator_client.rs` now mirrors the boot wait on the Rust side, so the
   * PATIENCE is covered there too — but a Rust retry cannot set an Angular
   * signal, and `_backendDown` is what puts the recovery banner on screen. That
   * signal is the reason this probe stays.
   *
   * One cheap `GET /health` through the patient fetch fixes both at once, and
   * leaves every command's semantics untouched (`open_output_folder`, for one,
   * deliberately does something different from its REST path). It runs once per
   * session: `backendSeen` is set by the first successful fetch — including the
   * many endpoints that already go over HTTP in both modes, which usually get
   * there first and make this a no-op.
   */
  private async awaitBackend(): Promise<void> {
    if (this.backendSeen) return;
    // Cached for the whole session, settled or not: a burst of startup calls
    // must wait once between them, and if the wait ends in failure the notice
    // is already up — later calls should fail fast through the Rust client
    // (which clears the notice itself if the backend turns out to be alive).
    this.backendProbe ??= this.http<unknown>('GET', '/health').catch(() => undefined);
    await this.backendProbe;
  }

  /** The one-shot boot probe, shared by every command that races it. */
  private backendProbe: Promise<unknown> | null = null;

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

  /**
   * True once any request has reached the orchestrator in this session.
   *
   * Before first contact the backend is presumed to be STARTING; after it, a
   * connection failure means it went away and should surface quickly.
   */
  private backendSeen = false;

  /**
   * Set when the backend could not be reached even after waiting for it, and
   * cleared as soon as any request succeeds. The app shell watches this to show
   * one clear app-wide notice (with a Restart button) instead of leaving each
   * screen to render its own failure.
   */
  private readonly _backendDown = signal(false);
  readonly backendDown = this._backendDown.asReadonly();

  /**
   * Relaunch the desktop app (`restart_app`). Restarting is the reliable cure
   * for a backend that lost the startup race: the sidecar binary is warm the
   * second time, so it comes up quickly. No-op outside the desktop shell.
   */
  async restartApp(): Promise<void> {
    if (!this.tauri) return;
    await this.invoke('restart_app', {});
  }

  /**
   * `fetch`, but patient while the backend is still coming up.
   *
   * The desktop shell spawns the orchestrator sidecar and opens the window
   * immediately — it does not wait for the port. The UI therefore races a
   * process that has to start a ~100 MB Node SEA binary, which on Windows is
   * also scanned by Defender the first time it runs (i.e. right after an
   * install or an update). Every screen that fetched on load turned that race
   * into a hard "Could not reach the orchestrator" error, most visibly on
   * Settings.
   *
   * A connection-level failure means the request never reached a server, so
   * retrying is safe for any method — nothing was applied. We are generous only
   * until first contact; afterwards a dead backend fails fast instead of
   * freezing the UI for half a minute.
   */
  private async fetchWaitingForBackend(url: string, init: RequestInit): Promise<Response> {
    const deadline = Date.now() + (this.backendSeen ? 2_000 : 60_000);
    let delay = 150;
    for (;;) {
      try {
        const res = await fetch(url, init);
        this.backendSeen = true;
        this._backendDown.set(false);
        return res;
      } catch (cause) {
        // An aborted request is the caller's own timeout, not a boot race.
        if (init.signal?.aborted || Date.now() >= deadline) {
          // Out of patience: surface it once, app-wide.
          if (!init.signal?.aborted) this._backendDown.set(true);
          throw cause;
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 1_500);
      }
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
      res = await this.fetchWaitingForBackend(url, init);
    } catch (cause) {
      // Network-level failure: the orchestrator isn't listening (and, after
      // fetchWaitingForBackend, isn't going to be within the boot window).
      throw {
        code: 'WORKER_UNAVAILABLE',
        message: `Could not reach the orchestrator at ${this.baseUrl}.`,
        cause: String(cause),
        // The dev advice is actively wrong inside the packaged app, where the
        // shell owns the backend and the user has no scripts/ directory.
        remediation: this.inTauri
          ? 'The built-in backend did not start. Quit and reopen VideoDubber; if it keeps happening, ' +
            'reinstall the app, and check that no other program is using port 5100 ' +
            '(some antivirus and VPN tools block local ports).'
          : 'Start the local services (run scripts/dev.sh or scripts/dev.ps1) and ensure port 5100 is free.',
        docsRef: this.inTauri ? 'docs/TROUBLESHOOTING.md' : 'docs/LOCAL_SETUP.md',
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
