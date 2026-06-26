import type { OnDestroy, OnInit } from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { IpcService } from '../../core/ipc/ipc.service';
import { SetupEventsService } from '../../core/ipc/setup-events.service';
import { ProjectStore, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { DownloadProgressListComponent } from '../../shared/download-progress-list/download-progress-list.component';
import { BusyIndicatorComponent } from '../../shared/busy-indicator/busy-indicator.component';
import {
  ALL_SUBTITLE_EXPORT_MODES,
  SUBTITLE_EXPORT_MODE_HINTS,
  SUBTITLE_EXPORT_MODE_LABELS,
  formatBytes,
  formatDurationCoarse,
} from '../../core/util/format';
import {
  FALLBACK_COMMON_LANGUAGES,
  type CommonLanguage,
} from '../../core/models/view-models';
import type {
  AppError,
  CreateProjectInput,
  LanguageCode,
  MediaInfo,
  OriginalAudioMode,
  ProjectSettings,
  RenderQuality,
  SubtitleExportMode,
} from '../../core/models';
import type { PiperVoiceInfo, ProviderInfo, ProvidersResponse, RunPreflightProvider } from '../../core/models/setup';

/** Wizard step index. */
type WizardStep = 1 | 2;

/**
 * Default project settings tuned for offline Vietnamese-friendly dubbing.
 * Provider ids match the local worker defaults.
 */
function defaultSettings(): ProjectSettings {
  return {
    sourceLanguage: 'en-US',
    targetLanguage: 'vi-VN',
    subtitleExportMode: 'srt-file',
    processingMode: 'local',
    sttProviderId: 'faster-whisper',
    translationProviderId: 'argos',
    ttsProviderId: 'piper-local',
    sttModel: 'large-v3-turbo',
    includeOriginalBackgroundAudio: true,
    duckOriginalAudio: true,
    duckingLevelDb: -12,
    originalAudioMode: 'keep',
    renderQuality: 'quality',
    timeStretchEngine: 'auto',
    ttsGainDb: 0,
    // Translations (esp. EN->VI) are usually longer than the source. Combined
    // with gap-aware alignment (a line can use the pause until the next line),
    // these tolerances keep most segments fitting on real content. Piper stays
    // intelligible up to ~1.5x; overflow lets a line spill briefly past its slot.
    maxSpeedRatio: 1.6,
    allowedOverflowMs: 1500,
    // Auto-shorten any line that still can't fit even at max speed (LLM
    // translation providers only; no-op for Argos). On by default.
    autoFitOverflow: true,
  };
}

/**
 * NewProjectWizardComponent (route "new").
 * Step 1: pick the source video + languages + subtitle/processing options.
 * Step 2: probe the media (after a project is created so the orchestrator has
 *         a workspace), confirm output, then run the pipeline.
 *
 * NOTE on ordering: probe_video is an orchestrator endpoint keyed by project
 * id, so we create the project first (Step 1 -> Step 2 transition), then probe
 * inside Step 2, then "Start" runs the pipeline and navigates to processing.
 */
@Component({
  selector: 'vd-new-project-wizard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorBannerComponent, DownloadProgressListComponent, BusyIndicatorComponent],
  templateUrl: './new-project-wizard.component.html',
  styleUrl: './new-project-wizard.component.scss',
})
export class NewProjectWizardComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly router = inject(Router);
  private readonly store = inject(ProjectStore);
  protected readonly setupEvents = inject(SetupEventsService);

  // Static label maps for the template.
  protected readonly subtitleModes = ALL_SUBTITLE_EXPORT_MODES;
  protected readonly subtitleLabels = SUBTITLE_EXPORT_MODE_LABELS;
  protected readonly subtitleHints = SUBTITLE_EXPORT_MODE_HINTS;
  protected readonly formatBytes = formatBytes;
  protected readonly formatDuration = formatDurationCoarse;
  protected readonly inTauri = this.ipc.inTauri;

  // -------- form state --------
  protected readonly step = signal<WizardStep>(1);
  protected readonly name = signal('');
  protected readonly inputVideoPath = signal('');
  protected readonly outputDir = signal('');
  protected readonly languages = signal<CommonLanguage[]>([
    ...FALLBACK_COMMON_LANGUAGES,
  ]);
  protected readonly settings = signal<ProjectSettings>(defaultSettings());

  /** Per-phase provider catalog (local + cloud, with availability flags). */
  protected readonly providers = signal<ProvidersResponse | null>(null);

  /** Ids of engine packs currently installed — gates the optional feature toggles
   * (a feature whose pack isn't installed is disabled with an "Install" hint, so
   * the user can't enable something that would silently no-op during the run). */
  protected readonly installedPacks = signal<ReadonlySet<string>>(new Set<string>());
  /** Vocal-separation pack ("replace original vocals" mix mode) is installed. */
  protected readonly vocalSeparationReady = computed(() => this.installedPacks().has('separation-audio'));
  /** WhisperX pack (forced alignment + diarization) is installed. */
  protected readonly whisperxReady = computed(() => this.installedPacks().has('alignment-whisperx'));

  /** Phases currently routed to a cloud provider (drives the privacy note). */
  protected readonly cloudPhases = computed(() => {
    const provs = this.providers();
    const s = this.settings();
    if (!provs) return [] as string[];
    const find = (list: ProviderInfo[], id: string) => list.find((p) => p.id === id);
    const phases: string[] = [];
    if (find(provs.stt, s.sttProviderId)?.isLocal === false) phases.push('speech-to-text (uploads the audio track)');
    if (find(provs.translation, s.translationProviderId)?.isLocal === false) phases.push('translation (sends the transcript text)');
    if (find(provs.tts, s.ttsProviderId)?.isLocal === false) phases.push('text-to-speech (sends the translated text)');
    return phases;
  });

  // -------- Piper voice picker (per target language) --------
  /** Voices available for the current target language (best-first). */
  protected readonly availableVoices = signal<PiperVoiceInfo[]>([]);
  /** Voice ids already downloaded on this machine. */
  protected readonly installedVoiceIds = signal<ReadonlySet<string>>(new Set());
  /** True while (re)loading the per-language voice list. */
  protected readonly voicesLoading = signal(false);
  /** True while a selected voice downloads on demand. */
  protected readonly voiceDownloading = signal(false);
  /** Download percent of the in-flight voice (0..100, or null = indeterminate). */
  protected readonly voiceDownloadPercent = signal<number | null>(null);

  /** Show the voice picker for the local Piper engine or a VieNeu neural engine. */
  protected readonly showVoicePicker = computed(() => this.voiceEngine() !== null);

  /** Which voice catalog to list for the selected TTS provider (null = no picker). */
  protected readonly voiceEngine = computed<'piper' | 'neural-v2' | 'neural-v3' | 'omnivoice' | null>(() => {
    switch (this.settings().ttsProviderId) {
      case 'piper-local':
        return 'piper';
      case 'neural-tts-v2':
        return 'neural-v2';
      case 'neural-tts':
        return 'neural-v3';
      case 'omnivoice':
        return 'omnivoice';
      default:
        return null;
    }
  });

  /**
   * True when the currently-pinned voice still needs downloading. Neural (VieNeu)
   * voices ship bundled in the engine pack, so they are never per-voice downloads.
   */
  protected readonly selectedVoiceNeedsDownload = computed(() => {
    if (this.voiceEngine() !== 'piper') return false;
    const id = this.settings().ttsVoiceId;
    return Boolean(id) && !this.installedVoiceIds().has(id as string);
  });

  // -------- async state --------
  protected readonly busy = signal(false);

  /** True while the default models for the chosen languages are still downloading. */
  protected readonly preparingModels = signal(false);

  /** Clear "preparing" as soon as the background model download finishes or fails. */
  private readonly _clearPreparing = effect(() => {
    if (this.setupEvents.done() || this.setupEvents.error()) this.preparingModels.set(false);
  });
  protected readonly error = signal<AppError | null>(null);
  protected readonly createdProjectId = signal<string | null>(null);
  protected readonly mediaInfo = signal<MediaInfo | null>(null);

  /** Step 1 is valid once we have a video path and distinct languages. */
  protected readonly step1Valid = computed(() => {
    const s = this.settings();
    return (
      this.inputVideoPath().trim().length > 0 &&
      s.sourceLanguage.length > 0 &&
      s.targetLanguage.length > 0
    );
  });

  /** True when the probed media has no audio stream (we must warn loudly). */
  protected readonly noAudioWarning = computed(() => {
    const info = this.mediaInfo();
    return info ? !info.hasAudio || info.audioStreams.length === 0 : false;
  });

  ngOnInit(): void {
    void this.loadLanguages();
    void this.init();
  }

  ngOnDestroy(): void {
    // Stop listening to the global setup stream when leaving the wizard.
    this.setupEvents.disconnect();
  }

  /** Load the provider catalog + saved defaults, then the per-language voices. */
  private async init(): Promise<void> {
    await this.loadProvidersAndDefaults();
    if (this.showVoicePicker()) await this.loadVoicesForTarget();
  }

  private async loadLanguages(): Promise<void> {
    try {
      const resp = await this.ipc.getLanguages();
      // Prefer the translatable set (only languages Argos can do) so the user
      // can't pick a pair that errors; fall back to the full common list.
      const langs = resp.translatable?.length ? resp.translatable : resp.common;
      if (langs && langs.length > 0) {
        this.languages.set(langs);
      }
    } catch {
      // Offline / orchestrator down: keep the bundled fallback list silently.
    }
  }

  /**
   * Load the provider catalog and seed the project settings with the user's
   * saved defaults (Settings → Processing defaults). A default provider whose
   * API key has since been removed is skipped — the local engine stays.
   */
  private async loadProvidersAndDefaults(): Promise<void> {
    try {
      const [provs, prefs, engines] = await Promise.all([
        this.ipc.getProviders(),
        this.ipc.getAppPreferences(),
        this.ipc.getEngines().catch(() => null),
      ]);
      this.providers.set(provs);
      if (engines) {
        this.installedPacks.set(new Set(engines.installed.map((p) => p.id)));
        this.resetUnavailableFeatureToggles();
      }
      const d = prefs.providerDefaults;
      if (d) {
        const usable = (list: ProviderInfo[], id?: string) =>
          id && list.some((p) => p.id === id && p.available) ? id : undefined;
        this.settings.update((s) => ({
          ...s,
          sttProviderId: usable(provs.stt, d.sttProviderId) ?? s.sttProviderId,
          translationProviderId:
            usable(provs.translation, d.translationProviderId) ?? s.translationProviderId,
          ttsProviderId: usable(provs.tts, d.ttsProviderId) ?? s.ttsProviderId,
          sttModel: d.sttModel ?? s.sttModel,
        }));
        this.syncProcessingMode();
      }
      this.applyVietnameseNeuralDefault();
    } catch {
      // Offline / orchestrator down: the wizard still works with local defaults.
    }
  }

  /**
   * Prefer VieNeu v2 for Vietnamese dubbing — but only when its engine pack is
   * already installed, so a first-run user isn't forced into a download to dub
   * Vietnamese (Piper stays the safe out-of-box default; they can install v2 to
   * upgrade). Only nudges when the user hasn't otherwise chosen a TTS engine.
   */
  private applyVietnameseNeuralDefault(): void {
    const provs = this.providers();
    const s = this.settings();
    if (!provs) return;
    if ((s.targetLanguage.split('-')[0] ?? '').toLowerCase() !== 'vi') return;
    if (s.ttsProviderId !== 'piper-local') return; // respect an explicit choice
    if (provs.tts.find((p) => p.id === 'neural-tts-v2')?.available) {
      this.patchSettings('ttsProviderId', 'neural-tts-v2');
      this.syncProcessingMode();
    }
  }

  /**
   * Keep settings consistent with what's installed: a feature whose engine pack
   * isn't present is forced off (replace-vocals → keep; forced alignment +
   * diarization → off). So a saved default or earlier choice can't leave the user
   * having "selected" a feature that would silently no-op during the run.
   */
  private resetUnavailableFeatureToggles(): void {
    this.settings.update((s) => {
      const next = { ...s };
      if (!this.vocalSeparationReady() && next.originalAudioMode === 'replace-vocals') {
        next.originalAudioMode = 'keep';
        next.includeOriginalBackgroundAudio = true;
      }
      // Forced alignment degrades gracefully to the default timestamps without the
      // WhisperX pack, so it stays enabled. Diarization has no fallback (it'd be a
      // silent no-op), so it's forced off until the pack is installed.
      if (!this.whisperxReady()) {
        next.diarize = false;
      }
      return next;
    });
  }

  // ----------------------------- Step 1 -----------------------------

  protected async pickVideo(): Promise<void> {
    const picked = await this.ipc.pickVideoFile();
    if (picked) {
      this.inputVideoPath.set(picked);
      if (!this.name().trim()) {
        this.name.set(deriveProjectName(picked));
      }
    }
  }

  protected onPathInput(value: string): void {
    this.inputVideoPath.set(value);
    if (!this.name().trim() && value.trim()) {
      this.name.set(deriveProjectName(value));
    }
  }

  protected patchSettings<K extends keyof ProjectSettings>(
    key: K,
    value: ProjectSettings[K],
  ): void {
    this.settings.update((s) => ({ ...s, [key]: value }));
  }

  protected setSubtitleMode(mode: SubtitleExportMode): void {
    this.patchSettings('subtitleExportMode', mode);
  }

  /**
   * What happens to the original soundtrack in the final mix:
   *  - keep           — kept as background, ducked under the dubbed voice.
   *  - remove         — dub fully replaces the original audio.
   *  - replace-vocals — separate vocals from music/effects, drop the original
   *                     vocals, mix the dub over the full-volume M&E bed
   *                     (needs the Vocal separation engine pack).
   */
  protected setOriginalAudioMode(mode: OriginalAudioMode): void {
    this.settings.update((s) => ({
      ...s,
      originalAudioMode: mode,
      // Keep the legacy booleans coherent for any older consumer.
      includeOriginalBackgroundAudio: mode !== 'remove',
      duckOriginalAudio: mode === 'keep' ? true : s.duckOriginalAudio,
    }));
  }

  protected setRenderQuality(quality: RenderQuality): void {
    this.patchSettings('renderQuality', quality);
  }

  protected toggleForcedAlignment(on: boolean): void {
    this.patchSettings('forcedAlignment', on);
  }

  protected toggleDiarize(on: boolean): void {
    this.patchSettings('diarize', on);
  }

  /** Background attenuation choices while the dubbed voice speaks. */
  protected readonly duckingOptions: ReadonlyArray<{ value: number; label: string }> = [
    { value: -6, label: 'Subtle (−6 dB) — background stays prominent' },
    { value: -12, label: 'Standard (−12 dB) — recommended' },
    { value: -18, label: 'Strong (−18 dB) — background well behind the voice' },
    { value: -24, label: 'Very strong (−24 dB) — background barely audible' },
  ];

  /** <select> values arrive as strings; coerce + guard before patching. */
  protected setDuckingLevel(value: string): void {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed <= 0) {
      this.patchSettings('duckingLevelDb', parsed);
    }
  }

  /**
   * Max speech speed choices. Translations (esp. EN→VI) are often longer than
   * the source line; the aligner may speed segments up to this cap to fit.
   * Higher = fewer timing conflicts but faster-sounding speech.
   */
  protected readonly speedOptions: ReadonlyArray<{ value: number; label: string; hint: string }> = [
    { value: 1.3, label: '1.3× — most natural', hint: 'Gentle speed-up; expect more timing warnings on dense dialogue.' },
    { value: 1.6, label: '1.6× — balanced (recommended)', hint: 'Good fit for most content; speech stays clearly intelligible.' },
    { value: 1.8, label: '1.8× — tighter fit', hint: 'Noticeably brisk speech; few timing warnings.' },
    { value: 2.0, label: '2.0× — fit everything', hint: 'Minimizes conflicts; speech can sound rushed.' },
  ];

  /** <select> values arrive as strings; coerce + guard before patching. */
  protected setMaxSpeed(value: string): void {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed >= 1) {
      this.patchSettings('maxSpeedRatio', parsed);
    }
  }

  /** Change the engine for one phase and re-derive the processing mode. */
  protected setProvider(
    key: 'sttProviderId' | 'translationProviderId' | 'ttsProviderId',
    providerId: string,
  ): void {
    this.patchSettings(key, providerId);
    this.syncProcessingMode();
    // Switching the TTS engine to Piper or a VieNeu engine reveals the per-language
    // voice picker — populate it (with the right voice catalog) for the target.
    if (key === 'ttsProviderId' && this.voiceEngine() !== null) {
      void this.loadVoicesForTarget();
    }
  }

  /** Target language changed — re-patch and reload the per-language voices. */
  protected setTargetLanguage(code: LanguageCode): void {
    this.patchSettings('targetLanguage', code);
    // Switching to Vietnamese prefers VieNeu v2 (if its pack is installed).
    this.applyVietnameseNeuralDefault();
    if (this.showVoicePicker()) void this.loadVoicesForTarget();
  }

  /**
   * Load the Piper voices for the current target language and reconcile the
   * selection: keep the user's pinned voice if it's still offered, else pick the
   * recommended (curated default), else the best-ranked, else none. Also reads
   * which voices are already on disk so the UI can label "downloads on select".
   */
  private async loadVoicesForTarget(): Promise<void> {
    const language = this.settings().targetLanguage;
    const engine = this.voiceEngine();
    if (!engine) return;
    this.voicesLoading.set(true);
    try {
      const [voices, status] = await Promise.all([
        this.ipc.setupListVoices(language, engine),
        // Only Piper voices are tracked as individually installed.
        engine === 'piper' ? this.ipc.setupGetStatus().catch(() => null) : Promise.resolve(null),
      ]);
      this.availableVoices.set(voices);
      this.installedVoiceIds.set(new Set(status?.installed.piperVoices ?? []));

      // Reconcile the pinned voice against what's actually offered.
      const current = this.settings().ttsVoiceId;
      const stillOffered = current && voices.some((v) => v.id === current);
      if (!stillOffered) {
        const pick = voices.find((v) => v.recommended) ?? voices[0];
        this.patchSettings('ttsVoiceId', pick?.id);
      }
    } catch {
      // Offline / backend down: leave the picker empty. The run-start readiness
      // gate + ensure-resources still cover the pinned voice.
      this.availableVoices.set([]);
    } finally {
      this.voicesLoading.set(false);
    }
  }

  /**
   * The user picked a voice. Pin it on the project and, if it isn't on disk yet,
   * download it immediately (lazy, on-select) with visible progress. A failed or
   * skipped download here isn't fatal — the run is gated on the voice at start.
   */
  protected async onSelectVoice(voiceId: string): Promise<void> {
    this.patchSettings('ttsVoiceId', voiceId);
    // Neural (VieNeu) voices come with the engine pack — nothing to download per
    // voice; the run-start gate prompts to install the pack if it isn't yet.
    if (this.voiceEngine() !== 'piper') return;
    if (!voiceId || this.installedVoiceIds().has(voiceId) || this.voiceDownloading()) return;
    await this.downloadVoice(voiceId);
  }

  /** Download a single Piper voice on demand, streaming progress over setup SSE. */
  private async downloadVoice(voiceId: string): Promise<void> {
    this.voiceDownloading.set(true);
    this.voiceDownloadPercent.set(null);
    this.error.set(null);
    try {
      // Reuse the global setup SSE channel for live progress, then start the job.
      this.setupEvents.connect();
      await this.ipc.setupInstallVoice(voiceId);
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const item = this.setupEvents.items().find((i) => i.item === `piper:${voiceId}`);
        if (item) this.voiceDownloadPercent.set(item.percent);
        const err = this.setupEvents.error();
        if (err) {
          this.error.set(err);
          return;
        }
        if (this.setupEvents.done() || item?.done) break;
      }
      this.installedVoiceIds.update((s) => new Set(s).add(voiceId));
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.setupEvents.disconnect();
      this.voiceDownloading.set(false);
    }
  }

  /** Human label for the current target language (falls back to the raw code). */
  protected targetLanguageLabel(): string {
    const code = this.settings().targetLanguage;
    return this.languages().find((l) => l.code === code)?.label ?? code;
  }

  /** Why an unavailable provider can't be picked (shown after its name). */
  protected providerHint(p: ProviderInfo): string {
    if (p.available) return '';
    switch (p.readinessStatus) {
      case 'engine-pack-missing':
        return ' — needs engine pack (Settings → Engines)';
      case 'cloud-key-missing':
        return ' — needs API key';
      case 'daemon-unreachable':
        return ' — service not running';
      case 'model-missing':
        return ' — needs a model';
      case 'worker-loading':
        return ' — service starting…';
      default:
        return ' — unavailable';
    }
  }

  /**
   * processingMode is DERIVED: "cloud-enhanced" iff any phase routes to a
   * non-local provider. Persisted on the project for transparency/reporting.
   */
  private syncProcessingMode(): void {
    this.patchSettings('processingMode', this.cloudPhases().length > 0 ? 'cloud-enhanced' : 'local');
  }

  /**
   * Transition to Step 2: create the project (so a workspace exists) and then
   * probe the media to display its info before committing to a run.
   */
  protected async goToStep2(): Promise<void> {
    if (!this.step1Valid() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const input: CreateProjectInput = {
        name: this.name().trim() || deriveProjectName(this.inputVideoPath()),
        inputVideoPath: this.inputVideoPath().trim(),
        settings: this.settings(),
        outputDir: this.outputDir().trim() || undefined,
      };
      const project = await this.ipc.createProject(input);
      this.createdProjectId.set(project.id);
      this.outputDir.set(project.outputDir);
      this.store.setCurrent(project);

      // Pre-fetch any required local models (whisper/Argos pair/Piper voice) now
      // that the languages are known. Kick off the install FIRST, then connect:
      // the POST runs installer.run(), which *synchronously* resets the setup bus
      // before the request returns. Connecting only afterwards means replay-on-
      // connect can't hand us a stale `done` from a prior run (e.g. the onboarding
      // install) — which would leave `done()` already true and stop the effect
      // below from ever clearing "preparing". Replay still delivers every event of
      // THIS run, so no progress is missed. Start stays disabled until this run's
      // own `done`/`error`, so a run can never begin against a half-downloaded model.
      const ensure = await this.ipc
        .ensureProjectResources(project.id)
        .catch(() => ({ installing: false }));
      if (ensure.installing) {
        this.preparingModels.set(true);
        this.setupEvents.connect();
      }

      // Probe — surface media info, but a probe failure shouldn't strand the
      // user: they can still proceed (the pipeline re-probes as step 1).
      try {
        const info = await this.ipc.probeVideo(project.id);
        this.mediaInfo.set(info);
      } catch (probeErr) {
        this.error.set(toAppError(probeErr));
      }

      this.step.set(2);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.busy.set(false);
    }
  }

  // ----------------------------- Step 2 -----------------------------

  protected backToStep1(): void {
    this.step.set(1);
  }

  /** Start the pipeline and navigate to the processing screen. */
  protected async start(): Promise<void> {
    const id = this.createdProjectId();
    if (!id || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      // Proactive readiness gate: don't even attempt a run we know will be
      // rejected. The orchestrator enforces the same check, but surfacing it
      // here means the user sees the fix (start Ollama / pull a model / install
      // an engine pack / add a key) before anything starts. A failed preflight
      // fetch falls through to runPipeline, whose gate still protects the run.
      const preflight = await this.ipc.runPreflight(id).catch(() => null);
      const problems = preflight && !preflight.ok ? preflight.providers.filter((p) => !p.ready) : [];
      if (problems.length > 0) {
        const first = problems[0]!;
        const more = problems.length - 1;
        this.error.set({
          code: 'ENGINE_UNAVAILABLE',
          message: more > 0 ? `${first.message} (and ${more} more provider issue${more > 1 ? 's' : ''})` : first.message,
          ...(first.remediation ? { remediation: first.remediation } : {}),
        });
        this.preflightProblems.set(problems);
        return;
      }
      await this.ipc.runPipeline(id);
      await this.router.navigate(['/project', id, 'processing']);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Not-ready providers from the last preflight (for the inline "fix" affordance). */
  protected readonly preflightProblems = signal<RunPreflightProvider[]>([]);

  /** Pull the configured Ollama model on demand (lazy), then re-check + start. */
  protected async pullOllamaAndRetry(model: string): Promise<void> {
    if (this.ollamaPulling()) return;
    this.ollamaPulling.set(true);
    this.error.set(null);
    try {
      await this.ipc.pullOllamaModel(model);
      // Poll until the pull finishes (or errors), then re-run the gate.
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await this.ipc.getOllamaPullStatus(model);
        this.ollamaPullPercent.set(st.percent);
        if (st.status === 'done') break;
        if (st.status === 'error') {
          this.error.set({ code: 'ENGINE_UNAVAILABLE', message: `Pulling "${model}" failed.`, ...(st.error ? { remediation: st.error } : {}) });
          return;
        }
      }
      this.preflightProblems.set([]);
      await this.start();
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.ollamaPulling.set(false);
    }
  }

  protected readonly ollamaPulling = signal(false);
  protected readonly ollamaPullPercent = signal(0);

  /** The Ollama model to offer pulling, if a preflight problem asks for it. */
  protected ollamaPullAction(): string | null {
    const p = this.preflightProblems().find((x) => x.action?.kind === 'pull-ollama-model' && x.action?.ref);
    return p?.action?.ref ?? null;
  }

  protected dismissError(): void {
    this.error.set(null);
  }

  // ----------------------------- helpers -----------------------------

  protected resolutionLabel(info: MediaInfo): string {
    const v = info.videoStreams[0];
    return v ? `${v.width}×${v.height} @ ${v.fps.toFixed(2)} fps` : 'No video stream';
  }

  protected videoCodecLabel(info: MediaInfo): string {
    return info.videoStreams.map((v) => v.codec).join(', ') || '—';
  }

  protected audioCodecLabel(info: MediaInfo): string {
    return (
      info.audioStreams
        .map((a) => `${a.codec} ${a.channels}ch ${a.sampleRate}Hz`)
        .join(', ') || '—'
    );
  }
}

/** Best-effort project name from a file path (basename without extension). */
function deriveProjectName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const noExt = base.replace(/\.[^.]+$/, '');
  return noExt || 'Untitled project';
}
