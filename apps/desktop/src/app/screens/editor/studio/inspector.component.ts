import type { ElementRef } from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

import { splitSubtitleLines, VOICE_ENGINE_PROVIDER } from '@videodubber/shared';

import { TranslatePipe } from '../../../core/i18n';
import type { VoiceProfile } from '../../../core/models';
import { formatTimecode } from '../../../core/util/format';
import { VoiceCloneDialogComponent } from '../../../shared/voice-library/voice-clone-dialog.component';
import { PlaybackService } from './playback.service';
import { MAX_CPS, StudioStore, type LineVm } from './studio.store';
import { VOICE_DRAG_TYPE } from './timeline.component';
import { constrainDrag, MIN_SEGMENT_MS, parseTimecode, type DragEdge } from './timeline-math';

/**
 * The inspector: everything about the selected line, editable in place.
 * With several lines selected it becomes a bulk editor (voice, rate, lock,
 * shift, regenerate) — the same operations the timeline's drag & drop does.
 */
@Component({
  selector: 'vd-inspector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, NgTemplateOutlet, VoiceCloneDialogComponent],
  templateUrl: './inspector.component.html',
  styleUrl: './inspector.component.scss',
})
export class InspectorComponent {
  protected readonly store = inject(StudioStore);
  protected readonly playback = inject(PlaybackService);
  private readonly textArea = viewChild<ElementRef<HTMLTextAreaElement>>('text');
  private readonly timeInput = viewChild<ElementRef<HTMLInputElement>>('timeInput');

  protected readonly maxCps = MAX_CPS;
  protected readonly fmt = formatTimecode;
  protected readonly nudges = [-100, -10, 10, 100];
  protected readonly edges = ['start', 'end'] as const;
  protected readonly edgeKeys: Record<'start' | 'end', string> = {
    start: 'studio.start',
    end: 'studio.end',
  };
  protected readonly voiceFromKeys: Record<'line' | 'speaker' | 'project', string> = {
    line: 'studio.voice-from-line',
    speaker: 'studio.voice-from-speaker',
    project: 'studio.voice-from-project',
  };
  protected readonly rates = [0.85, 0.9, 1, 1.1, 1.2];
  protected readonly editingTime = signal<{ edge: DragEdge; value: string } | null>(null);

  protected readonly line = this.store.primary;
  protected readonly multi = computed(() => this.store.selection().size > 1);
  protected readonly selectedIds = computed(() => [...this.store.selection()]);

  protected readonly unit = computed(() => {
    const l = this.line();
    return l ? (this.store.unitBySegment().get(l.seg.id) ?? null) : null;
  });

  protected readonly wrapped = computed(() => splitSubtitleLines(this.line()?.text ?? '', 42, 2));

  /** The per-line checks' findings (lineQuality.ts in the orchestrator): label + explanation keys. */
  protected readonly qualityLabels: Record<LineVm['quality'][number], { label: string; title: string }> = {
    untranslated: { label: 'editor.untranslated', title: 'editor.untranslated-title' },
    'wrong-script': { label: 'editor.quality.wrong-script', title: 'editor.quality.wrong-script-title' },
    pinyin: { label: 'editor.quality.pinyin', title: 'editor.quality.pinyin-title' },
    alternatives: { label: 'editor.quality.alternatives', title: 'editor.quality.alternatives-title' },
    'no-diacritics': { label: 'editor.quality.no-diacritics', title: 'editor.quality.no-diacritics-title' },
  };
  protected readonly duration = computed(() => {
    const l = this.line();
    return l ? l.seg.endMs - l.seg.startMs : 0;
  });

  protected readonly voice = computed(() => {
    const l = this.line();
    return l ? this.store.effectiveVoice(l.seg) : null;
  });

  /** Rate shown on the slider (the line's own, or 1). */
  protected readonly rate = computed(() => this.line()?.seg.speakingRate ?? 1);

  /** The line's own voice (none with several lines selected: they may differ). */
  protected readonly lineVoiceId = computed(() => (this.multi() ? null : (this.line()?.seg.voiceId ?? null)));
  /**
   * The line's own voice when the list does not offer it (a voice of another
   * engine, or not loaded yet): shown as itself, never as the project voice.
   */
  protected readonly lineVoiceUnlisted = computed(() => {
    const id = this.lineVoiceId();
    return id && !this.store.voices().some((v) => v.id === id) ? id : null;
  });

  /** The lines a voice is being made from (the dialog is open), or null. */
  protected readonly voiceDialogLines = signal<readonly string[] | null>(null);
  /** The voice just made, and whether the lines now use it. */
  protected readonly madeVoice = signal<{ name: string; applied: boolean } | null>(null);

  constructor() {
    // A timecode field appears in place of its button: focus + select it.
    effect(() => {
      const el = this.timeInput()?.nativeElement;
      if (el) queueMicrotask(() => el.select());
    });
  }

  /** Focus the translation box (double-click on a cue, Enter). */
  focusText(): void {
    queueMicrotask(() => this.textArea()?.nativeElement.focus());
  }

