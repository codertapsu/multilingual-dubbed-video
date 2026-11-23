import type { OnDestroy, OnInit } from '@angular/core';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injector,
  input,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { ActivityService, type ActivityTask } from '../../core/activity/activity.service';
import type { LeaveWhileBusy } from '../../core/guards/leave-while-busy.guard';
import { IpcService } from '../../core/ipc/ipc.service';
import { defaultSeriesAi, rememberSeriesAi } from '../../shared/series-ai';
import { SetupEventsService } from '../../core/ipc/setup-events.service';
import {
  NewProjectDraftService,
  type DraftSeries,
  type DraftSeriesLength,
  type NewProjectDraft,
} from '../../core/state/new-project-draft.service';
import { ProjectStore, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { DownloadProgressListComponent } from '../../shared/download-progress-list/download-progress-list.component';
import { BusyIndicatorComponent } from '../../shared/busy-indicator/busy-indicator.component';
import { OutputFolderComponent } from '../../shared/output-folder/output-folder.component';
import { forgetLastOutputDir, readLastOutputDir, rememberOutputDir } from '../../core/util/last-output-folder';
import { spotCheckApplies, spotCheckOn } from '../../core/util/source-checks';
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
  VoiceLibraryItem,
} from '../../core/models';
import type { PiperVoiceInfo, ProviderInfo, ProvidersResponse, RunPreflightProvider } from '../../core/models/setup';
import type { DubPreset } from '../../core/models/download';
import type { BrandAsset, SeriesAiOption } from '@videodubber/shared';
import { BrandingFormComponent } from '../../shared/branding/branding-form.component';
import { ConfirmService } from '../../shared/confirm-dialog/confirm.service';
import { LanguageNamePipe, TranslatePipe, TranslateService, languageName } from '../../core/i18n';
import { baseLanguage, describeVoice } from '../../shared/voice-library/voice-filter';
import { keptVoice, libraryEngineFor, voiceOptions } from '../../shared/voice-library/voice-options';
import { previewSource, sampleSentence } from '../../shared/voice-library/voice-preview';
import { describeStartProblem, packSizeLabel, type ChangeTarget, type StartFix } from './start-problems';
import {
  DEFAULT_SERIES,
  continueBlocker,
  draftOf,
  draftOnLeave,
  draftSnapshot,
  leaveWarningFor,
  seriesRequestOf,
  type LeaveWarning,
} from './wizard-form';

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
 *
 * Step 1 asks for the video and the languages; everything else waits under
 * "More options", every choice still there with its explanation. Encoders,
 * NVENC and "LLM translators" around the file picker made the first screen a
 * new user sees read like a settings page (UX audit, 2026-11-21).
 */
