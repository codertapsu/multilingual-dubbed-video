import { BrandingPanelComponent } from './branding-panel.component';
import { PicturePanelComponent } from './picture-panel.component';
import { coverModeOf } from '../../../shared/picture/picture-geometry';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, viewChild, type OnDestroy, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { speakerNumber, subtitleCheckOn, VOICE_ENGINE_PROVIDER } from '@videodubber/shared';

import { IpcService } from '../../../core/ipc/ipc.service';
import { toAppError } from '../../../core/state/project.store';
import { TranslatePipe, TranslateService, languageName } from '../../../core/i18n';
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
import { audioDriftView, spotCheckApplies, spotCheckOn } from '../../../core/util/source-checks';
import { castNoteShownElsewhere, describeCastNote } from './notes';
import { formatTimecode } from '../../../core/util/format';
import { SongsPanelComponent } from './songs-panel.component';
import { handLockedCount, retranslates } from './redub';
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
 * with change-and-re-dub (reusing the earlier stages' outputs), and the
 * translation character sheet. This is the previous editor's settings
 * surface, kept intact — the timeline replaced only the transcript table.
 * The review checkpoint's "Continue dubbing" moved to the editor's toolbar:
 * here, on a tab the editor does not open on, it was the only way forward
 * and nobody found it.
 */
@Component({
  selector: 'vd-project-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    OutputFolderComponent,
    TranslatePipe,
    VoiceCloneDialogComponent,
    SpeakerVoicesDialogComponent,
    SongsPanelComponent,
    BrandingPanelComponent,
    PicturePanelComponent,
  ],
  templateUrl: './project-panel.component.html',
  styleUrl: './project-panel.component.scss',
})
export class ProjectPanelComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmService);
  protected readonly store = inject(StudioStore);
  private readonly branding = viewChild(BrandingPanelComponent);
  private readonly picture = viewChild(PicturePanelComponent);

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

  /**
   * Voices for every speaker by gender, the user's clones first (POST
   * /projects/:id/speakers/cast): shown first, saved on "Apply". Clones whose
   * gender the user has not confirmed are named and left out; applying
   * without them takes an explicit tick.
   */
  protected unconfirmedNames(c: { unconfirmed: { name: string }[] }): string {
    return c.unconfirmed.map((v) => v.name).join(', ');
  }

  protected readonly cast = signal<Awaited<ReturnType<IpcService['castVoices']>> | null>(null);
  protected readonly casting = signal(false);
  protected readonly castWithoutClones = signal(false);
  /** The proposal's notes in the user's language (the server writes them in English); the lists below say the rest. */
  protected readonly castNotes = computed(() =>
    (this.cast()?.notes ?? [])
      .filter((note) => !castNoteShownElsewhere(note))
      .map((note) => describeCastNote(note, (key, params) => this.translate.instant(key, params))),
  );

  /**
   * "Voices for minor speakers": how many voices the speakers past the
   * distinct ones share per gender. 0 = automatic (3 to 6 by how many there
   * are); saved as the project's setting when the cast is applied. One voice
   * for 59 minor characters, the user's own clone, was what the 27.8-hour
   * series sounded like (plan 1.4).
   */
  protected readonly minorVoices = signal(0);
  protected readonly minorVoiceChoices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
  /** Pool voices the user chose by hand, per gender (their clones allowed). */
  private readonly minorPool = signal<{ male?: string[]; female?: string[] }>({});
  protected readonly castGenders = ['male', 'female'] as const;
  /** The proposal's distinct voices (the minor speakers are listed by pool voice instead). */
  protected readonly castMains = computed(() => (this.cast()?.assignments ?? []).filter((a) => a.by !== 'pool'));

  protected async proposeCast(): Promise<void> {
    await this.castCall({});
  }

  protected async applyCast(): Promise<void> {
    const done = await this.castCall({ apply: true, allowWithoutClones: this.castWithoutClones() });
    if (done?.applied) {
      this.cast.set(null);
      this.minorPool.set({});
      // The speakers' voices changed (project settings), and lines were marked for re-voicing (the timeline).
      await this.store.refreshProject().catch(() => undefined);
      await this.store.reload();
    }
  }

  /** A new pool size: the voices picked by hand no longer fit it; propose again if a proposal is shown. */
  protected async onMinorVoicesChange(n: number): Promise<void> {
    this.minorVoices.set(n);
    this.minorPool.set({});
    if (this.cast()) await this.castCall({});
  }

  /** Swap one voice of a gender's pool for another (a clone is the user's choice to make). */
  protected async pickPoolVoice(gender: 'male' | 'female', index: number, voiceId: string): Promise<void> {
    const current = this.cast()?.pools?.[gender]?.voices.map((v) => v.voiceId) ?? [];
    if (!voiceId || current[index] === voiceId) return;
    const next = current.map((id, i) => (i === index ? voiceId : id));
    this.minorPool.update((p) => ({ ...p, [gender]: [...new Set(next)] }));
    await this.castCall({});
  }

  /** The choices for a pool voice: the castable voices of the gender, the current one first. */
  protected poolChoices(gender: 'male' | 'female', currentId: string): { voiceId: string; name: string }[] {
    const all = this.cast()?.candidates?.[gender] ?? [];
    return all.some((v) => v.voiceId === currentId) ? all : [{ voiceId: currentId, name: currentId }, ...all];
  }

  /** Show one line (an unknown speaker's sample): selected, in the Line tab. */
  protected showLine(id: string): void {
    this.store.select(id);
    this.store.sideTab.set('line');
  }

  protected fmtClock(ms: number | undefined): string {
    return ms === undefined ? '' : formatTimecode(ms);
  }

  private async castCall(body: { apply?: boolean; allowWithoutClones?: boolean }): Promise<Awaited<ReturnType<IpcService['castVoices']>> | null> {
    this.casting.set(true);
    try {
      const pool = this.minorPool();
      const res = await this.ipc.castVoices(this.store.projectId(), {
        ...body,
        minorVoices: this.minorVoices() > 0 ? this.minorVoices() : null,
        ...(pool.male?.length || pool.female?.length ? { minorPool: pool } : {}),
      });
      this.cast.set(res);
      return res;
    } catch (err) {
      this.store.error.set(toAppError(err));
      return null;
    } finally {
      this.casting.set(false);
    }
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
    await this.store.refreshProject().catch(() => undefined);
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

  /**
   * The settings the user changed in this card and has not applied with a
   * re-dub; the card shows the applied settings with these on top. The draft
   * used to be a full copy taken at load: anything applied at once afterwards
   * (logo & greeting, speaker detection, voices by gender) then read as an
   * unsaved change in it, recommended a re-dub (from speech-to-text, after a
   * detection) and the re-dub wrote the stale copy back over it.
   */
  private readonly edits = signal<Partial<ProjectSettings>>({});
  protected readonly draft = computed<ProjectSettings | null>(() => {
    const applied = this.store.settings();
    if (!applied) return null;
    const edits = this.edits();
    // The subtitle style field by field: the picture block saves the band
    // at once, and a position picked here must not carry a stale copy of
    // the band back with it (picture-panel.component.ts).
    return {
      ...applied,
      ...edits,
      ...(edits.burnSubtitleStyle ? { burnSubtitleStyle: { ...applied.burnSubtitleStyle, ...edits.burnSubtitleStyle } } : {}),
    };
  });
  protected readonly providers = signal<ProvidersResponse | null>(null);
  protected readonly whisperModels = signal<WhisperModelInfo[]>([]);
  protected readonly languageLabels = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly draftVoices = signal<PiperVoiceInfo[]>([]);
  protected readonly offeredPacks = signal<ReadonlySet<string>>(new Set<string>());
  protected readonly redubbing = signal(false);
  /** The render step has produced the video (it follows the store's pipeline, read again after a dub). */
  readonly rendered = computed(
    () =>
      this.store.pipeline()?.steps.some((s) => s.id === 'render' && s.status === 'completed') === true ||
      this.store.project()?.status === 'completed',
  );
  protected readonly resultPreviewFailed = signal(false);

  protected readonly originalAudioModes = computed<readonly OriginalAudioMode[]>(() =>
    this.offeredPacks().has('separation-htdemucs') ? (['keep', 'replace-vocals', 'remove'] as const) : (['keep', 'remove'] as const),
  );

  protected readonly contextIgnoredByEngine = computed(() =>
    CONTEXT_BLIND_TRANSLATION_PROVIDERS.includes(this.store.settings()?.translationProviderId ?? ''),
  );

  protected readonly changedKeys = computed<(keyof ProjectSettings)[]>(() => {
    const base = this.store.settings();
    const next = this.draft();
    if (!base || !next) return [];
    return (Object.keys(this.edits()) as (keyof ProjectSettings)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(base[k]));
  });
  protected readonly settingsDirty = computed(() => this.changedKeys().length > 0);
  protected readonly recommendedStep = computed<PipelineStepId | null>(() => earliestStepForChanges(this.changedKeys()));

  /** The source's audio against its picture, measured when the audio was extracted (core/util/source-checks.ts). */
  protected readonly audioDrift = computed(() => audioDriftView(this.store.project()?.mediaInfo?.audioDrift));
  /** The transcript spot check: CJK speech only, and never on a series part (its parent transcribed it). */
  protected readonly spotCheckOffered = computed(
    () => spotCheckApplies(this.draft()?.sourceLanguage) && this.store.project()?.series?.role !== 'part',
  );
  /** Whether it runs with these settings: on by default above 2 hours. */
  /** Speech-to-text against the video's own subtitles: never on a series part (its parent transcribed it). */
  protected readonly subtitleCheckOffered = computed(() => this.store.project()?.series?.role !== 'part');
  protected readonly subtitleCheck = computed(() => subtitleCheckOn(this.draft()?.subtitleCoverageCheck, this.draft()?.sourceLanguage));
  protected readonly spotCheck = computed(() =>
    spotCheckOn(this.draft()?.transcriptSpotCheck, this.store.project()?.mediaInfo?.durationMs),
  );
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
      this.store.adoptProject(project, pipeline ?? null);
      this.edits.set({});
      this.detectCount.set(project.settings.diarizeSpeakers ?? 0);
      this.minorVoices.set(project.settings.minorVoices ?? 0);
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
    this.edits.update((e) => ({ ...e, ttsProviderId: provider, ttsVoiceId: profile.id }));
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
      if (this.draft()?.ttsVoiceId === p.id) this.edits.update((e) => ({ ...e, ttsVoiceId: undefined }));
      await this.refreshVoiceLists();
    } catch (err) {
      this.store.error.set(toAppError(err));
    }
  }

  protected onSettingChange<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]): void {
    this.edits.update((e) => ({ ...e, [key]: value }));
    if (key === 'ttsProviderId') {
      this.edits.update((e) => ({ ...e, ttsVoiceId: undefined }));
      void this.reloadVoices(value as string, this.draft()?.targetLanguage ?? '', false).then(() => {
        const rec = this.draftVoices().find((v) => v.recommended) ?? this.draftVoices()[0];
        if (rec) this.edits.update((e) => ({ ...e, ttsVoiceId: rec.id }));
      });
    }
  }

  /** Burned-in subtitle placement (only the fields changed here; see `draft`). */
  protected onBurnStyleChange(patch: Partial<SubtitleStyle>): void {
    this.edits.update((e) => ({ ...e, burnSubtitleStyle: { ...e.burnSubtitleStyle, ...patch } }));
  }

  /** How the video's own subtitles are hidden, in words (set in the picture block). */
  protected coverLabel(style: SubtitleStyle | undefined): string {
    const mode = coverModeOf(style);
    return mode === 'blur' ? 'picture.band-blur' : mode === 'solid' ? 'picture.band-solid' : 'picture.band-off';
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
    return code ? languageName(code, this.translate.locale(), this.languageLabels().get(code) ?? code) : '—';
  }

  protected modelLabel(id: string | undefined): string {
    return id ? (this.whisperModels().find((m) => m.id === id)?.label ?? id) : 'default';
  }

  protected isRecommendedStep(step: PipelineStepId): boolean {
    return this.recommendedStep() === step;
  }

  /** The re-dub from `step` translates every line again (its tooltip says what that replaces). */
  protected retranslatesFrom(step: PipelineStepId): boolean {
    return retranslates(step);
  }

  /**
   * The drafts here that only their own button saves, in words, for the
   * leave-page prompt. Line edits are not among them: they save themselves.
   */
  unsavedDrafts(): string[] {
    const out: string[] = [];
    if (this.settingsDirty()) out.push(this.translate.instant('studio.draft-settings'));
    if (this.ctxDirty()) out.push(this.translate.instant('studio.draft-sheet'));
    if (this.branding()?.dirty()) out.push(this.translate.instant('studio.draft-greeting'));
    if (this.picture()?.dirty()) out.push(this.translate.instant('picture.draft'));
    return out;
  }

  /** Re-dub from `step`, once the user agreed to what it replaces or stops. */
  async redubFrom(step: PipelineStepId): Promise<void> {
    if (this.redubbing()) return;
    if (!(await this.confirmRedub(step))) return;
    await this.runRedub(step);
  }

  /**
   * Ask before a re-dub throws away work: the lines the user wrote or locked
   * (a re-translation replaces them: the translation step does not keep
   * locked lines), or a dub in progress (stopped first, what it finished
   * kept). With nothing to lose there is no question.
   */
  private async confirmRedub(step: PipelineStepId): Promise<boolean> {
    const locked = retranslates(step) ? handLockedCount(this.store.segments()) : 0;
    const running = this.store.dubRunning();
    if (locked === 0 && !running) return true;
    const parts: string[] = [];
    if (running) parts.push(this.translate.instant('studio.stop-dub-body'));
    if (locked > 0) {
      parts.push(this.translate.instant('editor.redub-locked-body', { n: locked, step: this.translate.instant(this.stepLabels[step]) }));
    }
    return this.confirm.confirm({
      title: locked > 0 ? this.translate.instant('editor.redub-locked-title') : this.translate.instant('studio.stop-dub-title'),
      message: parts.join(' '),
      confirmLabel: locked > 0 ? this.translate.instant('editor.redub-locked-confirm') : this.translate.instant('editor.redub-stop-confirm'),
    });
  }

  /** Persist changed settings, then re-run from `step` (earlier stages reused). */
  private async runRedub(step: PipelineStepId): Promise<void> {
    if (this.redubbing()) return;
    this.redubbing.set(true);
    try {
      // A running dub refuses new settings, and the user agreed to stop it.
      if (this.store.dubRunning() && !(await this.store.stopRunningDub())) return;
      if (!(await this.store.flushNow())) return;
      const base = this.store.settings();
      const next = this.draft();
      if (base && next && this.changedKeys().length > 0) {
        const patch: Partial<ProjectSettings> = {};
        for (const key of this.changedKeys()) (patch as Record<string, unknown>)[key] = next[key];
        const updated = await this.ipc.updateProjectSettings(this.store.projectId(), patch);
        this.store.adoptProject(updated.project, updated.pipeline ?? null);
        this.edits.set({});
      }
      await this.ipc.retryPipelineStep(this.store.projectId(), step);
      await this.router.navigate(['/project', this.store.projectId(), 'processing']);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.redubbing.set(false);
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
    // Asked before anything is saved: "Cancel" leaves the sheet as typed, for Save sheet.
    if (retranslate && !(await this.confirmRedub('translation'))) return;
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
      if (retranslate) await this.runRedub('translation');
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.ctxSaving.set(false);
    }
  }
}
