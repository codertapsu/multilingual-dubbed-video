import type { OnDestroy, OnInit } from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { IpcService } from '../../core/ipc/ipc.service';
import { SetupEventsService } from '../../core/ipc/setup-events.service';
import { ProjectStore, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { DownloadProgressListComponent } from '../../shared/download-progress-list/download-progress-list.component';
import { BusyIndicatorComponent } from '../../shared/busy-indicator/busy-indicator.component';
import { OutputFolderComponent } from '../../shared/output-folder/output-folder.component';
import { forgetLastOutputDir, readLastOutputDir, rememberOutputDir } from '../../core/util/last-output-folder';
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
  Project,
  ProjectSettings,
  RenderQuality,
  SubtitleExportMode,
} from '../../core/models';
import type { PiperVoiceInfo, ProviderInfo, ProvidersResponse, RunPreflightProvider } from '../../core/models/setup';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { environment } from '../../core/environment';
import { describeVoice } from '../../shared/voice-library/voice-filter';
import { libraryEngineFor, voiceOptions } from '../../shared/voice-library/voice-options';

/** The speaker-detection engine pack (enginePackCatalog.ts). */
const SPEAKER_PACK = 'diarization-sherpa';
/** Music & voice separation: the HTDemucs model pack, which brings its audio.cpp runtime. */
const SEPARATION_PACK = 'separation-htdemucs';

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
    // Default to the BUNDLED 'small' model so a first dub works fully offline,
    // out of the box (the installer ships small + the en->vi Argos pair + the vi
    // voice). 'large-v3-turbo' is the higher-accuracy upgrade the user can pick
    // (it downloads ~1.6 GB) — see WHISPER_MODELS (recommended).
    sttModel: 'small',
    includeOriginalBackgroundAudio: true,
    duckOriginalAudio: true,
    duckingLevelDb: -12,
    originalAudioMode: 'keep',
    // The hardware encoder when one works here, else x264 (media-worker encoder.ts):
    // as sharp as x264 in the VMAF test and 4-5x faster on a burned-in render.
    renderQuality: 'auto',
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
  imports: [
    FormsModule,
    RouterLink,
    ErrorBannerComponent,
    DownloadProgressListComponent,
    BusyIndicatorComponent,
    OutputFolderComponent,
    TranslatePipe,
  ],
  templateUrl: './new-project-wizard.component.html',
  styleUrl: './new-project-wizard.component.scss',
})
export class NewProjectWizardComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly store = inject(ProjectStore);
  /**
   * Providers offerable in a `<select>`: available ones, PLUS whatever is
   * currently selected even if it is not available.
   *
   * A disabled row you cannot choose is noise, so unusable providers are hidden.
   * The SELECTED one is kept regardless: dropping it would make the control
   * display a different provider from the one the project is actually set to.
   */
  protected selectable(list: readonly ProviderInfo[] | undefined, current: string | undefined): ProviderInfo[] {
    return (list ?? []).filter((p) => p.available || p.id === current);
  }

  protected readonly setupEvents = inject(SetupEventsService);

  // Static label maps for the template.
  protected readonly subtitleModes = ALL_SUBTITLE_EXPORT_MODES;
  protected readonly subtitleLabels = SUBTITLE_EXPORT_MODE_LABELS;
  protected readonly subtitleHints = SUBTITLE_EXPORT_MODE_HINTS;
  protected readonly formatBytes = formatBytes;
  protected readonly formatDuration = formatDurationCoarse;
  protected readonly inTauri = this.ipc.inTauri;

  /**
   * `?source=<path>` — a file handed over from the downloader screen. Bound by
   * the router's component input binding (configured in main.ts).
   */
  readonly source = input<string | undefined>(undefined);

  // -------- form state --------
  protected readonly step = signal<WizardStep>(1);
  protected readonly name = signal('');
  protected readonly inputVideoPath = signal('');
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
  /** Packs the backend even OFFERS on this machine/OS (available = enabled +
   * platform/hardware-runnable). A feature whose pack isn't offered is HIDDEN
   * entirely, not shown as a dead "Install" hint. */
  protected readonly offeredPacks = signal<ReadonlySet<string>>(new Set<string>());
  /** Music & voice separation ("replace the voices, keep the music") is installed. */
  protected readonly vocalSeparationReady = computed(() => this.installedPacks().has(SEPARATION_PACK));
  /** WhisperX pack (forced alignment) is installed. */
  protected readonly whisperxReady = computed(() => this.installedPacks().has('alignment-whisperx'));
  /** Whether music & voice separation is offered here at all (else the option is hidden). */
  protected readonly vocalSeparationOffered = computed(() => this.offeredPacks().has(SEPARATION_PACK));
  /** Whether the WhisperX (forced alignment) feature is offered at all. */
  protected readonly whisperxOffered = computed(() => this.offeredPacks().has('alignment-whisperx'));
  /** Speaker detection (the diarization-sherpa pack): offered here / installed. */
  protected readonly speakersOffered = computed(() => this.offeredPacks().has(SPEAKER_PACK));
  protected readonly speakersReady = computed(() => this.installedPacks().has(SPEAKER_PACK));

  /** An engine being installed from the wizard (one at a time), and how far it is. */
  private readonly packInstall = signal<{ packId: string; percent: number | null } | null>(null);
  private readonly packInstallError = signal<{ packId: string; error: AppError } | null>(null);
  private readonly installState = (packId: string) => ({
    installing: computed(() => this.packInstall()?.packId === packId),
    progress: computed(() => (this.packInstall()?.packId === packId ? this.packInstall()!.percent : null)),
    error: computed(() => (this.packInstallError()?.packId === packId ? this.packInstallError()!.error : null)),
  });
  private readonly speakerInstall = this.installState(SPEAKER_PACK);
  protected readonly speakersInstalling = this.speakerInstall.installing;
  protected readonly speakersProgress = this.speakerInstall.progress;
  protected readonly speakersError = this.speakerInstall.error;
  private readonly separationInstall = this.installState(SEPARATION_PACK);
  protected readonly separationInstalling = this.separationInstall.installing;
  protected readonly separationProgress = this.separationInstall.progress;
  protected readonly separationError = this.separationInstall.error;

  /** Install speaker detection from the wizard (a small download), then tick it. */
  protected installSpeakers(): void {
    void this.installPack(SPEAKER_PACK, () => {
      if (this.speakersReady()) this.patchSettings('diarize', true);
    });
  }

  /** Install music & voice separation (the model and the runtime it needs), then choose it. */
  protected installSeparation(): void {
    void this.installPack(SEPARATION_PACK, () => {
      if (this.vocalSeparationReady()) this.setOriginalAudioMode('replace-vocals');
    });
  }

  /**
   * Install an engine pack from the wizard, following /engines/events for its
   * progress and outcome, and for every pack the install started with it (a
   * model brings its runtime); then refresh what is installed.
   */
  private async installPack(packId: string, then: () => void): Promise<void> {
    if (this.packInstall()) return;
    this.packInstall.set({ packId, percent: null });
    this.packInstallError.set(null);
    // Listen before asking: the install's events must not be missed.
    const es = environment.orchestratorUrl ? new EventSource(`${environment.orchestratorUrl}/engines/events`) : null;
    const waiting = new Set([packId]);
    let resolveAll: (ok: boolean) => void = () => undefined;
    const outcome = new Promise<boolean>((resolve) => (resolveAll = resolve));
    if (es) {
      es.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data as string) as { type: string; packId?: string; percent?: number | null; error?: AppError };
          if (!e.packId || !waiting.has(e.packId)) return;
          if (e.type === 'progress' && e.packId === packId) this.packInstall.set({ packId, percent: e.percent ?? null });
          else if (e.type === 'done') {
            waiting.delete(e.packId);
            if (waiting.size === 0) resolveAll(true);
          } else if (e.type === 'error') {
            this.packInstallError.set({ packId, error: e.error ?? { code: 'ENGINE_PACK_FAILED', message: 'Install failed.' } });
            resolveAll(false);
          }
        } catch {
          /* not an install event */
        }
      };
    } else {
      resolveAll(false);
    }
    try {
      const res = await this.ipc.installEngine(packId);
      for (const other of res.alsoInstalling ?? []) waiting.add(other);
      if (await outcome) {
        const engines = await this.ipc.getEngines().catch(() => null);
        if (engines) this.installedPacks.set(new Set(engines.installed.map((p) => p.id)));
        then();
      }
    } catch (err) {
      this.packInstallError.set({ packId, error: err as AppError });
    } finally {
      es?.close();
      this.packInstall.set(null);
    }
  }

  /**
   * Phases currently routed to a cloud provider (drives the privacy note).
   *
   * Each phase resolves to a translated sentence naming WHAT leaves the
   * machine. This is the app's only data-egress disclosure, and it shipped as
   * English literals interpolated into an otherwise-translated warning — the
   * one string a user must understand before their audio is uploaded.
   */
  protected readonly cloudPhases = computed(() => {
    const provs = this.providers();
    const s = this.settings();
    if (!provs) return [] as string[];
    const find = (list: ProviderInfo[], id: string) => list.find((p) => p.id === id);
    const t = (key: string) => this.translate.instant(key);
    const phases: string[] = [];
    if (find(provs.stt, s.sttProviderId)?.isLocal === false) phases.push(t('wizard.cloud-phase.stt'));
    if (find(provs.translation, s.translationProviderId)?.isLocal === false)
      phases.push(t('wizard.cloud-phase.translation'));
    if (s.refineProviderId && find(provs.translation, s.refineProviderId)?.isLocal === false)
      phases.push(t('wizard.cloud-phase.refine'));
    if (find(provs.tts, s.ttsProviderId)?.isLocal === false) phases.push(t('wizard.cloud-phase.tts'));
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

  /** Show the voice picker for Piper, a VieNeu engine, or any engine of the voice library. */
  protected readonly showVoicePicker = computed(() => this.voiceEngine() !== null || this.libraryEngine() !== null);

  /** Engines whose voices come from the voice library (VieNeu 3.8, ZeroTTS, Kokoro, Supertonic). */
  protected readonly libraryEngine = computed(() => libraryEngineFor(this.settings().ttsProviderId));

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
  /** The project step 2 shows (its "Save to" folder changes it in place). */
  protected readonly createdProject = signal<Project | null>(null);
  /** The folder remembered from the last project could not be used for this one. */
  protected readonly outputFolderFallback = signal<string | null>(null);
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
    // A video handed over from the downloader arrives as ?source=<path>, so the
    // wizard opens with step 1 already filled in.
    const handedOver = this.source();
    if (handedOver) this.onPathInput(handedOver);

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
      const s0 = this.settings();
      const [provs, prefs, engines, recommended] = await Promise.all([
        this.ipc.getProviders(),
        this.ipc.getAppPreferences(),
        this.ipc.getEngines().catch(() => null),
        // The orchestrator decides the engines (projectDefaults.ts): saved
        // choices where usable, else the best INSTALLED engines. Before this,
        // a user who installed the recommended GPU engines still dubbed on the
        // CPU unless they also changed their Settings defaults.
        this.ipc.getProjectDefaults(s0.sourceLanguage, s0.targetLanguage).catch(() => null),
      ]);
      this.providers.set(provs);
      if (engines) {
        this.installedPacks.set(new Set(engines.installed.map((p) => p.id)));
        this.offeredPacks.set(new Set(engines.available.map((p) => p.id)));
        this.resetUnavailableFeatureToggles();
      }
      if (recommended) {
        const r = recommended.settings;
        this.settings.update((s) => ({
          ...s,
          sttProviderId: r.sttProviderId,
          sttModel: r.sttModel ?? s.sttModel,
          translationProviderId: r.translationProviderId,
          refineProviderId: r.refineProviderId,
          ttsProviderId: r.ttsProviderId,
          autoSelectedPhases: r.autoSelectedPhases,
        }));
        this.syncProcessingMode();
        this.applyVietnameseNeuralDefault();
        return;
      }
      // Older orchestrator (no /project-defaults): the saved defaults alone.
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
   * Prefer a VieNeu neural engine for Vietnamese dubbing — but only when its
   * engine pack is already installed, so a first-run user isn't forced into a
   * download to dub Vietnamese (Piper stays the safe out-of-box default; they
   * can install VieNeu to upgrade). Only nudges when the user hasn't otherwise
   * chosen a TTS engine.
   */
  private applyVietnameseNeuralDefault(): void {
    const provs = this.providers();
    const s = this.settings();
    if (!provs) return;
    if ((s.targetLanguage.split('-')[0] ?? '').toLowerCase() !== 'vi') return;
    if (s.ttsProviderId !== 'piper-local') return; // respect an explicit choice
    const engine = preferredVietnameseNeuralEngine(provs.tts);
    if (engine) {
      this.patchSettings('ttsProviderId', engine);
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
      // WhisperX pack, so it stays enabled. Speaker detection would be a no-op
      // (the run only warns), so it is off until its pack is installed.
      if (!this.speakersReady()) {
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
        this.name.set(deriveProjectName(picked) || this.translate.instant('misc.untitled-project'));
      }
    }
  }

  protected onPathInput(value: string): void {
    this.inputVideoPath.set(value);
    if (!this.name().trim() && value.trim()) {
      this.name.set(deriveProjectName(value) || this.translate.instant('misc.untitled-project'));
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

  /** "Number of speakers": 0 = let detection decide. */
  protected readonly speakerCounts = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
  protected setSpeakerCount(n: number): void {
    this.patchSettings('diarizeSpeakers', n >= 2 ? n : undefined);
  }

  /** Background attenuation choices while the dubbed voice speaks. */
  protected readonly duckingOptions: ReadonlyArray<{ value: number; label: string }> = [
    { value: -6, label: 'ducking-hint.subtle' },
    { value: -12, label: 'ducking-hint.standard' },
    { value: -18, label: 'ducking-hint.strong' },
    { value: -24, label: 'ducking-hint.very-strong' },
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
    { value: 1.3, label: 'opt.speed.1-3', hint: 'speed-hint.1-3' },
    { value: 1.6, label: 'opt.speed.1-6', hint: 'speed-hint.1-6' },
    { value: 1.8, label: 'opt.speed.1-8', hint: 'speed-hint.1-8' },
    { value: 2.0, label: 'opt.speed.2-0', hint: 'speed-hint.2-0' },
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
    // The user picked this engine: it is no longer the app's choice, so a run
    // must fail loudly rather than fall back from it.
    const phase = key === 'sttProviderId' ? 'stt' : key === 'translationProviderId' ? 'translation' : 'tts';
    const auto = (this.settings().autoSelectedPhases ?? []).filter((p) => p !== phase);
    this.patchSettings('autoSelectedPhases', auto.length > 0 ? auto : undefined);
    this.syncProcessingMode();
    // Switching the TTS engine to Piper or a VieNeu engine reveals the per-language
    // voice picker — populate it (with the right voice catalog) for the target.
    if (key === 'ttsProviderId' && this.voiceEngine() !== null) {
      void this.loadVoicesForTarget();
    }
  }

  /** Translation providers able to run the optional review-and-refine pass. */
  protected refinerOptions(provs: ProvidersResponse): ProviderInfo[] {
    return provs.translation.filter((p) => p.supportsRefinement === true);
  }

  /** Change (or clear) the optional refine provider. */
  protected setRefineProvider(providerId: string): void {
    this.patchSettings('refineProviderId', providerId === 'none' ? undefined : providerId);
    this.syncProcessingMode();
  }

  /** Target language changed — re-patch and reload the per-language voices. */
  protected setTargetLanguage(code: LanguageCode): void {
    this.patchSettings('targetLanguage', code);
    // Switching to Vietnamese prefers a VieNeu engine (if its pack is installed).
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
    const libraryEngine = this.libraryEngine();
    if (!engine && !libraryEngine) return;
    this.voicesLoading.set(true);
    try {
      const [voices, status] = await Promise.all([
        libraryEngine
          ? this.ipc
              .voiceLibrary()
              .then((lib) =>
                voiceOptions(lib.voices, libraryEngine, language, (v) => describeVoice(v, (k) => this.translate.instant(k))),
              )
          : this.ipc.setupListVoices(language, engine!),
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

  /**
   * Why an unavailable provider can't be picked (shown after its name).
   *
   * These were English template literals appended to every `<option>` in the
   * four engine `<select>`s — so the one sentence that explains why a user
   * cannot choose an engine was unreadable to the default (Vietnamese)
   * audience. Resolved here rather than returned as a key because the value is
   * concatenated into the option's text, not piped.
   */
  protected providerHint(p: ProviderInfo): string {
    if (p.available) return '';
    switch (p.readinessStatus) {
      case 'engine-pack-missing':
        return this.translate.instant('wizard.provider-hint.engine-pack-missing');
      case 'cloud-key-missing':
        return this.translate.instant('wizard.provider-hint.cloud-key-missing');
      case 'daemon-unreachable':
        return this.translate.instant('wizard.provider-hint.daemon-unreachable');
      case 'model-missing':
        return this.translate.instant('wizard.provider-hint.model-missing');
      case 'worker-loading':
        return this.translate.instant('wizard.provider-hint.worker-loading');
      default:
        return this.translate.instant('wizard.provider-hint.unavailable');
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
        name:
          this.name().trim() ||
          deriveProjectName(this.inputVideoPath()) ||
          this.translate.instant('misc.untitled-project'),
        inputVideoPath: this.inputVideoPath().trim(),
        settings: this.settings(),
      };
      const project = await this.createWithLastFolder(input);
      this.createdProjectId.set(project.id);
      this.createdProject.set(project);
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

  /**
   * Create the project in the folder the last one was saved to. That folder
   * may be gone since (an unplugged drive): then the project is created in
   * the default folder rather than not at all, step 2 says why, and the
   * folder is no longer offered.
   */
  private async createWithLastFolder(input: CreateProjectInput): Promise<Project> {
    this.outputFolderFallback.set(null);
    const last = readLastOutputDir();
    if (!last) return this.ipc.createProject(input);
    try {
      return await this.ipc.createProject({ ...input, outputDir: last });
    } catch (err) {
      if (toAppError(err).code !== 'OUTPUT_NOT_WRITABLE') throw err;
      forgetLastOutputDir();
      this.outputFolderFallback.set(last);
      return this.ipc.createProject(input);
    }
  }

  /** "Save to" changed on step 2: show it, and offer it to the next project. */
  protected onOutputFolderChanged(project: Project): void {
    this.createdProject.set(project);
    this.store.setCurrent(project);
    this.outputFolderFallback.set(null);
    rememberOutputDir(project);
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
          message:
            more > 0
              ? this.translate.instant('wizard.preflight-and-more', {
                  message: first.message,
                  more,
                })
              : first.message,
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
          this.error.set({
            code: 'ENGINE_UNAVAILABLE',
            message: this.translate.instant('wizard.pull-failed', { model }),
            ...(st.error ? { remediation: st.error } : {}),
          });
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
    return v ? `${v.width}×${v.height} @ ${v.fps.toFixed(2)} fps` : this.translate.instant('misc.no-video-stream');
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

/**
 * VieNeu engine ids, best-first: v3 (`neural-tts`) is the shipped Apache-2.0
 * engine and is registered unconditionally; v2 is the legacy pack.
 *
 * This list used to be just `['neural-tts-v2']`, and `tts-neural-v2` is in the
 * orchestrator's DISABLED_PACK_IDS — so its provider is never registered and
 * the auto-default could never fire. A user who followed the docs and installed
 * the neural Vietnamese voice still got Piper, silently, and the per-voice RNG
 * pinning that only applies to VieNeu never took effect. Order matters: v3 must
 * be checked first so a machine with BOTH installed gets the newer engine.
 */
const VIETNAMESE_NEURAL_ENGINE_IDS = ['vieneu-tts', 'neural-tts', 'neural-tts-v2'] as const;

/**
 * The best available VieNeu engine for Vietnamese, or null when none is
 * installed. Pure so the preference order can be reasoned about (and tested)
 * without a component.
 */
export function preferredVietnameseNeuralEngine(
  tts: readonly ProviderInfo[],
): string | null {
  for (const id of VIETNAMESE_NEURAL_ENGINE_IDS) {
    if (tts.find((p) => p.id === id)?.available) return id;
  }
  return null;
}

/** Best-effort project name from a file path (basename without extension). */
function deriveProjectName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const noExt = base.replace(/\.[^.]+$/, '');
  return noExt || '';
}
