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
import type { AppError } from '../../core/models';
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
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.loading.set(false);
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
      const result = await this.ipc.synthesizeSingleSegment(this.id(), segmentId, {
        text: text.length > 0 ? text : undefined,
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