  protected onText(value: string): void {
    const l = this.line();
    if (l) this.store.setText(l.seg.id, value);
  }

  protected nudge(edge: DragEdge, deltaMs: number): void {
    const l = this.line();
    if (!l) return;
    const segs = this.store.segments();
    const i = this.store.indexById().get(l.seg.id) ?? -1;
    if (i < 0) return;
    const next = constrainDrag(segs, i, edge, deltaMs, this.store.durationMs());
    this.store.setTiming(
      [{ id: l.seg.id, ...next }],
      edge === 'move' ? 'studio.undo-move' : 'studio.undo-trim',
      `${l.seg.id}:nudge-${edge}`,
    );
  }

  /** Set an edge (or the whole line) to the playhead. */
  protected toPlayhead(edge: 'start' | 'end'): void {
    const l = this.line();
    if (!l) return;
    const t = Math.round(this.playback.currentMs());
    this.nudge(edge, edge === 'start' ? t - l.seg.startMs : t - l.seg.endMs);
  }

  protected beginTimeEdit(edge: DragEdge): void {
    const l = this.line();
    if (!l) return;
    this.editingTime.set({
      edge,
      value: formatTimecode(edge === 'end' ? l.seg.endMs : l.seg.startMs),
    });
  }

  protected commitTimeEdit(edge: DragEdge, raw: string): void {
    this.editingTime.set(null);
    const l = this.line();
    const ms = parseTimecode(raw);
    if (!l || ms === null) return;
    this.nudge(edge, edge === 'end' ? ms - l.seg.endMs : ms - l.seg.startMs);
  }

  protected setVoice(value: string): void {
    const ids = this.selectedIds().length
      ? this.selectedIds()
      : this.line()
        ? [this.line()!.seg.id]
        : [];
    this.store.setVoice(ids, value === '' ? null : value);
  }

  protected setRate(value: number): void {
    const ids = this.selectedIds().length
      ? this.selectedIds()
      : this.line()
        ? [this.line()!.seg.id]
        : [];
    this.store.setRate(ids, Math.abs(value - 1) < 1e-3 ? null : value, `rate:${ids.join(',')}`);
  }

  protected toggleLock(): void {
    const ids = this.selectedIds();
    const allLocked = ids.every(
      (id) => this.store.segments()[this.store.indexById().get(id) ?? -1]?.locked === true,
    );
    this.store.setLocked(ids, !allLocked);
  }

  protected shiftSelected(deltaMs: number): void {
    this.store.shift(this.selectedIds(), deltaMs, `shift:${this.selectedIds().join(',')}`);
  }

  protected playLine(): void {
    const l = this.line();
    const u = this.unit();
    if (!l) return;
    const end = u ? Math.max(l.seg.endMs, u.startMs + u.placedDurationMs) : l.seg.endMs;
    this.playback.playRange(l.seg.startMs, end);
  }

  /**
   * Re-voice what is selected, once per CLIP: re-voicing any member of a merged
   * clip re-voices all of its lines (it degroups), so asking for each member
   * separately would synthesize the same lines several times.
   */
  protected regenerate(): void {
    const units = this.store.unitBySegment();
    const ids = new Set<string>();
    for (const id of this.selectedIds()) ids.add(units.get(id)?.id ?? id);
    void this.store.regenerate([...ids].slice(0, 200));
  }

  /** "Make a voice from these lines": one speaker's lines, taken from the video. */
  protected openVoiceFromLines(): void {
    const ids = this.selectedIds().length ? this.selectedIds() : this.line() ? [this.line()!.seg.id] : [];
    if (ids.length === 0) return;
    this.madeVoice.set(null);
    // In timeline order: the server joins them in that order anyway.
    const order = this.store.indexById();
    this.voiceDialogLines.set([...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)));
  }

  /**
   * The new voice speaks the lines it was made from, when the project's engine
   * can use it (a VieNeu clone needs VieNeu-TTS 3.8: the run would refuse it
   * under another engine). Otherwise say how to use it. Undo takes it back.
   */
  protected onVoiceMade(profile: VoiceProfile, ids: readonly string[]): void {
    this.store.voicesVersion.update((n) => n + 1);
    const usable = this.store.settings()?.ttsProviderId === VOICE_ENGINE_PROVIDER[profile.engine];
    if (usable) this.store.setVoice(ids, profile.id);
    this.madeVoice.set({ name: profile.name, applied: usable });
  }

  protected onVoiceDragStart(e: DragEvent, voiceId: string): void {
    e.dataTransfer?.setData(VOICE_DRAG_TYPE, voiceId);
    e.dataTransfer?.setData('text/plain', voiceId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
  }

  protected cpsLevel(cps: number): 'ok' | 'warn' | 'bad' {
    return cps > this.maxCps * 1.25 ? 'bad' : cps > this.maxCps ? 'warn' : 'ok';
  }

  protected readonly minLineMs = MIN_SEGMENT_MS;
}
