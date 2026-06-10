import type {
  OnInit} from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { IpcService } from '../../core/ipc/ipc.service';
import { ProjectStore, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
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
  MediaInfo,
  ProjectSettings,
  SubtitleExportMode,
} from '../../core/models';
import type { ProviderInfo, ProvidersResponse } from '../../core/models/setup';

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
    sttModel: 'small',
    includeOriginalBackgroundAudio: true,
    duckOriginalAudio: true,
    duckingLevelDb: -12,
    ttsGainDb: 0,
    // Translations (esp. EN->VI) are usually longer than the source. Combined
    // with gap-aware alignment (a line can use the pause until the next line),
    // these tolerances keep most segments fitting on real content. Piper stays
    // intelligible up to ~1.5x; overflow lets a line spill briefly past its slot.
    maxSpeedRatio: 1.6,
    allowedOverflowMs: 1500,
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
  imports: [FormsModule, ErrorBannerComponent],
  templateUrl: './new-project-wizard.component.html',
  styleUrl: './new-project-wizard.component.scss',
})
export class NewProjectWizardComponent implements OnInit {
  private readonly ipc = inject(IpcService);
  private readonly router = inject(Router);
  private readonly store = inject(ProjectStore);

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

  // -------- async state --------
  protected readonly busy = signal(false);
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
    void this.loadProvidersAndDefaults();
  }

  private async loadLanguages(): Promise<void> {
    try {
      const resp = await this.ipc.getLanguages();
      if (resp.common && resp.common.length > 0) {
        this.languages.set(resp.common);
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
      const [provs, prefs] = await Promise.all([
        this.ipc.getProviders(),
        this.ipc.getAppPreferences(),
      ]);
      this.providers.set(provs);
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
    } catch {
      // Offline / orchestrator down: the wizard still works with local defaults.
    }
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
   * What happens to the original soundtrack in the final mix.
   * "Keep" = the original stays as background, side-chain ducked while the
   * dubbed voice speaks (includeOriginalBackgroundAudio + duckOriginalAudio).
   * "Remove" = the dub fully replaces the original audio track.
   */
  protected setOriginalAudio(keep: boolean): void {
    this.settings.update((s) => ({
      ...s,
      includeOriginalBackgroundAudio: keep,
      // Dynamic ducking is the only "keep" flavor the wizard exposes; the
      // ducking level below tunes how far the background drops.
      duckOriginalAudio: keep ? true : s.duckOriginalAudio,
    }));
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
      await this.ipc.runPipeline(id);
      await this.router.navigate(['/project', id, 'processing']);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.busy.set(false);
    }
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
