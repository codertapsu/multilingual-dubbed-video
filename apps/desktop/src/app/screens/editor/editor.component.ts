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

import { splitSubtitleLines } from '@videodubber/shared';

import { environment } from '../../core/environment';
import { IpcService } from '../../core/ipc/ipc.service';
import { ProjectStore, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { formatTimecode } from '../../core/util/format';
import type { AppError, ProjectSettings } from '../../core/models';
import type { PiperVoiceInfo } from '../../core/models/setup';
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
 * The "long subtitle" warning is computed with the shared `splitSubtitleLines`
 * helper so the UI matches what the burned-in renderer will actually wrap.
 */
@Component({
  selector: 'vd-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorBannerComponent],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss',
})
export class EditorComponent implements OnInit {
  readonly id = input.required<string>();

  private readonly ipc = inject(IpcService);
  private readonly store = inject(ProjectStore);

  protected readonly formatTimecode = formatTimecode;

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

  /** The project's settings (provider + default voice + target language). */
  protected readonly projectSettings = signal<ProjectSettings | null>(null);
  /** Voices available for the project's target language (local Piper provider). */
  protected readonly availableVoices = signal<PiperVoiceInfo[]>([]);
  /** Per-segment voice override (segmentId -> voiceId); empty = project default. */
  protected readonly segmentVoiceOverrides = signal<Record<string, string>>({});

  /** Show the per-segment voice override only for the local Piper engine. */
  protected readonly showVoicePicker = computed(
    () => this.projectSettings()?.ttsProviderId === 'piper-local' && this.availableVoices().length > 0,
  );

  /** Label for the project's default voice (shown as the "Default" option). */
  protected readonly defaultVoiceLabel = computed(() => {
    const id = this.projectSettings()?.ttsVoiceId;
    if (!id) return 'auto';
    return this.availableVoices().find((v) => v.id === id)?.label ?? id;
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
      void this.loadProjectAndVoices();
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Load the project settings and, for the local Piper engine, the voices for
   * its target language — so each segment can be re-synthesized with a different
   * voice (e.g. to give a second speaker a distinct voice). Best-effort: a
   * failure here just hides the per-segment voice picker.
   */
  private async loadProjectAndVoices(): Promise<void> {
    try {
      const { project } = await this.ipc.getProject(this.id());
      this.projectSettings.set(project.settings);
      if (project.settings.ttsProviderId === 'piper-local') {
        const [voices, status] = await Promise.all([
          this.ipc.setupListVoices(project.settings.targetLanguage),
          this.ipc.setupGetStatus().catch(() => null),
        ]);
        // Only offer voices already on disk for a per-segment override — never a
        // voice that isn't installed (it would fail/stall at synth). The project's
        // default voice is always installed, so keep it. If the installed set
        // can't be read, fall back to the full list (best-effort, non-blocking).
        const usable = status
          ? voices.filter(
              (v) =>
                status.installed.piperVoices.includes(v.id) || v.id === project.settings.ttsVoiceId,
            )
          : voices;
        this.availableVoices.set(usable);
      }
    } catch {
      // Non-fatal: the editor still works without the voice override.
    }
  }

  protected onTranslationChange(segmentId: string, value: string): void {
    this.drafts.update((d) => ({ ...d, [segmentId]: value }));
    this.dirty.set(true);
  }

  protected draft(segmentId: string): string {
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
