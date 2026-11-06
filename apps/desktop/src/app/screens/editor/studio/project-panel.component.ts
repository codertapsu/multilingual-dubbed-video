import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { IpcService } from '../../../core/ipc/ipc.service';
import { toAppError } from '../../../core/state/project.store';
import { TranslatePipe } from '../../../core/i18n';
import { PIPELINE_STEP_LABELS, PROCESSING_MODE_LABELS, SUBTITLE_EXPORT_MODE_LABELS, ALL_SUBTITLE_EXPORT_MODES } from '../../../core/util/format';
import {
  DUCKING_OPTIONS,
  earliestStepForChanges,
  ORIGINAL_AUDIO_MODE_LABELS,
  REDUB_STAGES,
  RENDER_QUALITY_LABELS,
  SPEED_OPTIONS,
  TIME_STRETCH_ENGINE_LABELS,
  ttsEngineParam,
} from '../../../core/util/settings-options';
import type {
  OriginalAudioMode,
  PipelineStepId,
  ProjectSettings,
  RenderQuality,
  SubtitleExportMode,
  TranslationDocContext,
} from '../../../core/models';
import type { PiperVoiceInfo, ProviderInfo, ProvidersResponse, WhisperModelInfo } from '../../../core/models/setup';
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
  imports: [FormsModule, RouterLink, TranslatePipe],
  templateUrl: './project-panel.component.html',
  styleUrl: './project-panel.component.scss',
})
export class ProjectPanelComponent implements OnInit {
  private readonly ipc = inject(IpcService);
  private readonly router = inject(Router);
  protected readonly store = inject(StudioStore);

  protected readonly stepLabels = PIPELINE_STEP_LABELS;
  protected readonly redubStages = REDUB_STAGES;
  protected readonly originalAudioModeLabels = ORIGINAL_AUDIO_MODE_LABELS;
  protected readonly renderQualityLabels = RENDER_QUALITY_LABELS;
  protected readonly timeStretchLabels = TIME_STRETCH_ENGINE_LABELS;
  protected readonly subtitleLabels = SUBTITLE_EXPORT_MODE_LABELS;
  protected readonly processingLabels = PROCESSING_MODE_LABELS;
  protected readonly duckingOptions = DUCKING_OPTIONS;
  protected readonly speedOptions = SPEED_OPTIONS;
  protected readonly renderQualities: readonly RenderQuality[] = ['quality', 'fast'];
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
  protected readonly opening = signal(false);
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
  }

  /**
   * Voices for a TTS engine. The CURRENT engine's installed voices also feed the
   * studio's per-line voice picker (only voices on disk: a missing one would
   * fail at synthesis); the full list feeds the default-voice picker here.
   */
  private async reloadVoices(ttsProviderId: string | undefined, language: string, forStudio: boolean): Promise<void> {
    const engine = ttsEngineParam(ttsProviderId);
    if (!engine) {
      this.draftVoices.set([]);
      if (forStudio) this.store.voices.set([]);
      return;
    }
    try {
      const [voices, status] = await Promise.all([
        this.ipc.setupListVoices(language, engine),
        this.ipc.setupGetStatus().catch(() => null),
      ]);
      this.draftVoices.set(voices);
      if (forStudio) {
        const usable =
          status && engine === 'piper'
            ? voices.filter((v) => status.installed.piperVoices.includes(v.id) || v.id === this.store.settings()?.ttsVoiceId)
            : voices;
        this.store.voices.set(usable);
      }
    } catch {
      this.draftVoices.set([]);
      if (forStudio) this.store.voices.set([]);
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

  async openFolder(): Promise<void> {
    const dir = this.store.project()?.outputDir;
    if (!dir || this.opening()) return;
    this.opening.set(true);
    try {
      await this.ipc.openOutputFolder(dir);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.opening.set(false);
    }
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
