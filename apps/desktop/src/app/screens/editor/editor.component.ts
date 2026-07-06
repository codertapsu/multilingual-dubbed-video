import type {
  OnInit} from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { splitSubtitleLines } from '@videodubber/shared';

import { environment } from '../../core/environment';
import { IpcService } from '../../core/ipc/ipc.service';
import { ProjectStore, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import {
  ALL_SUBTITLE_EXPORT_MODES,
  formatTimecode,
  PIPELINE_STEP_LABELS,
  PROCESSING_MODE_LABELS,
  SUBTITLE_EXPORT_MODE_LABELS,
} from '../../core/util/format';
import {
  DUCKING_OPTIONS,
  earliestStepForChanges,
  ORIGINAL_AUDIO_MODE_LABELS,
  REDUB_STAGES,
  RENDER_QUALITY_LABELS,
  SPEED_OPTIONS,
  TIME_STRETCH_ENGINE_LABELS,
  ttsEngineParam,
} from '../../core/util/settings-options';
import type {
  AppError,
  OriginalAudioMode,
  PipelineStepId,
  Project,
  ProjectSettings,
  RenderQuality,
  SubtitleExportMode,
} from '../../core/models';
import type { PiperVoiceInfo, ProviderInfo, ProvidersResponse, WhisperModelInfo } from '../../core/models/setup';
import type { EditorSegmentVm, SegmentWithAlignment } from '../../core/models/view-models';

/** Soft cap for "long subtitle" warning (≈ 2 lines × 42 chars). */
const LONG_SUBTITLE_CHAR_LIMIT = 84;
const MAX_SUBTITLE_LINES = 2;

/**
 * EditorComponent (route "project/:id/editor").
 *
 * Side-by-side review/edit of transcript segments: read-only source text and
 * an editable translation, with timestamps and warning badges (long subtitle,
 * needs-review, timing-conflict). Each row can preview its TTS audio and
 * regenerate a single segment. A Save button persists all edited translations.
 *
 * It also shows ALL of the project's applied settings (engines, models, voice,
 * mix/render options) and lets the user change the re-runnable ones (STT/MT/TTS
 * engine, STT model, voice, …) and RE-DUB from the affected stage — reusing the
 * earlier stages' outputs (e.g. swap the voice and re-render without redoing STT
 * + translation). This drives the existing retry-from-step machinery.
 *
 * The "long subtitle" warning is computed with the shared `splitSubtitleLines`
 * helper so the UI matches what the burned-in renderer will actually wrap.
 */
@Component({
  selector: 'vd-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, ErrorBannerComponent],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss',
})
export class EditorComponent implements OnInit {
  readonly id = input.required<string>();

  private readonly ipc = inject(IpcService);
  private readonly store = inject(ProjectStore);
  private readonly router = inject(Router);

  protected readonly formatTimecode = formatTimecode;
  protected readonly stepLabels = PIPELINE_STEP_LABELS;
  protected readonly redubStages = REDUB_STAGES;

  /** Working copy of the segments (translations are mutated in place by id). */
  protected readonly segments = signal<SegmentWithAlignment[]>([]);
  /** Map of segmentId -> edited translatedText (the editable buffer). */
  protected readonly drafts = signal<Record<string, string>>({});

  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<AppError | null>(null);
  protected readonly dirty = signal(false);
  /** Segment ids currently being (re)synthesized. */
  protected readonly synthesizing = signal<ReadonlySet<string>>(new Set());

  /** The project's PERSISTED settings (provider + default voice + target language). */
  protected readonly projectSettings = signal<ProjectSettings | null>(null);
  /** Voices available for the project's CURRENT TTS engine + target language. */
  protected readonly availableVoices = signal<PiperVoiceInfo[]>([]);
  /** Per-segment voice override (segmentId -> voiceId); empty = project default. */
  protected readonly segmentVoiceOverrides = signal<Record<string, string>>({});

  // -------- project settings panel (display + change + re-dub) -----------------
  /** Editable copy of the project settings (diffed against `projectSettings`). */
  protected readonly draft = signal<ProjectSettings | null>(null);
  /** Selectable providers per phase (with availability), for the engine pickers. */
  protected readonly providers = signal<ProvidersResponse | null>(null);
  /** STT model catalog (label + size), for the model picker. */
  protected readonly whisperModels = signal<WhisperModelInfo[]>([]);
  /** Language code -> human label (from the setup catalog). */
  protected readonly languageLabels = signal<ReadonlyMap<string, string>>(new Map());
  /** Voices for the DRAFT TTS engine (the settings-panel default-voice picker). */
  protected readonly draftVoices = signal<PiperVoiceInfo[]>([]);
  /** A re-dub is being started (disables the stage buttons + selects). */
  protected readonly redubbing = signal(false);

  protected readonly originalAudioModeLabels = ORIGINAL_AUDIO_MODE_LABELS;
  protected readonly renderQualityLabels = RENDER_QUALITY_LABELS;
  protected readonly timeStretchLabels = TIME_STRETCH_ENGINE_LABELS;
  protected readonly subtitleLabels = SUBTITLE_EXPORT_MODE_LABELS;
  protected readonly processingLabels = PROCESSING_MODE_LABELS;
  protected readonly duckingOptions = DUCKING_OPTIONS;
  protected readonly speedOptions = SPEED_OPTIONS;
  /** Engine packs the backend OFFERS on this machine/OS (available = enabled +
   * runnable). Gates features whose pack isn't offered so they don't show. */
  protected readonly offeredPacks = signal<ReadonlySet<string>>(new Set<string>());
  // Typed option lists so the template can index the label Records strictly.
  // 'replace-vocals' needs the Vocal-separation engine; hide it unless that pack
  // is offered here (else the dropdown would let a user pick a silent no-op).
  protected readonly originalAudioModes = computed<readonly OriginalAudioMode[]>(() =>
    this.offeredPacks().has('separation-audio')
      ? (['keep', 'replace-vocals', 'remove'] as const)
      : (['keep', 'remove'] as const),
  );
  protected readonly renderQualities: readonly RenderQuality[] = ['quality', 'fast'];
  protected readonly subtitleModes: readonly SubtitleExportMode[] = ALL_SUBTITLE_EXPORT_MODES;

  /** Show the per-segment voice override whenever the engine exposes voices. */
  protected readonly showVoicePicker = computed(() => this.availableVoices().length > 0);

  /** Label for the project's default voice (shown as the "Default" option). */
  protected readonly defaultVoiceLabel = computed(() => {
    const id = this.projectSettings()?.ttsVoiceId;
    if (!id) return 'auto';
    return this.availableVoices().find((v) => v.id === id)?.label ?? id;
  });

  /** The setting keys whose draft value differs from the persisted value. */
  protected readonly changedKeys = computed<(keyof ProjectSettings)[]>(() => {
    const base = this.projectSettings();
    const next = this.draft();
    if (!base || !next) return [];
    return (Object.keys(next) as (keyof ProjectSettings)[]).filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(base[k]),
    );
  });

  protected readonly settingsDirty = computed(() => this.changedKeys().length > 0);

  /** The earliest stage a change requires re-running from (recommended button). */
  protected readonly recommendedStep = computed<PipelineStepId | null>(() =>
    earliestStepForChanges(this.changedKeys()),
  );

  /** Whether the draft TTS engine exposes a selectable voice list. */
  protected readonly draftHasVoices = computed(() => this.draftVoices().length > 0);

  // -------- rendered result (preview + open folder) ----------------------------
  /** The loaded project (for outputDir + the result preview). */
  protected readonly project = signal<Project | null>(null);
  /** True once the pipeline's render step has produced the final video. */
  protected readonly rendered = signal(false);
  protected readonly opening = signal(false);
  protected readonly resultPreviewFailed = signal(false);

  /** Absolute path of the rendered video (same convention as the export screen). */
  protected readonly outputPath = computed<string | null>(() => {
    const p = this.project();
    return p ? `${p.outputDir}/output.mp4` : null;
  });

  /**
   * Best-effort in-app preview URL for the final video, via the orchestrator's
   * `/file?path=` route (browsers can't load `file://` from an http origin).
   * Same approach as the export screen; falls back to "open folder" on error.
   */
  protected readonly resultPreviewUrl = computed<string | null>(() => {
    const path = this.outputPath();
    if (!path) return null;
    return `${environment.orchestratorUrl}/file?path=${encodeURIComponent(path)}`;
  });

  /** Derived per-row view models with computed warnings. */
  protected readonly rows = computed<EditorSegmentVm[]>(() => {
    const drafts = this.drafts();
    return this.segments().map((segment) => {
      const text = drafts[segment.id] ?? segment.translatedText ?? segment.sourceText;
      const wrappedLines = splitSubtitleLines(text, 42, MAX_SUBTITLE_LINES);
      const tooLong =
        text.length > LONG_SUBTITLE_CHAR_LIMIT ||
        wrappedLines.length > MAX_SUBTITLE_LINES;
      // Alignment (status/note/audioPath) is merged onto each segment by the
      // orchestrator's GET /segments once the alignment step has run.
      const alignment = segment.alignment;
      return {
        segment,
        wrappedLines,
        longSubtitle: tooLong,
        needsReview: alignment?.status === 'needs-review',
        timingConflict: alignment?.status === 'timing-conflict',
        alignmentNote: alignment?.note,
      };
    });
  });

  protected readonly anyWarnings = computed(() =>
    this.rows().some((r) => r.longSubtitle || r.needsReview || r.timingConflict),
  );

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const segs = await this.ipc.getSegments(this.id());
      this.segments.set(segs);
      const drafts: Record<string, string> = {};
      for (const s of segs) {
        drafts[s.id] = s.translatedText ?? '';
      }
      this.drafts.set(drafts);
      this.dirty.set(false);
      void this.loadProjectAndSettings();
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Load the project + the metadata the settings panel needs: the selectable
   * providers per phase, the STT model catalog, language labels, and the voices
   * for the current TTS engine (so a segment / the project default can be
   * re-voiced). Best-effort: a failure here just hides the editable controls,
   * the transcript editor still works.
   */
  private async loadProjectAndSettings(): Promise<void> {
    try {
      const { project, pipeline } = await this.ipc.getProject(this.id());
      this.project.set(project);
      this.projectSettings.set(project.settings);
      this.draft.set({ ...project.settings });
      // The result preview/open-folder only make sense once a final video exists,
      // i.e. the render step finished (project may also be marked completed).
      const renderDone = pipeline?.steps.some((s) => s.id === 'render' && s.status === 'completed');
      this.rendered.set(renderDone === true || project.status === 'completed');

      // Provider/model catalogs for the pickers (each best-effort + parallel).
      const [providers, catalog, engines] = await Promise.all([
        this.ipc.getProviders().catch(() => null),
        this.ipc.setupGetCatalog().catch(() => null),
        this.ipc.getEngines().catch(() => null),
      ]);
      if (providers) this.providers.set(providers);
      if (engines) this.offeredPacks.set(new Set(engines.available.map((p) => p.id)));
      if (catalog) {
        this.whisperModels.set(catalog.whisperModels ?? []);
        this.languageLabels.set(new Map((catalog.languages ?? []).map((l) => [l.code, l.label])));
      }

      await this.reloadVoices(project.settings.ttsProviderId, project.settings.targetLanguage);
    } catch {
      // Non-fatal: the editor still works without the settings panel.
    }
  }

  /**
   * Load the installed voices for a TTS engine + language into BOTH the
   * per-segment override list and the settings-panel draft-voice list. Engines
   * without a voice endpoint (cloud) clear the list (the provider default is used).
   */
  private async reloadVoices(ttsProviderId: string | undefined, language: string): Promise<void> {
    const engine = ttsEngineParam(ttsProviderId);
    if (!engine) {
      this.availableVoices.set([]);
      this.draftVoices.set([]);
      return;
    }
    try {
      const [voices, status] = await Promise.all([
        this.ipc.setupListVoices(language, engine),
        this.ipc.setupGetStatus().catch(() => null),
      ]);
      // Only offer voices already on disk for a per-segment override — never a
      // voice that isn't installed (it would fail/stall at synth). The project's
      // default voice is always installed, so keep it. If the installed set can't
      // be read, fall back to the full list (best-effort, non-blocking).
      const usable =
        status && engine === 'piper'
          ? voices.filter(
              (v) => status.installed.piperVoices.includes(v.id) || v.id === this.projectSettings()?.ttsVoiceId,
            )
          : voices;
      this.availableVoices.set(usable);
      this.draftVoices.set(voices);
    } catch {
      this.availableVoices.set([]);
      this.draftVoices.set([]);
    }
  }

  // ----- settings panel: change + re-dub --------------------------------------

  /** A typed patch into the draft settings. Reloads voices when the TTS engine
   *  changes (and resets the voice to the engine default). */
  protected onSettingChange<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void {
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
    if (key === 'ttsProviderId') {
      // The voice list is engine-specific; reset to "provider default" + reload.
      this.draft.update((d) => (d ? { ...d, ttsVoiceId: undefined } : d));
      const lang = this.draft()?.targetLanguage ?? '';
      void this.reloadVoices(value as string, lang).then(() => {
        // If the chosen engine has a recommended voice, pre-select it.
        const rec = this.draftVoices().find((v) => v.recommended) ?? this.draftVoices()[0];
        if (rec) this.draft.update((d) => (d ? { ...d, ttsVoiceId: rec.id } : d));
      });
    }
  }

  /** Coerce a numeric <select> value (strings come back from the DOM). */
  protected onNumberSettingChange<K extends keyof ProjectSettings>(key: K, value: unknown): void {
    this.onSettingChange(key, Number(value) as ProjectSettings[K]);
  }

  protected providerLabel(p: ProviderInfo): string {
    return p.available ? p.displayName : `${p.displayName} — unavailable`;
  }

  /** Whether a persisted provider id is present in the selectable list (so the
   *  template can append it as a fallback option and never render a blank select). */
  protected providerInList(phase: 'stt' | 'translation' | 'tts', id: string | undefined): boolean {
    if (!id) return true;
    return (this.providers()?.[phase] ?? []).some((p) => p.id === id);
  }

  protected modelInList(id: string | undefined): boolean {
    if (!id) return true;
    return this.whisperModels().some((m) => m.id === id);
  }

  protected languageLabel(code: string | undefined): string {
    if (!code) return '—';
    return this.languageLabels().get(code) ?? code;
  }

  protected modelLabel(id: string | undefined): string {
    if (!id) return 'default';
    return this.whisperModels().find((m) => m.id === id)?.label ?? id;
  }

  /** Display label for the persisted value of a provider id within a phase. */
  protected providerName(phase: 'stt' | 'translation' | 'tts', id: string | undefined): string {
    if (!id) return '—';
    return this.providers()?.[phase]?.find((p) => p.id === id)?.displayName ?? id;
  }

  protected isRecommendedStep(step: PipelineStepId): boolean {
    return this.recommendedStep() === step;
  }

  /**
   * Persist any changed settings, then re-run the pipeline from `step` and go to
   * the live progress screen. Earlier stages are reused (the orchestrator skips
   * already-completed steps before `step`). Works even with no setting change —
   * e.g. to re-translate after installing a larger model in Settings → Engines.
   */
  protected async redubFrom(step: PipelineStepId): Promise<void> {
    if (this.redubbing()) return;
    this.redubbing.set(true);
    this.error.set(null);
    try {
      const base = this.projectSettings();
      const next = this.draft();
      if (base && next) {
        const patch: Partial<ProjectSettings> = {};
        for (const key of this.changedKeys()) {
          (patch as Record<string, unknown>)[key] = next[key];
        }
        if (Object.keys(patch).length > 0) {
          const updated = await this.ipc.updateProjectSettings(this.id(), patch);
          this.projectSettings.set(updated.project.settings);
          this.draft.set({ ...updated.project.settings });
        }
      }
      await this.ipc.retryPipelineStep(this.id(), step);
      await this.router.navigate(['/project', this.id(), 'processing']);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.redubbing.set(false);
    }
  }

  protected onTranslationChange(segmentId: string, value: string): void {
    this.drafts.update((d) => ({ ...d, [segmentId]: value }));
    this.dirty.set(true);
  }

  protected draftText(segmentId: string): string {
    return this.drafts()[segmentId] ?? '';
  }

  /** Persist all edited translations. */
  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const drafts = this.drafts();
      const payload = this.segments().map((s) => ({
        id: s.id,
        translatedText: drafts[s.id] ?? s.translatedText ?? '',
      }));
      await this.ipc.saveTranslatedSegments(this.id(), payload);
      // Reflect saved values back onto the segments.
      this.segments.update((segs) =>
        segs.map((s) => ({ ...s, translatedText: drafts[s.id] ?? s.translatedText })),
      );
      this.dirty.set(false);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.saving.set(false);
    }
  }

  /** Regenerate TTS for one segment using the (possibly edited) translation. */
  protected async regenerate(segment: SegmentWithAlignment): Promise<void> {
    const segmentId = segment.id;
    if (this.synthesizing().has(segmentId)) return;
    this.markSynth(segmentId, true);
    this.error.set(null);
    try {
      const text = this.drafts()[segmentId] ?? segment.translatedText ?? '';
      // An empty override means "use the project's default voice" (the backend
      // falls back to project.settings.ttsVoiceId when voiceId is undefined).
      const voiceId = this.segmentVoiceOverrides()[segmentId] || undefined;
      const result = await this.ipc.synthesizeSingleSegment(this.id(), segmentId, {
        text: text.length > 0 ? text : undefined,
        voiceId,
      });
      // Replace the segment's alignment with the fresh result so the warnings
      // and the preview <audio> (cache-busted via generatedDurationMs) update.
      this.segments.update((segs) =>
        segs.map((s) => (s.id === segmentId ? { ...s, alignment: result.alignment } : s)),
      );
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.markSynth(segmentId, false);
    }
  }

  /** Re-translate one overflowing line shorter, then re-synthesize, so it fits. */
  protected async tightenToFit(segment: SegmentWithAlignment): Promise<void> {
    const segmentId = segment.id;
    if (this.synthesizing().has(segmentId)) return;
    this.markSynth(segmentId, true);
    this.error.set(null);
    try {
      const result = await this.ipc.refitSegment(this.id(), segmentId);
      // The line was shortened + persisted; reflect the new text + alignment.
      this.drafts.update((d) => ({ ...d, [segmentId]: result.translatedText }));
      this.segments.update((segs) =>
        segs.map((s) =>
          s.id === segmentId ? { ...s, translatedText: result.translatedText, alignment: result.alignment } : s,
        ),
      );
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.markSynth(segmentId, false);
    }
  }

  protected isSynthesizing(segmentId: string): boolean {
    return this.synthesizing().has(segmentId);
  }

  /** The chosen voice override for a segment ('' = project default). */
  protected segmentVoice(segmentId: string): string {
    return this.segmentVoiceOverrides()[segmentId] ?? '';
  }

  /** Set (or clear, with '') a segment's voice override; takes effect on regenerate. */
  protected onSegmentVoiceChange(segmentId: string, voiceId: string): void {
    this.segmentVoiceOverrides.update((o) => {
      const next = { ...o };
      if (voiceId) next[segmentId] = voiceId;
      else delete next[segmentId];
      return next;
    });
  }

  /**
   * URL for previewing a segment's synthesized audio.
   *
   * The orchestrator serves segment WAVs (scoped to the projects dir) at
   * `GET /file?path=<abs>`; the alignment carries the audio path + duration,
   * so previews work both on first load and after a regenerate. Inside Tauri
   * the same localhost URL works from the webview.
   */
  protected previewUrl(segment: SegmentWithAlignment): string | null {
    const audioPath = segment.alignment?.audioPath;
    if (!audioPath) return null;
    const bust = segment.alignment?.generatedDurationMs ?? 0;
    return `${environment.orchestratorUrl}/file?path=${encodeURIComponent(audioPath)}&v=${bust}`;
  }

  protected reload(): void {
    void this.load();
  }

  /** Open the project's output folder in the OS file manager. */
  protected async openFolder(): Promise<void> {
    const dir = this.project()?.outputDir;
    if (!dir || this.opening()) return;
    this.opening.set(true);
    this.error.set(null);
    try {
      await this.ipc.openOutputFolder(dir);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.opening.set(false);
    }
  }

  protected onResultPreviewError(): void {
    this.resultPreviewFailed.set(true);
  }

  protected dismissError(): void {
    this.error.set(null);
  }

  private markSynth(segmentId: string, on: boolean): void {
    this.synthesizing.update((set) => {
      const next = new Set(set);
      if (on) next.add(segmentId);
      else next.delete(segmentId);
      return next;
    });
  }
}
