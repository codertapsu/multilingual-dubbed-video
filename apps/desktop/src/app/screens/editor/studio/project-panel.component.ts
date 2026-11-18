import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, type OnDestroy, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { speakerNumber, VOICE_ENGINE_PROVIDER } from '@videodubber/shared';

import { IpcService } from '../../../core/ipc/ipc.service';
import { toAppError } from '../../../core/state/project.store';
import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { ConfirmService } from '../../../shared/confirm-dialog/confirm.service';
import { SpeakerVoicesDialogComponent } from '../../../shared/voice-library/speaker-voices-dialog.component';
import { VoiceCloneDialogComponent } from '../../../shared/voice-library/voice-clone-dialog.component';
import { describeVoice } from '../../../shared/voice-library/voice-filter';
import { libraryEngineFor, voiceOptions } from '../../../shared/voice-library/voice-options';
import { PIPELINE_STEP_LABELS, PROCESSING_MODE_LABELS, SUBTITLE_EXPORT_MODE_LABELS, ALL_SUBTITLE_EXPORT_MODES } from '../../../core/util/format';
import {
  DUCKING_OPTIONS,
  earliestStepForChanges,
  ORIGINAL_AUDIO_MODE_LABELS,
  REDUB_STAGES,
  RENDER_QUALITY_LABELS,
  SPEED_OPTIONS,
  SUBTITLE_POSITION_LABELS,
  SUBTITLE_POSITIONS,
  TIME_STRETCH_ENGINE_LABELS,
  ttsEngineParam,
} from '../../../core/util/settings-options';
import type {
  OriginalAudioMode,
  PipelineStepId,
  Project,
  ProjectSettings,
  RenderQuality,
  SubtitleExportMode,
  SubtitleStyle,
  TranslationDocContext,
  VoiceProfile,
} from '../../../core/models';
import type { PiperVoiceInfo, ProviderInfo, ProvidersResponse, WhisperModelInfo } from '../../../core/models/setup';
import { OutputFolderComponent } from '../../../shared/output-folder/output-folder.component';
import { StudioStore } from './studio.store';

/** Fully-populated editable copy of the translation character sheet. */
interface CtxDraft {
  synopsis: string;
  pronounGuide: string;
  cast: { name: string; role: string }[];
  glossary: { source: string; target: string }[];
}

function toCtxDraft(ctx: TranslationDocContext): CtxDraft {
  return {
    synopsis: ctx.synopsis ?? '',
    pronounGuide: ctx.pronounGuide ?? '',
    cast: (ctx.cast ?? []).map((c) => ({ name: c.name, role: c.role ?? '' })),
    glossary: (ctx.glossary ?? []).map((g) => ({ source: g.source, target: g.target })),
  };
}

/**
 * Translation engines that ignore the translation-context sheet: Argos and
 * LibreTranslate are sentence-level statistical MT with nowhere to put a
 * synopsis, a pronoun guide, a cast list or a glossary. Argos is the DEFAULT,
 * so without this notice the whole sheet is a form that silently does nothing.
 */
const CONTEXT_BLIND_TRANSLATION_PROVIDERS: readonly string[] = ['argos', 'libretranslate'];

/**
 * The studio's "Project" side panel: the final video, every applied setting
 * with change-and-re-dub (reusing the earlier stages' outputs), the review
 * checkpoint, and the translation character sheet. This is the previous
 * editor's settings surface, kept intact — the timeline replaced only the
 * transcript table.
 */