@Component({
  selector: 'vd-new-project-wizard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    LanguageNamePipe,
    FormsModule,
    NgTemplateOutlet,
    RouterLink,
    ErrorBannerComponent,
    DownloadProgressListComponent,
    BusyIndicatorComponent,
    OutputFolderComponent,
    TranslatePipe,
    BrandingFormComponent,
  ],
  templateUrl: './new-project-wizard.component.html',
  styleUrl: './new-project-wizard.component.scss',
})
export class NewProjectWizardComponent implements OnInit, OnDestroy, LeaveWhileBusy {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);
  private readonly store = inject(ProjectStore);
  private readonly drafts = inject(NewProjectDraftService);
  private readonly injector = inject(Injector);
  /** Installs and downloads, followed for the whole app (core/activity). */
  protected readonly activity = inject(ActivityService);

  /**
   * The screen was closed. Work it started goes on (a copy, a download), but
   * nothing it does afterwards may act as if the user were still here: an
   * Ollama download finishing used to navigate them to the dub's screen from
   * wherever they had gone.
   */
  private destroyed = false;
  /** The form itself is taking the user to the dub's screen: nothing to ask. */
  private leavingOnPurpose = false;
  /** The user followed the form's own link from step 2 (Add key) and will come back. */
  private returning = false;
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

  /** Names and sizes of the engine packs offered here (for Install buttons). */
  private readonly packCatalog = signal<ReadonlyMap<string, { name: string; sizeMb: number }>>(new Map());

  /**
   * An engine pack's install, as the app-wide activity service follows it.
   *
   * The form used to open an /engines/events stream of its own for one install
   * at a time: a second Install did nothing at all, a dropped stream left
   * "Installing…" up for good, an unknown percent read "0%", and leaving the
   * screen lost the progress. The service follows every install wherever the
   * user is, so each button reads its own pack's state from it.
   */
  private readonly installState = (packId: string) => ({
    installing: computed(() => this.activity.engine(packId)?.state === 'running'),
    progress: computed(() => {
      const task = this.activity.engine(packId);
      return task?.state === 'running' ? task.percent : null;
    }),
    error: computed(() => {
      const task = this.activity.engine(packId);
      return task?.state === 'failed' ? { message: task.error?.message ?? '' } : null;
    }),
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
   * What to do once a pack installed from this form is ready (tick the option
   * it was installed for), and the packs its install started with it (a model
   * brings its runtime): the option is ticked when all of them are done.
   */
  private readonly afterInstall = new Map<string, { companions: string[]; then: () => void }>();

  /**
   * Install an engine pack from the form. The click is answered at once
   * (markStarting), progress and the outcome come from the activity service,
   * and a refused start is shown as a failed install beside its button.
   */
  private async installPack(packId: string, then: () => void = () => undefined): Promise<void> {
    if (this.activity.engine(packId)?.state === 'running') return;
    this.afterInstall.set(packId, { companions: [], then });
    this.activity.markStarting('engine', packId, this.packCatalog().get(packId)?.name);
    try {
      const res = await this.ipc.installEngine(packId);
      const pending = this.afterInstall.get(packId);
      if (pending) pending.companions = res.alsoInstalling ?? [];
    } catch (err) {
      this.afterInstall.delete(packId);
      this.activity.markFailed('engine', packId, toAppError(err));
    }
  }

  /** The value of `activity.engineChanges` already acted on. */
  private engineChangesSeen = this.activity.engineChanges();

  /**
   * An install ended (here or anywhere in the app): read what is installed
   * now, tick the options whose packs are ready, and check Start's problems
   * again, so a fixed one disappears without another click.
   */
  private readonly _onEngineChange = effect(() => {
    const n = this.activity.engineChanges();
    if (n === this.engineChangesSeen) return;
    this.engineChangesSeen = n;
    untracked(() => void this.afterEngineChange());
  });

  private async afterEngineChange(): Promise<void> {
    const engines = await this.ipc.getEngines().catch(() => null);
    if (this.destroyed) return;
    if (engines) this.installedPacks.set(new Set(engines.installed.map((p) => p.id)));
    for (const [packId, pending] of [...this.afterInstall]) {
      if (this.activity.engine(packId)?.state === 'failed') {
        this.afterInstall.delete(packId);
        continue;
      }
      const busy = [packId, ...pending.companions].some((id) => this.activity.engine(id)?.state === 'running');
      if (!busy && this.installedPacks().has(packId)) {
        this.afterInstall.delete(packId);
        pending.then();
      }
    }
    if (this.preflightProblems().length > 0) await this.refreshPreflight();
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
  /** The Piper voice downloading on select, if any. */
  private readonly voiceDownloadId = signal<string | null>(null);
  /** True while a selected voice downloads on demand. */
  protected readonly voiceDownloading = computed(() => this.voiceDownloadId() !== null);
  /** Download percent of the in-flight voice (0..100, or null = indeterminate). */
  protected readonly voiceDownloadPercent = computed(() => {
    const id = this.voiceDownloadId();
    return id ? (this.activity.setupItem(`piper:${id}`)?.percent ?? null) : null;
  });
  /**
   * A voice that could not be downloaded or heard, shown under the voice
   * picker. These went to the banner at the top of the form, a long scroll
   * away from the control the user had just used.
   */
  protected readonly voiceError = signal<AppError | null>(null);

  /**
   * The voice download ended. The activity service follows /setup/events for
   * the whole app; this form polled a stream of its own every half second,
   * which never stopped once the screen closed.
   */
  private readonly _onVoiceDownload = effect(() => {
    const id = this.voiceDownloadId();
    const task = id ? this.activity.setupItem(`piper:${id}`) : undefined;
    if (!id || !task || task.state === 'running') return;
    untracked(() => {
      this.voiceDownloadId.set(null);
      if (task.state === 'done') this.installedVoiceIds.update((s) => new Set(s).add(id));
      else this.voiceError.set(task.error ?? { code: 'UNKNOWN', message: task.message });
    });
  });

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

  // -------- listening to the chosen voice --------
  // Hearing a voice meant leaving for the Voices screen, which emptied this form.

  /** Every voice of the library: what each one can play (a sample, or itself). */
  private readonly libraryVoices = signal<VoiceLibraryItem[]>([]);
  protected readonly selectedVoiceItem = computed(() => {
    const id = this.settings().ttsVoiceId;
    return id ? this.libraryVoices().find((v) => v.id === id) : undefined;
  });
  /** How the chosen voice can be heard ('speak': it says a sentence; null: no way yet). */
  protected readonly selectedVoicePreview = computed(() => previewSource(this.selectedVoiceItem()));
  protected readonly preview = signal<'idle' | 'loading' | 'playing'>('idle');
  protected readonly previewFailed = signal(false);
  private previewAudio: HTMLAudioElement | null = null;
  private previewObjectUrl: string | null = null;
  /** Bumped by every new preview or stop, so a slow one never plays over its successor. */
  private previewSeq = 0;

  /**
   * The Voices screen link: it opens on the voices this dub can use (the target
   * language) and shows the way back here. The engine is not filtered: the link
   * promises every voice, and a voice of another engine is one engine change away.
   */
  protected readonly voicesLink = computed(() => ({
    from: 'new-project',
    language: baseLanguage(this.settings().targetLanguage),
  }));

  // -------- async state --------
  protected readonly busy = signal(false);

  /**
   * The models the project's languages need, on step 2: being fetched, there,
   * or failed. A failed download used to be invisible: the progress list just
   * disappeared and Start turned on, and a refused start of the download was
   * swallowed whole (UX audit, 2026-11-21). Now a failure stays on screen with
   * Retry, and Start waits until the models are there.
   */
  protected readonly prepare = signal<'ready' | 'running' | 'failed'>('ready');
  protected readonly prepareError = signal<AppError | null>(null);
  protected readonly preparingModels = computed(() => this.prepare() === 'running');

  /** This run of the model download ended (its own done or error, replayed on connect). */
  private readonly _followPrepare = effect(() => {
    const done = this.setupEvents.done();
    const error = this.setupEvents.error();
    untracked(() => {
      if (this.prepare() !== 'running' || (!done && !error)) return;
      this.setupEvents.disconnect();
      if (error) {
        this.prepareError.set(error);
        this.prepare.set('failed');
      } else {
        this.prepare.set('ready');
      }
    });
  });
  protected readonly error = signal<AppError | null>(null);
  protected readonly createdProjectId = signal<string | null>(null);
  /** The project step 2 shows (its "Save to" folder changes it in place). */
  protected readonly createdProject = signal<Project | null>(null);
  /** The folder remembered from the last project could not be used for this one. */
  protected readonly outputFolderFallback = signal<string | null>(null);
  protected readonly mediaInfo = signal<MediaInfo | null>(null);
  /** The transcript spot check (core/util/source-checks.ts): CJK speech only; on by default above 2 hours. */
  protected readonly spotCheckOffered = computed(() => spotCheckApplies(this.settings().sourceLanguage));
  protected readonly spotCheck = computed(() => spotCheckOn(this.settings().transcriptSpotCheck, this.mediaInfo()?.durationMs));

  /** Step 1 is valid once we have a video path and distinct languages. */
  protected readonly step1Valid = computed(() => {
    const s = this.settings();
    return (
      this.inputVideoPath().trim().length > 0 &&
      s.sourceLanguage.length > 0 &&
      s.targetLanguage.length > 0
    );
  });

  /** Why Continue is not available yet, said beside it (null: it is). */
  protected readonly continueBlocker = computed(() =>
    continueBlocker({
      videoPath: this.inputVideoPath(),
      sourceLanguage: this.settings().sourceLanguage,
      targetLanguage: this.settings().targetLanguage,
      voiceDownloading: this.voiceDownloading(),
    }),
  );

  /** "More options" is open. Closed on a new form; kept with the draft. */
  protected readonly moreOpen = signal(false);

  protected onMoreToggle(event: Event): void {
    this.moreOpen.set((event.target as HTMLDetailsElement).open);
  }

  /** True when the probed media has no audio stream (we must warn loudly). */
  protected readonly noAudioWarning = computed(() => {
    const info = this.mediaInfo();
    return info ? !info.hasAudio || info.audioStreams.length === 0 : false;
  });

  ngOnInit(): void {
    // Back from another screen (the Voices screen, Settings…): the form as it was left.
    void this.open(this.drafts.take());
  }

  /**
   * Open the form, as it was left when there is a draft, else fresh. A draft
   * tied to a project Continue made comes back only while that project still
   * waits to start: once it was started (from Projects) or deleted, the draft
   * is history and the form starts afresh, since it would otherwise make a
   * second project of the same video.
   */
  private async open(draft: NewProjectDraft | null): Promise<void> {
    // A video handed over from the downloader arrives as ?source=<path>, so the
    // wizard opens with step 1 already filled in. It is a new video: the name
    // follows it, the rest of a kept draft stays, and it makes a new project.
    const handedOver = this.source();
    let kept = draft;
    let project: Project | null = null;
    if (kept?.created && !handedOver) {
      project = await this.waitingProject(kept.created.projectId);
      if (this.destroyed) {
        // Closed before it opened: the draft is still the user's.
        this.drafts.save(kept);
        return;
      }
      if (!project) kept = null;
    }
    if (kept) this.restoreDraft(kept, project);
    if (handedOver) {
      this.name.set('');
      this.onPathInput(handedOver);
    }

    void this.loadLanguages();
    void this.init(kept !== null);
    void this.loadPresets();
    void this.ipc.listBrandKit().then((a) => this.brandAssets.set(a), () => undefined);
    void this.loadSeriesAi();
  }

  /** The project, while it still waits to start (null: started, deleted or unreachable). */
  private async waitingProject(projectId: string): Promise<Project | null> {
    try {
      const { project } = await this.ipc.getProject(projectId);
      return project.status === 'created' ? project : null;
    } catch {
      return null;
    }
  }

  /** The brand kit's logos and greetings, for the Logo & greeting section. */
  protected readonly brandAssets = signal<BrandAsset[]>([]);

  // ---- Split into parts (series/) ----------------------------------------
  protected readonly seriesAiOptions = signal<SeriesAiOption[]>([]);
  protected readonly seriesAiReady = computed(() => this.seriesAiOptions().filter((o) => o.ready));
  protected readonly splitSeries = signal(DEFAULT_SERIES.split);
  protected readonly seriesLength = signal<DraftSeriesLength>(DEFAULT_SERIES.length);
  protected readonly seriesMin = signal(DEFAULT_SERIES.min);
  protected readonly seriesMax = signal(DEFAULT_SERIES.max);
  protected readonly seriesAi = signal(DEFAULT_SERIES.ai);
  protected readonly seriesRecap = signal(DEFAULT_SERIES.recapSec);
  protected readonly seriesAuto = signal(DEFAULT_SERIES.autoStart);

  private async loadSeriesAi(): Promise<void> {
    try {
      const options = await this.ipc.seriesAiOptions();
      this.seriesAiOptions.set(options);
      // The AI the form already had (a kept draft) while it is still set up;
      // else the one used last time, else Claude through Mother Claude, else
      // the first set up.
      const had = this.seriesAi();
      this.seriesAi.set(had && options.some((o) => o.ready && o.id === had) ? had : defaultSeriesAi(options));
    } catch {
      /* no AI: the option says how to set one up */
    }
  }

  /** "Split into parts" as the form holds it (also what the draft keeps). */
  private seriesState(): DraftSeries {
    return {
      split: this.splitSeries(),
      length: this.seriesLength(),
      min: this.seriesMin(),
      max: this.seriesMax(),
      ai: this.seriesAi(),
      recapSec: this.seriesRecap(),
      autoStart: this.seriesAuto(),
    };
  }

  private setSeries(s: DraftSeries): void {
    this.splitSeries.set(s.split);
    this.seriesLength.set(s.length);
    this.seriesMin.set(s.min);
    this.seriesMax.set(s.max);
    this.seriesAi.set(s.ai);
    this.seriesRecap.set(s.recapSec);
    this.seriesAuto.set(s.autoStart);
  }

  /** The series settings the form asks for, or undefined when not splitting. */
  private seriesRequest(): CreateProjectInput['series'] | undefined {
    return seriesRequestOf(this.seriesState());
  }

  // ---- presets ("Mẫu lồng tiếng", workspace/presetStore.ts) ----------------
  protected readonly presets = signal<DubPreset[]>([]);
  protected readonly presetId = signal('');
  protected readonly presetName = signal('');
  protected readonly savingPreset = signal(false);
  protected readonly presetNotice = signal<string | null>(null);
  /** Where the chosen preset saves finished files (else the last folder used). */
  private readonly presetOutputDir = signal<string | undefined>(undefined);
  /** The folder a preset saved from this form would keep. */
  protected readonly presetFolder = computed(() => this.presetOutputDir() ?? readLastOutputDir() ?? null);

  /**
   * Presets are among the first questions when the form opens with some to
   * pick (they fill in the languages); else they wait under More options.
   * Decided once, so saving the first preset does not move the section away
   * from under the user's pointer.
   */
  protected readonly presetsUpFront = signal(false);
  private presetsLoaded = false;

  private async loadPresets(): Promise<void> {
    try {
      this.presets.set(await this.ipc.listPresets());
      if (!this.presetsLoaded) this.presetsUpFront.set(this.presets().length > 0);
      this.presetsLoaded = true;
    } catch {
      /* no presets: the row offers only "Save as preset" */
    }
  }

  /** Fill the form from a preset: its languages and choices over the form as it is. */
  protected applyPreset(id: string): void {
    this.presetId.set(id);
    this.presetNotice.set(null);
    const preset = this.presets().find((p) => p.id === id);
    if (!preset) {
      this.presetOutputDir.set(undefined);
      return;
    }
    this.settings.update((s) => ({
      ...s,
      ...preset.settings,
      sourceLanguage: preset.sourceLanguage ?? '',
      targetLanguage: preset.targetLanguage,
    }));
    this.presetOutputDir.set(preset.outputDir);
    this.presetName.set(preset.name);
    this.syncProcessingMode();
    this.stopPreview();
    void this.loadVoicesForTarget();
  }

  /** Save the form's choices as a preset; the same name replaces that preset. */
  protected async savePreset(): Promise<void> {
    const name = this.presetName().trim();
    if (!name || this.savingPreset()) return;
    this.savingPreset.set(true);
    this.presetNotice.set(null);
    try {
      const { sourceLanguage, targetLanguage, ...choices } = this.settings();
      const same = this.presets().find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
      const folder = this.presetFolder();
      const saved = await this.ipc.savePreset(
        { name, targetLanguage, sourceLanguage, settings: choices, ...(folder ? { outputDir: folder } : {}) },
        same?.id,
      );
      await this.loadPresets();
      this.presetId.set(saved.id);
      this.presetNotice.set(this.translate.instant('wizard.preset-saved', { name }));
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.savingPreset.set(false);
    }
  }

  protected async deletePreset(): Promise<void> {
    const preset = this.presets().find((p) => p.id === this.presetId());
    if (!preset) return;
    const ok = await this.confirm.confirm({
      title: this.translate.instant('wizard.preset-delete-title', { name: preset.name }),
      message: this.translate.instant('wizard.preset-delete-body'),
      confirmLabel: this.translate.instant('wizard.preset-delete'),
    });
    if (!ok) return;
    try {
      await this.ipc.deletePreset(preset.id);
      this.presetId.set('');
      this.presetOutputDir.set(undefined);
      await this.loadPresets();
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    // Stop listening to the global setup stream when leaving the wizard.
    this.setupEvents.disconnect();
    this.stopPreview();
    this.keepDraft();
  }

  /**
   * The form as the defaults left it, to tell a form the user touched from an
   * untouched one (only a touched one is kept). Null after restoring a draft:
   * that form is the user's already, so it is kept again on leaving.
   */
  private pristine: string | null = null;
  /** Defaults applied: before that, the form holds nothing of the user's or the app's. */
  private initialized = false;

  /** Everything the form holds, as the draft keeps it. */
  private currentDraft(): NewProjectDraft {
    return draftOf({
      name: this.name(),
      autoName: this.autoName,
      inputVideoPath: this.inputVideoPath(),
      settings: this.settings(),
      series: this.seriesState(),
      presetId: this.presetId(),
      presetName: this.presetName(),
      presetOutputDir: this.presetOutputDir(),
      moreOptions: this.moreOpen(),
      step: this.step(),
      projectId: this.createdProjectId(),
      createdFromVideo: this.createdFromVideo,
    });
  }

  /** Put a kept draft back; `project` is the one Continue made from it, still waiting to start. */
  private restoreDraft(draft: NewProjectDraft, project: Project | null): void {
    this.name.set(draft.name);
    this.autoName = draft.autoName;
    this.inputVideoPath.set(draft.inputVideoPath);
    this.settings.set(draft.settings);
    this.setSeries(draft.series);
    this.presetId.set(draft.preset.id);
    this.presetName.set(draft.preset.name);
    this.presetOutputDir.set(draft.preset.outputDir);
    this.moreOpen.set(draft.moreOptions);
    if (!project || !draft.created) return;
    // Continue revises this project rather than making a second one.
    this.createdProjectId.set(project.id);
    this.createdProject.set(project);
    this.createdFromVideo = draft.created.fromVideo;
    this.store.setCurrent(project);
    if (draft.created.step === 2) {
      // Back from fixing what stopped Start (Add key): on the step it was left on.
      this.mediaInfo.set(project.mediaInfo ?? null);
      this.step.set(2);
      void this.prepareModels(project.id);
      void this.refreshPreflight();
    }
  }

  /** Keep, forget or leave the draft as the user leaves (see draftOnLeave). */
  private keepDraft(): void {
    const draft = this.currentDraft();
    const decision = draftOnLeave({
      initialized: this.initialized,
      step: this.step(),
      creating: this.busy() && this.step() === 1,
      createdProjectId: this.createdProjectId(),
      touched: this.pristine === null || draftSnapshot(draft) !== this.pristine,
      returning: this.returning,
    });
    if (decision === 'keep') this.drafts.save(draft);
    else if (decision === 'forget') this.drafts.clear();
  }

  /**
   * Load the provider catalog + saved defaults, then the per-language voices.
   * A restored draft keeps its own engines: the defaults would overwrite the
   * choices the user made before leaving.
   */
  private async init(restored: boolean): Promise<void> {
    await this.loadProvidersAndDefaults(restored);
    await this.loadVoicesForTarget();
    this.initialized = true;
    if (!restored) this.pristine = draftSnapshot(this.currentDraft());
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
  private async loadProvidersAndDefaults(restored = false): Promise<void> {
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
        restored ? Promise.resolve(null) : this.ipc.getProjectDefaults(s0.sourceLanguage, s0.targetLanguage).catch(() => null),
      ]);
      this.providers.set(provs);
      if (engines) {
        this.installedPacks.set(new Set(engines.installed.map((p) => p.id)));
        this.offeredPacks.set(new Set(engines.available.map((p) => p.id)));
        this.packCatalog.set(new Map(engines.available.map((p) => [p.id, { name: p.displayName, sizeMb: p.approxSizeMb }])));
        this.resetUnavailableFeatureToggles();
      }
      if (restored) {
        // The user's own engines, as left; only the derived mode is refreshed.
        this.syncProcessingMode();
        return;
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
    try {
      const picked = await this.ipc.pickVideoFile();
      if (picked) this.onPathInput(picked);
    } catch (err) {
      // The native dialog itself failed: say so, rather than a Browse that does nothing.
      this.error.set(toAppError(err));
    }
  }

  /**
   * The name follows the video's file name until the user types one. It used
   * to be set once, from the first keystroke of a typed path: typing
   * D:\Videos\clip.mp4 named the project "D".
   */
  protected onPathInput(value: string): void {
    this.inputVideoPath.set(value);
    if (this.name().trim() && this.name() !== this.autoName) return;
    this.autoName = value.trim() ? deriveProjectName(value) || this.translate.instant('misc.untitled-project') : '';
    this.name.set(this.autoName);
  }

  /** The name the video's file gave the project ('' once none applies). */
  private autoName = '';

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
    // Another voice engine: its own voices, and a voice of its own. This ran
    // only for the older engines (Piper, VieNeu v3), so switching to VieNeu-TTS
    // 3.8 kept listing — and keeping — the VieNeu v3 voices, and the dub
    // stopped at Start ("belongs to VieNeu v3 … the project's voice engine is
    // VieNeu-TTS 3.8").
    if (key === 'ttsProviderId') {
      this.stopPreview();
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
    this.stopPreview();
    void this.loadVoicesForTarget();
  }

  /** Bumped by every load, so a slow answer for an earlier engine never fills the picker. */
  private voiceLoadSeq = 0;

  /**
   * Load the voices the chosen engine has for the target language and
   * reconcile the selection (keptVoice): the chosen voice while still offered,
   * else the recommended one, else the first, else none. An engine with no
   * voice picker gets no voice: one left from another engine would only stop
   * the dub at Start. Also reads which Piper voices are already on disk (they
   * download on select), and the library entries the Listen button plays.
   */
  private async loadVoicesForTarget(): Promise<void> {
    const seq = ++this.voiceLoadSeq;
    const language = this.settings().targetLanguage;
    const engine = this.voiceEngine();
    const libraryEngine = this.libraryEngine();
    if (!engine && !libraryEngine) {
      this.availableVoices.set([]);
      this.voicesLoading.set(false);
      if (this.settings().ttsVoiceId) this.patchSettings('ttsVoiceId', undefined);
      return;
    }
    this.voicesLoading.set(true);
    try {
      const [library, catalogVoices, status] = await Promise.all([
        // Library engines list their voices from it; every engine plays from it.
        libraryEngine ? this.ipc.voiceLibrary() : this.ipc.voiceLibrary().catch(() => null),
        libraryEngine ? Promise.resolve<PiperVoiceInfo[]>([]) : this.ipc.setupListVoices(language, engine!),
        // Only Piper voices are tracked as individually installed.
        engine === 'piper' ? this.ipc.setupGetStatus().catch(() => null) : Promise.resolve(null),
      ]);
      if (seq !== this.voiceLoadSeq) return;
      if (library) this.libraryVoices.set(library.voices);
      const voices =
        libraryEngine && library
          ? voiceOptions(library.voices, libraryEngine, language, (v) => describeVoice(v, (k) => this.translate.instant(k)))
          : catalogVoices;
      this.availableVoices.set(voices);
      this.installedVoiceIds.set(new Set(status?.installed.piperVoices ?? []));
      const kept = keptVoice(this.settings().ttsVoiceId, voices);
      if (kept !== this.settings().ttsVoiceId) this.patchSettings('ttsVoiceId', kept);
      // Its download still running (started before the user left the form and
      // came back): follow it, rather than show it as not downloaded.
      if (engine === 'piper' && kept && !this.installedVoiceIds().has(kept) && this.activity.setupItem(`piper:${kept}`)?.state === 'running') {
        this.voiceDownloadId.set(kept);
      }
    } catch {
      if (seq !== this.voiceLoadSeq) return;
      // Offline / backend down: leave the picker empty. The run-start readiness
      // gate + ensure-resources still cover the pinned voice.
      this.availableVoices.set([]);
    } finally {
      if (seq === this.voiceLoadSeq) this.voicesLoading.set(false);
    }
  }

  /**
   * Play (or stop) the chosen voice: its catalog sample, or, for an installed
   * voice without one, the voice itself saying a sentence in the target
   * language (the same choice as the Voices screen: previewSource).
   */
  protected async togglePreview(): Promise<void> {
    if (this.preview() !== 'idle') {
      this.stopPreview();
      return;
    }
    const item = this.selectedVoiceItem();
    const source = previewSource(item);
    if (!item || !source) return;
    const seq = ++this.previewSeq;
    this.previewFailed.set(false);
    this.voiceError.set(null);
    this.preview.set('loading');
    let url = this.ipc.voicePreviewUrl(item.id);
    if (source === 'speak') {
      const language = this.settings().targetLanguage;
      try {
        url = await this.ipc.speakVoice(item.id, sampleSentence(language), language);
      } catch (err) {
        if (seq === this.previewSeq) {
          this.preview.set('idle');
          this.voiceError.set(toAppError(err));
        }
        return;
      }
      if (seq !== this.previewSeq) {
        URL.revokeObjectURL(url); // stopped, or another voice chosen, while it was made
        return;
      }
      this.previewObjectUrl = url;
    }
    const audio = new Audio(url);
    this.previewAudio = audio;
    audio.onplaying = () => {
      if (seq === this.previewSeq) this.preview.set('playing');
    };
    audio.onended = () => {
      if (seq === this.previewSeq) this.stopPreview();
    };
    const failed = () => {
      if (seq !== this.previewSeq) return;
      this.stopPreview();
      this.previewFailed.set(true);
    };
    audio.onerror = failed;
    void audio.play().catch(failed);
  }

  private stopPreview(): void {
    this.previewSeq++;
    this.previewAudio?.pause();
    this.previewAudio = null;
    if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
    this.previewObjectUrl = null;
    this.preview.set('idle');
  }

  /**
   * The user picked a voice. Pin it on the project and, if it isn't on disk yet,
   * download it immediately (lazy, on-select) with visible progress. A failed or
   * skipped download here isn't fatal — the run is gated on the voice at start.
   */
  protected async onSelectVoice(voiceId: string): Promise<void> {
    this.stopPreview();
    this.previewFailed.set(false);
    this.voiceError.set(null);
    this.patchSettings('ttsVoiceId', voiceId);
    // Neural (VieNeu) voices come with the engine pack — nothing to download per
    // voice; the run-start gate prompts to install the pack if it isn't yet.
    if (this.voiceEngine() !== 'piper') return;
    if (!voiceId || this.installedVoiceIds().has(voiceId) || this.voiceDownloading()) return;
    await this.downloadVoice(voiceId);
  }

  /**
   * Download a single Piper voice on demand. Its progress and outcome come
   * from the activity service (_onVoiceDownload), which keeps following it if
   * the user leaves the form, and lists it in the top bar meanwhile.
   */
  private async downloadVoice(voiceId: string): Promise<void> {
    const key = `piper:${voiceId}`;
    this.activity.markStarting('model', key);
    this.voiceDownloadId.set(voiceId);
    try {
      await this.ipc.setupInstallVoice(voiceId);
    } catch (err) {
      this.activity.markFailed('model', key, toAppError(err));
    }
  }

  /** Human label for the current target language (falls back to the raw code). */
  protected targetLanguageLabel(): string {
    const code = this.settings().targetLanguage;
    return languageName(code, this.translate.locale(), this.languages().find((l) => l.code === code)?.label ?? code);
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
    const name =
      this.name().trim() || deriveProjectName(this.inputVideoPath()) || this.translate.instant('misc.untitled-project');
    try {
      const series = this.seriesRequest();
      if (series?.aiProviderId) rememberSeriesAi(series.aiProviderId);
      const input: CreateProjectInput = {
        name,
        inputVideoPath: this.inputVideoPath().trim(),
        settings: this.settings(),
        ...(series ? { series } : {}),
      };
      // Back, then Continue: the same project, as the form now is. Continue
      // created another one each time, so fixing a choice after Start refused
      // it left a duplicate in the Projects list. The video is copied again
      // only if it changed (a copy of a long video takes a while).
      const existing = this.createdProjectId();
      const project = existing
        ? await this.ipc.reviseProject(existing, {
            name: input.name,
            settings: input.settings,
            ...(input.inputVideoPath !== this.createdFromVideo ? { inputVideoPath: input.inputVideoPath } : {}),
          })
        : await this.createWithLastFolder(input);
      // The project holds these choices now; the next New project starts afresh.
      this.drafts.clear();
      if (this.destroyed) {
        this.madeWhileAway(project, true);
        return;
      }
      this.createdFromVideo = input.inputVideoPath;
      this.createdProjectId.set(project.id);
      this.createdProject.set(project);
      this.store.setCurrent(project);
      this.preflightProblems.set([]);

      // Pre-fetch any required local models (whisper/Argos pair/Piper voice)
      // now that the languages are known (prepareModels).
      await this.prepareModels(project.id);

      // Probe — surface media info, but a probe failure shouldn't strand the
      // user: they can still proceed (the pipeline re-probes as step 1).
      try {
        const info = await this.ipc.probeVideo(project.id);
        this.mediaInfo.set(info);
      } catch (probeErr) {
        this.error.set(toAppError(probeErr));
      }

      if (this.destroyed) {
        // Left while the models were asked for or the video probed.
        this.madeWhileAway(project, false);
        return;
      }
      this.step.set(2);
    } catch (err) {
      if (this.destroyed) this.failedWhileAway(name, err);
      else this.error.set(toAppError(err));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * The user left while Continue made the project, and it is made: say so
   * wherever they are, and start the downloads it needs (unless step 2's own
   * request already did), as step 2 would have.
   */
  private madeWhileAway(project: Project, startDownloads: boolean): void {
    if (startDownloads) void this.ipc.ensureProjectResources(project.id).catch(() => undefined);
    const screen = project.series?.role === 'parent' ? 'series' : 'processing';
    this.activity.toast({
      tone: 'success',
      title: this.translate.instant('wizard.away.created-title', { name: project.name }),
      message: this.translate.instant('wizard.away.created-body'),
      link: `/project/${project.id}/${screen}`,
      linkLabel: this.translate.instant('activity.open'),
    });
  }

  /** The user left while Continue made the project, and it failed: keep the form, and say so. */
  private failedWhileAway(name: string, err: unknown): void {
    this.drafts.save(this.currentDraft());
    this.activity.toast({
      tone: 'error',
      title: this.translate.instant('wizard.away.failed-title', { name }),
      message: toAppError(err).message,
      link: '/new',
      linkLabel: this.translate.instant('wizard.away.open-form'),
    });
  }

  /**
   * Fetch the models the project's languages need (whisper / Argos pair /
   * Piper voice), and follow the download until this run of it ends.
   *
   * Kick off the install FIRST, then connect: the POST runs installer.run(),
   * which *synchronously* resets the setup bus before the request returns.
   * Connecting only afterwards means replay-on-connect can't hand us a stale
   * `done` from a prior run (e.g. the onboarding install). Replay still
   * delivers every event of THIS run, so no progress is missed. Start stays
   * disabled until this run's own `done`, so a run can never begin against a
   * half-downloaded model; its `error`, and a refused start of the download
   * (which used to be swallowed), stay on screen with Retry.
   */
  private async prepareModels(projectId: string): Promise<void> {
    // A stream left from an earlier run (Back, then Continue) must not end this one.
    this.setupEvents.disconnect();
    this.prepareError.set(null);
    this.prepare.set('running');
    try {
      const ensure = await this.ipc.ensureProjectResources(projectId);
      if (this.destroyed) return;
      if (ensure.installing) this.setupEvents.connect();
      else this.prepare.set('ready');
    } catch (err) {
      if (this.destroyed) return;
      this.prepareError.set(toAppError(err));
      this.prepare.set('failed');
    }
  }

  /** Retry the models after a failed download: what already downloaded is kept. */
  protected retryPrepare(): void {
    const id = this.createdProjectId();
    if (id && this.prepare() !== 'running') void this.prepareModels(id);
  }

  /** The video path the project Continue created holds a copy of. */
  private createdFromVideo: string | null = null;

  /**
   * Create the project in the folder the last one was saved to. That folder
   * may be gone since (an unplugged drive): then the project is created in
   * the default folder rather than not at all, step 2 says why, and the
   * folder is no longer offered.
   */
  private async createWithLastFolder(input: CreateProjectInput): Promise<Project> {
    this.outputFolderFallback.set(null);
    // A preset's own folder first (it was chosen for this kind of video).
    const last = this.presetOutputDir() ?? readLastOutputDir();
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

  /**
   * "Change it" beside a problem only the form can fix (an engine, the
   * voice): back to step 1 with More options open, at that field.
   */
  protected changeChoice(target: ChangeTarget): void {
    this.step.set(1);
    this.moreOpen.set(true);
    // After the step renders: the field exists only then.
    afterNextRender(
      () => {
        const field = document.getElementById(target);
        field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        field?.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  /** Start the pipeline and navigate to the processing screen. */
  protected async start(): Promise<void> {
    const id = this.createdProjectId();
    if (!id || this.busy() || this.prepare() !== 'ready') return;
    this.busy.set(true);
    this.error.set(null);
    try {
      // Proactive readiness gate: don't even attempt a run we know will be
      // rejected. The orchestrator enforces the same check, but surfacing it
      // here means the user sees the fix (start Ollama / pull a model / install
      // an engine pack / add a key) before anything starts. A failed preflight
      // fetch falls through to runPipeline, whose gate still protects the run.
      const preflight = await this.ipc.runPreflight(id).catch(() => null);
      if (this.destroyed) return;
      const problems = preflight && !preflight.ok ? preflight.providers.filter((p) => !p.ready) : [];
      // Each one is explained beside Start, with its fix (startProblems).
      this.preflightProblems.set(problems);
      if (problems.length > 0) return;
      await this.ipc.runPipeline(id);
      // Closed meanwhile: the dub runs, and the user stays where they went.
      if (this.destroyed) return;
      this.leavingOnPurpose = true;
      await this.router.navigate(['/project', id, 'processing']);
    } catch (err) {
      if (!this.destroyed) this.error.set(toAppError(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Not-ready providers from the last preflight (for the inline "fix" affordance). */
  protected readonly preflightProblems = signal<RunPreflightProvider[]>([]);

  /** Each problem that stops Start, in the user's language, with its fix. */
  protected readonly startProblems = computed(() => {
    const provs = this.providers();
    const packs = this.packCatalog();
    const providerName = (phase: string, id: string): string => {
      const list = !provs ? [] : phase === 'stt' ? provs.stt : phase === 'tts' ? provs.tts : provs.translation;
      return list.find((p) => p.id === id)?.displayName ?? id;
    };
    return this.preflightProblems().map((p) => {
      const problem = describeStartProblem(p, providerName(p.phase, p.providerId), (packId) => packs.get(packId)?.name ?? packId);
      const fix: StartFix | null = problem.fix;
      // Flat, so the template needs no narrowing of the fix's kind.
      return {
        id: problem.id,
        phase: this.translate.instant(problem.phaseKey),
        text: this.translate.instant(problem.key, problem.params),
        detail: problem.detail,
        installPack: fix?.kind === 'install' ? fix.packId : null,
        keyService: fix?.kind === 'add-key' ? fix.service : null,
        pullModel: fix?.kind === 'pull-ollama' ? fix.model : null,
        retry: fix?.kind === 'retry',
        change: fix?.kind === 'change' ? fix.target : null,
      };
    });
  });

  /** Check Start's problems again without starting (an install finished, back from Settings). */
  private async refreshPreflight(): Promise<void> {
    const id = this.createdProjectId();
    if (!id) return;
    const preflight = await this.ipc.runPreflight(id).catch(() => null);
    if (this.destroyed || !preflight) return;
    this.preflightProblems.set(preflight.ok ? [] : preflight.providers.filter((p) => !p.ready));
  }

  /** An install a problem asks for (its progress shows in the problem's row). */
  protected installForStart(packId: string): void {
    void this.installPack(packId);
  }

  /** The Install button's label: the pack's download size when the catalog knows it. */
  protected installLabel(packId: string): string {
    const size = packSizeLabel(this.packCatalog().get(packId)?.sizeMb);
    return size ? this.translate.instant('engines.rec.install', { size }) : this.translate.instant('common.install');
  }

  /** An engine pack's install, for its problem row. */
  protected packTask(packId: string): ActivityTask | undefined {
    return this.activity.engine(packId);
  }

  /** Leaving through the form's own link (Add key) from step 2: come back to it. */
  protected keepForReturn(): void {
    this.returning = true;
  }

  /** Pull the configured Ollama model on demand (lazy), then re-check + start. */
  protected async pullOllamaAndRetry(model: string): Promise<void> {
    if (this.ollamaPulling()) return;
    this.ollamaPulling.set(true);
    this.pullError.set(null);
    try {
      await this.ipc.pullOllamaModel(model);
      // Poll until the pull finishes (or errors), then re-run the gate. A
      // closed screen stops following it: the pull goes on in Ollama, and the
      // dub is not started behind the user's back.
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        if (this.destroyed) return;
        const st = await this.ipc.getOllamaPullStatus(model);
        if (this.destroyed) return;
        this.ollamaPullPercent.set(st.percent);
        if (st.status === 'done') break;
        if (st.status === 'error') {
          this.pullError.set(st.error ?? '');
          return;
        }
      }
      this.preflightProblems.set([]);
      await this.start();
    } catch (err) {
      if (!this.destroyed) this.pullError.set(toAppError(err).message);
    } finally {
      this.ollamaPulling.set(false);
    }
  }

  protected readonly ollamaPulling = signal(false);
  protected readonly ollamaPullPercent = signal(0);
  /** Why the Ollama download failed ('' when Ollama gave no reason), shown in its row. */
  protected readonly pullError = signal<string | null>(null);

  /**
   * What to ask before the user leaves now (the route's leaveWhileBusyGuard),
   * or null when leaving is fine.
   */
  leaveWarning(): LeaveWarning | null {
    return leaveWarningFor({
      creating: this.busy() && this.step() === 1,
      pulling: this.ollamaPulling(),
      leavingOnPurpose: this.leavingOnPurpose,
    });
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