@Component({
  selector: 'vd-project-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, OutputFolderComponent, TranslatePipe, VoiceCloneDialogComponent, SpeakerVoicesDialogComponent],
  templateUrl: './project-panel.component.html',
  styleUrl: './project-panel.component.scss',
})
export class ProjectPanelComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmService);
  protected readonly store = inject(StudioStore);

  /** "Voice from this video" dialog (the whole track). */
  protected readonly voiceDialogOpen = signal(false);
  /** A speaker whose voice is being made from their lines. */
  protected readonly speakerCloneId = signal<string | null>(null);
  /** "Make a voice for every speaker" dialog. */
  protected readonly speakersDialogOpen = signal(false);
  protected readonly speakerN = speakerNumber;
  /** Speakers that have a voice of their own. */
  protected readonly speakersWithVoice = computed(
    () => new Set((this.store.settings()?.speakerVoices ?? []).map((v) => v.speakerId)),
  );
  /** Voices made from this project's video (they live and die with it). */
  protected readonly projectVoices = signal<VoiceProfile[]>([]);
  protected readonly playingVoice = signal<string | null>(null);
  private audio: HTMLAudioElement | null = null;

  constructor() {
    // A voice was made from the selected lines (inspector): offer it everywhere.
    effect(() => {
      if (this.store.voicesVersion() === 0) return;
      untracked(() => void this.refreshVoiceLists());
    });
    // Speaker voices apply at once (store.setSpeakerVoice), not through this
    // draft: keep the draft in step, or every speaker voice would show here as
    // an unsaved change asking for a re-dub.
    effect(() => {
      const voices = this.store.settings()?.speakerVoices;
      untracked(() => this.draft.update((d) => (d ? { ...d, speakerVoices: voices } : d)));
    });
  }

  /** A speaker's own voice id, or '' for the project voice. */
  protected speakerVoice(speakerId: string): string {
    return this.store.settings()?.speakerVoices?.find((v) => v.speakerId === speakerId)?.voiceId ?? '';
  }

  protected async onSpeakerVoiceChange(speakerId: string, voiceId: string): Promise<void> {
    await this.store.setSpeakerVoice(speakerId, voiceId || null);
  }

  /** Speaker detection's count: 0 = automatic, else exactly that many people. */
  protected readonly detectCount = signal(0);
  protected readonly speakerCounts = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

  protected async detectSpeakers(): Promise<void> {
    const n = this.detectCount();
    await this.store.detectSpeakers(n >= 2 ? n : undefined);
  }

  /** "Merge into…": every line of `from` goes to the chosen speaker (undoable). */
  protected onMerge(from: string, select: HTMLSelectElement): void {
    const into = select.value;
    select.value = '';
    if (into) this.store.mergeSpeaker(from, into);
  }

  /** Show a speaker's lines: selected, in the Line tab. */
  protected showSpeakerLines(speakerId: string): void {
    this.store.selectSpeaker(speakerId);
    this.store.sideTab.set('line');
  }

  /** A speaker's voice was made from their lines: it becomes theirs. */
  protected async onSpeakerCloneMade(speakerId: string, profile: VoiceProfile): Promise<void> {
    await this.refreshVoiceLists();
    if (this.store.settings()?.ttsProviderId === VOICE_ENGINE_PROVIDER[profile.engine]) {
      await this.store.setSpeakerVoice(speakerId, profile.id);
    }
  }

  /** Voices were made for several speakers (the server assigned them). */
  protected async onSpeakerVoicesMade(): Promise<void> {
    await this.refreshVoiceLists();
    await this.store.reload();
    const { project } = await this.ipc.getProject(this.store.projectId());
    this.store.project.set(project);
  }

  ngOnDestroy(): void {
    this.audio?.pause();
  }

  protected readonly stepLabels = PIPELINE_STEP_LABELS;
  protected readonly redubStages = REDUB_STAGES;
  protected readonly originalAudioModeLabels = ORIGINAL_AUDIO_MODE_LABELS;
  protected readonly renderQualityLabels = RENDER_QUALITY_LABELS;
  protected readonly timeStretchLabels = TIME_STRETCH_ENGINE_LABELS;
  protected readonly subtitleLabels = SUBTITLE_EXPORT_MODE_LABELS;
  protected readonly processingLabels = PROCESSING_MODE_LABELS;
  protected readonly duckingOptions = DUCKING_OPTIONS;
  protected readonly speedOptions = SPEED_OPTIONS;
  protected readonly renderQualities: readonly RenderQuality[] = ['auto', 'quality', 'fast'];
  protected readonly subtitlePositions = SUBTITLE_POSITIONS;
  protected readonly subtitlePositionLabels = SUBTITLE_POSITION_LABELS;
  protected readonly subtitleModes: readonly SubtitleExportMode[] = ALL_SUBTITLE_EXPORT_MODES;

  protected readonly draft = signal<ProjectSettings | null>(null);
  protected readonly providers = signal<ProvidersResponse | null>(null);
  protected readonly whisperModels = signal<WhisperModelInfo[]>([]);
  protected readonly languageLabels = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly draftVoices = signal<PiperVoiceInfo[]>([]);
  protected readonly offeredPacks = signal<ReadonlySet<string>>(new Set<string>());
  protected readonly redubbing = signal(false);
  readonly awaitingReview = signal(false);
  protected readonly continuing = signal(false);
  readonly rendered = signal(false);
  protected readonly resultPreviewFailed = signal(false);

  protected readonly originalAudioModes = computed<readonly OriginalAudioMode[]>(() =>
    this.offeredPacks().has('separation-audio') ? (['keep', 'replace-vocals', 'remove'] as const) : (['keep', 'remove'] as const),
  );

  protected readonly contextIgnoredByEngine = computed(() =>
    CONTEXT_BLIND_TRANSLATION_PROVIDERS.includes(this.store.settings()?.translationProviderId ?? ''),
  );

  protected readonly changedKeys = computed<(keyof ProjectSettings)[]>(() => {
    const base = this.store.settings();
    const next = this.draft();
    if (!base || !next) return [];
    return (Object.keys(next) as (keyof ProjectSettings)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(base[k]));
  });
  protected readonly settingsDirty = computed(() => this.changedKeys().length > 0);
  protected readonly recommendedStep = computed<PipelineStepId | null>(() => earliestStepForChanges(this.changedKeys()));
  protected readonly draftHasVoices = computed(() => this.draftVoices().length > 0);

  protected readonly outputPath = computed(() => this.store.media()?.outputPath ?? null);
  protected readonly resultPreviewUrl = computed(() => {
    const p = this.outputPath();
    return p ? this.ipc.fileUrl(p) : null;
  });

  // -------- character sheet --------
  protected readonly ctxDraft = signal<CtxDraft | null>(null);
  readonly ctxDirty = signal(false);
  /**
   * The app tried to build the character sheet and failed (the model and why).
   * The pipeline logs it, but a log line is easy to miss, and without a sheet
   * names and forms of address drift across the video.
   */
  protected readonly sheetFailure = signal<{ engine: string; why: string } | null>(null);
  protected readonly ctxSaving = signal(false);

  ngOnInit(): void {
    // The shell set the project id (synchronously) before its view created us.
    void this.load(this.store.projectId());
  }

  /** Load the project + everything the settings panel needs (best-effort). */
  async load(projectId: string): Promise<void> {
    try {
      const { project, pipeline } = await this.ipc.getProject(projectId);
      this.store.project.set(project);
      this.draft.set({ ...project.settings });
      this.detectCount.set(project.settings.diarizeSpeakers ?? 0);
      const renderDone = pipeline?.steps.some((s) => s.id === 'render' && s.status === 'completed');
      this.rendered.set(renderDone === true || project.status === 'completed');
      this.awaitingReview.set(pipeline?.awaitingReview === true);
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
      await this.reloadVoices(project.settings.ttsProviderId, project.settings.targetLanguage, true);
      await this.loadProjectVoices();
    } catch {
      /* non-fatal: the timeline still works without the settings panel */
    }
    try {
      const { context } = await this.ipc.getTranslationContext(projectId);
      if (context) {
        this.ctxDraft.set(toCtxDraft(context));
        this.ctxDirty.set(false);
      }
    } catch {
      /* the sheet just shows its empty state */
    }
    try {
      const sheet = (await this.ipc.getTranslationReport(projectId)).translation.characterSheet;
      this.sheetFailure.set(
        sheet?.status === 'failed'
          ? {
              engine: sheet.engine ?? '',
              why: (sheet.attempts ?? []).map((a) => a.error).find((e) => !!e) ?? sheet.reason ?? '',
            }
          : null,
      );
    } catch {
      /* no report (an older orchestrator, or no translation yet): no warning */
    }
  }

  /**
   * Voices for a TTS engine. The CURRENT engine's installed voices also feed the
   * studio's per-line voice picker (only voices on disk: a missing one would
   * fail at synthesis); the full list feeds the default-voice picker here.
   */
  private async reloadVoices(ttsProviderId: string | undefined, language: string, forStudio: boolean, forDraft = true): Promise<void> {
    const setDraft = (voices: PiperVoiceInfo[]) => {
      if (forDraft) this.draftVoices.set(voices);
    };
    // Engines of the voice library (VieNeu 3.8, ZeroTTS, Kokoro, Supertonic):
    // every voice ships with the engine pack, so all of them are usable. The
    // project id adds the voices made from this project's video.
    const libraryEngine = libraryEngineFor(ttsProviderId);
    if (libraryEngine) {
      try {
        const lib = await this.ipc.voiceLibrary({ projectId: this.store.projectId() });
        const voices = voiceOptions(lib.voices, libraryEngine, language, (v) => describeVoice(v, (k) => this.translate.instant(k)));
        setDraft(voices);
        if (forStudio) this.store.voices.set(voices);
      } catch {
        setDraft([]);
        if (forStudio) this.store.voices.set([]);
      }
      return;
    }
    const engine = ttsEngineParam(ttsProviderId);
    if (!engine) {
      setDraft([]);
      if (forStudio) this.store.voices.set([]);
      return;
    }
    try {
      const [voices, status] = await Promise.all([
        this.ipc.setupListVoices(language, engine),
        this.ipc.setupGetStatus().catch(() => null),
      ]);
      setDraft(voices);
      if (forStudio) {
        const usable =
          status && engine === 'piper'
            ? voices.filter((v) => status.installed.piperVoices.includes(v.id) || v.id === this.store.settings()?.ttsVoiceId)
            : voices;
        this.store.voices.set(usable);
      }
    } catch {
      setDraft([]);
      if (forStudio) this.store.voices.set([]);
    }
  }

  // ---------------- voices from this project's video ----------------

  private async loadProjectVoices(): Promise<void> {
    const id = this.store.projectId();
    try {
      const all = await this.ipc.voiceProfiles(id);
      this.projectVoices.set(all.filter((p) => p.scope.kind === 'project' && p.scope.projectId === id));
    } catch {
      this.projectVoices.set([]);
    }
  }

  /** Reload every voice list (a voice was made or deleted). */
  private async refreshVoiceLists(): Promise<void> {
    const applied = this.store.settings();
    const draft = this.draft();
    if (!applied) return;
    const sameEngine = !draft || (draft.ttsProviderId === applied.ttsProviderId && draft.targetLanguage === applied.targetLanguage);
    await this.reloadVoices(applied.ttsProviderId, applied.targetLanguage, true, sameEngine);
    if (!sameEngine && draft) await this.reloadVoices(draft.ttsProviderId, draft.targetLanguage, false);
    await this.loadProjectVoices();
  }

  /**
   * A voice was made from the whole video: propose it as the project's voice.
   * Only proposed: like any setting here it applies when the user re-dubs,
   * from text-to-speech (nothing before that changes).
   */
  protected async onVoiceMade(profile: VoiceProfile): Promise<void> {
    const provider = VOICE_ENGINE_PROVIDER[profile.engine] ?? VOICE_ENGINE_PROVIDER.vieneu;
    this.draft.update((d) => (d ? { ...d, ttsProviderId: provider, ttsVoiceId: profile.id } : d));
    await this.refreshVoiceLists();
  }

  protected toggleProjectVoice(p: VoiceProfile): void {
    this.audio?.pause();
    if (this.playingVoice() === p.id) {
      this.playingVoice.set(null);
      return;
    }
    const audio = new Audio(this.ipc.voiceProfileAudioUrl(p.id, 'preview', p.updatedAt));
    this.audio = audio;
    this.playingVoice.set(p.id);
    audio.onended = () => this.playingVoice.set(null);
    audio.onerror = () => this.playingVoice.set(null);
    void audio.play().catch(() => this.playingVoice.set(null));
  }

  protected async deleteProjectVoice(p: VoiceProfile): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('voices.my-delete-title', { name: p.name }),
      message: this.translate.instant('voices.my-delete-body'),
      confirmLabel: this.translate.instant('voices.my-delete-confirm'),
    });
    if (!ok) return;
    try {
      await this.ipc.deleteVoiceProfile(p.id);
      // A deleted voice must not stay proposed as the project's voice.
      if (this.draft()?.ttsVoiceId === p.id) this.draft.update((d) => (d ? { ...d, ttsVoiceId: undefined } : d));
      await this.refreshVoiceLists();
    } catch (err) {
      this.store.error.set(toAppError(err));
    }
  }

  protected onSettingChange<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void {
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
    if (key === 'ttsProviderId') {
      this.draft.update((d) => (d ? { ...d, ttsVoiceId: undefined } : d));
      void this.reloadVoices(value as string, this.draft()?.targetLanguage ?? '', false).then(() => {
        const rec = this.draftVoices().find((v) => v.recommended) ?? this.draftVoices()[0];
        if (rec) this.draft.update((d) => (d ? { ...d, ttsVoiceId: rec.id } : d));
      });
    }
  }

  /** Burned-in subtitle placement / the band that hides a source's own subtitles. */
  protected onBurnStyleChange(patch: Partial<SubtitleStyle>): void {
    this.draft.update((d) => (d ? { ...d, burnSubtitleStyle: { ...d.burnSubtitleStyle, ...patch } } : d));
  }

  protected onNumberSettingChange<K extends keyof ProjectSettings>(key: K, value: unknown): void {
    this.onSettingChange(key, Number(value) as ProjectSettings[K]);
  }

  protected providerLabel(p: ProviderInfo): string {
    return p.available ? p.displayName : `${p.displayName} — unavailable`;
  }

  protected refinerOptions(): ProviderInfo[] {
    return (this.providers()?.translation ?? []).filter((p) => p.supportsRefinement === true);
  }

  protected providerInList(phase: 'stt' | 'translation' | 'tts', id: string | undefined): boolean {
    return !id || (this.providers()?.[phase] ?? []).some((p) => p.id === id);
  }

  protected modelInList(id: string | undefined): boolean {
    return !id || this.whisperModels().some((m) => m.id === id);
  }

  protected languageLabel(code: string | undefined): string {
    return code ? (this.languageLabels().get(code) ?? code) : '—';
  }

  protected modelLabel(id: string | undefined): string {
    return id ? (this.whisperModels().find((m) => m.id === id)?.label ?? id) : 'default';
  }

  protected isRecommendedStep(step: PipelineStepId): boolean {
    return this.recommendedStep() === step;
  }

  /** Persist changed settings, then re-run from `step` (earlier stages reused). */
  async redubFrom(step: PipelineStepId): Promise<void> {
    if (this.redubbing()) return;
    this.redubbing.set(true);
    try {
      if (!(await this.store.flushNow())) return;
      const base = this.store.settings();
      const next = this.draft();
      if (base && next && this.changedKeys().length > 0) {
        const patch: Partial<ProjectSettings> = {};
        for (const key of this.changedKeys()) (patch as Record<string, unknown>)[key] = next[key];
        const updated = await this.ipc.updateProjectSettings(this.store.projectId(), patch);
        this.store.project.set(updated.project);
        this.draft.set({ ...updated.project.settings });
      }
      await this.ipc.retryPipelineStep(this.store.projectId(), step);
      await this.router.navigate(['/project', this.store.projectId(), 'processing']);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.redubbing.set(false);
    }
  }

  /** Leave the review checkpoint: save edits, resume at synthesis. */
  async continueDubbing(): Promise<void> {
    if (this.continuing()) return;
    this.continuing.set(true);
    try {
      if (!(await this.store.flushNow())) return;
      await this.ipc.retryPipelineStep(this.store.projectId(), 'tts');
      await this.router.navigate(['/project', this.store.projectId(), 'processing']);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.continuing.set(false);
    }
  }

  /**
   * "Save to" changed: the finished files moved, so re-read the timeline,
   * whose media block names the video the result card previews.
   */
  protected onOutputFolderChanged(project: Project): void {
    this.store.project.set(project);
    this.resultPreviewFailed.set(false);
    void this.store.reload();
  }

  // ---------------- character sheet ----------------
  protected createCtxSheet(): void {
    this.ctxDraft.set({ synopsis: '', pronounGuide: '', cast: [{ name: '', role: '' }], glossary: [] });
    this.ctxDirty.set(true);
  }

  protected ctxChanged(): void {
    this.ctxDirty.set(true);
  }

  protected ctxAddCast(): void {
    this.ctxDraft.update((d) => (d ? { ...d, cast: [...d.cast, { name: '', role: '' }] } : d));
    this.ctxDirty.set(true);
  }

  protected ctxRemoveCast(index: number): void {
    this.ctxDraft.update((d) => (d ? { ...d, cast: d.cast.filter((_, i) => i !== index) } : d));
    this.ctxDirty.set(true);
  }

  protected ctxAddGlossary(): void {
    this.ctxDraft.update((d) => (d ? { ...d, glossary: [...d.glossary, { source: '', target: '' }] } : d));
    this.ctxDirty.set(true);
  }

  protected ctxRemoveGlossary(index: number): void {
    this.ctxDraft.update((d) => (d ? { ...d, glossary: d.glossary.filter((_, i) => i !== index) } : d));
    this.ctxDirty.set(true);
  }

  protected async saveCtx(retranslate: boolean): Promise<void> {
    const draft = this.ctxDraft();
    if (!draft || this.ctxSaving()) return;
    this.ctxSaving.set(true);
    try {
      const ctx: TranslationDocContext = {
        synopsis: draft.synopsis,
        pronounGuide: draft.pronounGuide,
        cast: draft.cast.filter((c) => c.name.trim().length > 0),
        glossary: draft.glossary.filter((g) => g.source.trim().length > 0),
      };
      const { context } = await this.ipc.saveTranslationContext(this.store.projectId(), ctx);
      this.ctxDraft.set(toCtxDraft(context));
      this.ctxDirty.set(false);
      if (retranslate) await this.redubFrom('translation');
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.ctxSaving.set(false);
    }
  }
}
