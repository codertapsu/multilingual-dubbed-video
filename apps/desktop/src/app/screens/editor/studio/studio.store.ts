import { Injectable, computed, inject, signal } from '@angular/core';

import { nextSpeakerId, splitSubtitleLines, summarizeSpeakers, voiceForLine, type LineVoiceSettings } from '@videodubber/shared';

import { IpcService } from '../../../core/ipc/ipc.service';
import { toAppError } from '../../../core/state/project.store';
import type {
  AlignedSegment,
  AppError,
  Project,
  SegmentPatch,
  TimelineDocument,
  TimelineFilmstrip,
  TimelineSegment,
} from '../../../core/models';
import type { PiperVoiceInfo } from '../../../core/models/setup';
import { EditHistory, isEffective, type HistoryEntry, type LineChange, type LineFields } from './history';
import { applyFields, fieldsToPatch, patchToFields } from './line-fields';
import { charsPerSecond, constrainGroupMove, type Span } from './timeline-math';

/** Reading-speed ceiling (chars/s) — Netflix-style guidance for most languages. */
export const MAX_CPS = 17;
const LONG_SUBTITLE_CHARS = 84;
/** Debounce between the last edit and the save (ms). */
const SAVE_DEBOUNCE_MS = 450;

/** One clip on the dub track, as drawn and as previewed. */
export interface UnitVm {
  id: string;
  segmentIds: string[];
  /** Where the clip starts playing (its first line's start — moves with a drag). */
  startMs: number;
  /** The window the clip was fitted into (first line start .. last line end). */
  endMs: number;
  /** On-timeline length after any speed-up (from the last fit). */
  placedDurationMs: number;
  speedRatio: number;
  overflowMs: number;
  status: AlignedSegment['status'] | 'none';
  note?: string;
  /** A member's text/voice/rate changed since the clip was synthesized. */
  stale: boolean;
  audioPath?: string;
  /** The part of the clip the mix plays (edge silence / an engine's noise cut off). */
  trim?: { startMs: number; endMs: number };
}

/** One line, enriched for the lists, the inspector and the timeline. */
export interface LineVm {
  seg: TimelineSegment;
  /** 1-based number shown to the user. */
  n: number;
  text: string;
  unitId?: string;
  isUnitHead: boolean;
  cps: number;
  untranslated: boolean;
  /**
   * What the pipeline's per-line checks found wrong with the machine's text
   * (Chinese characters left in, pinyin, "thầy/cô" alternatives…), after its
   * one repair attempt. Cleared when the user rewrites the line.
   */
  quality: NonNullable<TimelineSegment['qualityFlags']>;
  long: boolean;
  fast: boolean;
  status: UnitVm['status'];
  stale: boolean;
  locked: boolean;
  problem: boolean;
}

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
function norm(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').normalize('NFC');
}
/** Mirrors the orchestrator's looksUntranslated(): identical to the source AND worth flagging. */
function looksUntranslated(source: string, text: string): boolean {
  const s = norm(source);
  if (s.length < 2 || norm(text) !== s) return false;
  return CJK_RE.test(source) || s.length >= 15;
}

/**
 * The studio editor's state: the timeline document, the user's in-flight
 * edits, selection, history and the persistence queue.
 *
 * Edits are OPTIMISTIC: applied to `segments` immediately (a drag must feel
 * instant), recorded in the undo history, and queued per line. The queue is
 * flushed to PATCH /timeline after a short pause, one request at a time; the
 * response is the canonical document, and anything queued while it was in
 * flight is re-applied on top. If the server refuses an edit (INVALID_EDIT —
 * the timeline constraints should make that rare), the editor reloads rather
 * than drift from what is on disk.
 *
 * Provided by the editor component, so each open project gets a fresh store.
 */
@Injectable()
export class StudioStore {
  private readonly ipc = inject(IpcService);

  readonly projectId = signal('');
  readonly loading = signal(false);
  readonly error = signal<AppError | null>(null);
  /**
   * Why "Tighten to fit" kept a line as it was (the model's proposal was not
   * shorter, failed the checks, or cut too far). Without it the button looked
   * like it did nothing.
   */
  readonly tightenKept = signal<{ line: number; reason: string } | null>(null);

  private readonly doc = signal<TimelineDocument | null>(null);
  /** The lines as the user currently sees them (server state + pending edits). */
  readonly segments = signal<TimelineSegment[]>([]);
  readonly media = computed(() => this.doc()?.media ?? null);
  readonly translated = computed(() => this.doc()?.translated ?? false);
  readonly aligned = computed(() => this.doc()?.aligned ?? false);
  readonly cueOverrides = computed(() => this.doc()?.cueOverrides ?? {});

  readonly durationMs = computed(() => {
    const d = this.media()?.durationMs;
    if (d && d > 0) return d;
    const segs = this.segments();
    return segs.length ? segs[segs.length - 1]!.endMs + 2000 : 60_000;
  });

  /** Media for the timeline background tracks (best effort; null = not drawn). */
  readonly waveform = signal<{ peaksPerSecond: number; durationMs: number; peaks: Int8Array } | null>(null);
  readonly filmstrip = signal<(TimelineFilmstrip & { url: string }) | null>(null);

  /** The project (settings drive the voice list, mix simulation, re-dub). */
  readonly project = signal<Project | null>(null);
  readonly settings = computed(() => this.project()?.settings ?? null);
  /** Voices the project's TTS engine offers here (installed ones). */
  readonly voices = signal<PiperVoiceInfo[]>([]);
  /**
   * Bumped when a voice was made in the editor from the project's video: the
   * project panel, which loads the voice lists, reloads them so every picker
   * offers the new voice.
   */
  readonly voicesVersion = signal(0);
  /** The side panel's tab (the shell shows it; the Project tab can switch to Line). */
  readonly sideTab = signal<'line' | 'project'>('line');

  readonly selection = signal<ReadonlySet<string>>(new Set());
  /** The line the inspector shows (the last one clicked). */
  readonly primaryId = signal<string | null>(null);

  readonly saveState = signal<SaveState>('saved');
  /** Lines currently being (re)synthesized. */
  readonly busy = signal<ReadonlySet<string>>(new Set());
  /** Progress of a "voice all changed lines" batch. */
  readonly batch = signal<{ done: number; total: number } | null>(null);
  /** Bumped per unit when its WAV is rewritten in place (cache-busts previews). */
  readonly audioVersion = signal<Readonly<Record<string, number>>>({});

  private readonly history = new EditHistory();
  private readonly historyTick = signal(0);
  readonly canUndo = computed(() => (this.historyTick(), this.history.canUndo));
  readonly canRedo = computed(() => (this.historyTick(), this.history.canRedo));
  readonly undoLabel = computed(() => (this.historyTick(), this.history.peekUndo()?.label ?? null));
  readonly redoLabel = computed(() => (this.historyTick(), this.history.peekRedo()?.label ?? null));

  private pending = new Map<string, SegmentPatch>();
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  // ---------------------------------------------------------------- derived

  readonly indexById = computed(() => new Map(this.segments().map((s, i) => [s.id, i])));

  /** Dub clips, re-placed from the CURRENT line timing so a drag moves them live. */
  readonly units = computed<UnitVm[]>(() => {
    const doc = this.doc();
    if (!doc) return [];
    const segs = this.segments();
    const byId = new Map(segs.map((s) => [s.id, s]));
    return doc.units.flatMap((u): UnitVm[] => {
      const members = u.segmentIds.map((id) => byId.get(id)).filter((s): s is TimelineSegment => !!s);
      if (members.length === 0) return [];
      const a = u.alignment;
      return [
        {
          id: u.id,
          segmentIds: u.segmentIds,
          startMs: members[0]!.startMs,
          endMs: members[members.length - 1]!.endMs,
          placedDurationMs: a?.placedDurationMs ?? 0,
          speedRatio: a?.speedRatio ?? 1,
          overflowMs: a?.overflowMs ?? 0,
          status: a?.status ?? 'none',
          ...(a?.note ? { note: a.note } : {}),
          stale: members.some((m) => m.ttsStale === true),
          ...(a?.audioPath ? { audioPath: a.audioPath } : {}),
          ...(a?.trimStartMs !== undefined && a.trimEndMs !== undefined
            ? { trim: { startMs: a.trimStartMs, endMs: a.trimEndMs } }
            : {}),
        },
      ];
    });
  });

  readonly unitBySegment = computed(() => {
    const map = new Map<string, UnitVm>();
    for (const u of this.units()) for (const id of u.segmentIds) map.set(id, u);
    return map;
  });

  readonly lines = computed<LineVm[]>(() => {
    const unitOf = this.unitBySegment();
    return this.segments().map((seg, i) => {
      const text = seg.translatedText ?? '';
      const unit = unitOf.get(seg.id);
      const wrapped = splitSubtitleLines(text, 42, 2);
      const long = text.length > LONG_SUBTITLE_CHARS || wrapped.length > 2;
      const cps = charsPerSecond(text, seg.endMs - seg.startMs);
      const quality = (seg.qualityFlags ?? []).filter((f) => f !== 'untranslated');
      const untranslated =
        this.translated() && (looksUntranslated(seg.sourceText, text) || (seg.qualityFlags ?? []).includes('untranslated'));
      const status = unit?.status ?? 'none';
      const fast = cps > MAX_CPS;
      return {
        seg,
        n: i + 1,
        text,
        ...(unit ? { unitId: unit.id } : {}),
        isUnitHead: unit?.id === seg.id,
        cps,
        untranslated,
        quality,
        long,
        fast,
        status,
        stale: seg.ttsStale === true,
        locked: seg.locked === true,
        problem: untranslated || quality.length > 0 || long || status === 'timing-conflict' || status === 'needs-review',
      };
    });
  });

  readonly primary = computed<LineVm | null>(() => {
    const id = this.primaryId();
    if (!id) return null;
    const i = this.indexById().get(id);
    return i === undefined ? null : (this.lines()[i] ?? null);
  });

  readonly staleCount = computed(() => this.segments().filter((s) => s.ttsStale === true).length);
  readonly problemCount = computed(() => this.lines().filter((l) => l.problem).length);

  // ------------------------------------------------------------- loading

  async load(projectId: string): Promise<void> {
    this.projectId.set(projectId);
    this.loading.set(true);
    this.error.set(null);
    try {
      const doc = await this.ipc.getTimeline(projectId);
      this.adopt(doc);
      this.history.clear();
      this.historyTick.update((n) => n + 1);
      void this.loadMedia(doc);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** Re-read the document (after a regenerate / an external change). */
  async reload(): Promise<void> {
    try {
      this.adopt(await this.ipc.getTimeline(this.projectId()));
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  private adopt(doc: TimelineDocument): void {
    this.doc.set(doc);
    // Re-apply anything still queued (an edit made while a request was in flight).
    let segs = doc.segments;
    if (this.pending.size > 0) {
      const settings = this.settings() ?? {};
      segs = applyFields(segs, [...this.pending.values()].map(patchToFields), (line) => voiceForLine(line, settings));
    }
    this.segments.set(segs);
    // Keep the selection to lines that still exist.
    const ids = new Set(segs.map((s) => s.id));
    const sel = [...this.selection()].filter((id) => ids.has(id));
    if (sel.length !== this.selection().size) this.selection.set(new Set(sel));
    if (this.primaryId() && !ids.has(this.primaryId()!)) this.primaryId.set(sel[0] ?? null);
  }

  /** Waveform + filmstrip, in parallel and best-effort (an editor without them still works). */
  private async loadMedia(doc: TimelineDocument): Promise<void> {
    const pid = this.projectId();
    const [wave, film] = await Promise.allSettled([this.ipc.getWaveform(pid), this.ipc.getFilmstrip(pid)]);
    if (wave.status === 'fulfilled') {
      const bin = atob(wave.value.peaks);
      const peaks = new Int8Array(bin.length);
      for (let i = 0; i < bin.length; i++) peaks[i] = (bin.charCodeAt(i) << 24) >> 24;
      this.waveform.set({ peaksPerSecond: wave.value.peaksPerSecond, durationMs: wave.value.durationMs, peaks });
    }
    if (film.status === 'fulfilled') {
      this.filmstrip.set({ ...film.value, url: this.ipc.fileUrl(film.value.path, doc.media.durationMs ?? 0) });
    }
  }

  // ------------------------------------------------------------ selection

  select(id: string, mode: 'replace' | 'toggle' | 'range' = 'replace'): void {
    if (mode === 'toggle') {
      const next = new Set(this.selection());
      if (next.has(id)) next.delete(id);
      else next.add(id);
      this.selection.set(next);
      this.primaryId.set(next.has(id) ? id : ([...next][0] ?? null));
      return;
    }
    if (mode === 'range' && this.primaryId()) {
      const idx = this.indexById();
      const a = idx.get(this.primaryId()!) ?? 0;
      const b = idx.get(id) ?? 0;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      this.selection.set(new Set(this.segments().slice(lo, hi + 1).map((s) => s.id)));
      return;
    }
    this.selection.set(new Set([id]));
    this.primaryId.set(id);
  }

  clearSelection(): void {
    this.selection.set(new Set());
    this.primaryId.set(null);
  }

  /** Select the previous/next line relative to the primary one. */
  step(delta: number): TimelineSegment | null {
    const segs = this.segments();
    if (segs.length === 0) return null;
    const cur = this.primaryId() ? (this.indexById().get(this.primaryId()!) ?? -1) : -1;
    const i = Math.max(0, Math.min(segs.length - 1, cur + delta));
    this.select(segs[i]!.id);
    return segs[i]!;
  }

  lineAt(ms: number): TimelineSegment | null {
    for (const s of this.segments()) if (s.startMs <= ms && ms < s.endMs) return s;
    return null;
  }

  // ---------------------------------------------------------------- edits

  /** Record + apply + queue a set of line changes as ONE undoable edit. */
  edit(changes: LineChange[], label: string, coalesceKey?: string): void {
    const effective = changes.filter(isEffective);
    if (effective.length === 0) return;
    this.history.push({ label, changes: effective, ...(coalesceKey ? { coalesceKey } : {}), at: Date.now() });
    this.historyTick.update((n) => n + 1);
    this.applyAndQueue(effective.map((c) => ({ id: c.id, fields: c.after })));
  }

  undo(): void {
    const entry = this.history.undo();
    if (!entry) return;
    this.historyTick.update((n) => n + 1);
    this.applyAndQueue(entry.changes.map((c) => ({ id: c.id, fields: c.before })));
  }

  redo(): void {
    const entry = this.history.redo();
    if (!entry) return;
    this.historyTick.update((n) => n + 1);
    this.applyAndQueue(entry.changes.map((c) => ({ id: c.id, fields: c.after })));
  }

  /** Change the translation of one line (typing coalesces into one undo step). */
  setText(id: string, text: string): void {
    const seg = this.byId(id);
    if (!seg) return;
    this.edit(
      [
        {
          id,
          // Lock explicitly on both sides so an undo restores the old lock state
          // too (the server would otherwise re-lock on the text change).
          before: { translatedText: seg.translatedText ?? '', locked: seg.locked === true },
          after: { translatedText: text, locked: true },
        },
      ],
      'studio.undo-text',
      `${id}:text`,
    );
  }

  /** Set absolute timing for lines (drags + timecode fields). */
  setTiming(updates: { id: string; startMs: number; endMs: number }[], label = 'studio.undo-timing', coalesceKey?: string): void {
    const changes: LineChange[] = [];
    for (const u of updates) {
      const seg = this.byId(u.id);
      if (!seg) continue;
      changes.push({
        id: u.id,
        before: { startMs: seg.startMs, endMs: seg.endMs },
        after: { startMs: Math.round(u.startMs), endMs: Math.round(u.endMs) },
      });
    }
    this.edit(changes, label, coalesceKey);
  }

  /** Shift lines by `deltaMs`, clamped so nothing crosses an unselected neighbour. */
  shift(ids: readonly string[], deltaMs: number, coalesceKey?: string): number {
    const segs = this.segments();
    const set = new Set(ids);
    const delta = constrainGroupMove(segs as Span[], set, deltaMs, this.durationMs());
    if (delta === 0) return 0;
    this.setTiming(
      segs.filter((s) => set.has(s.id)).map((s) => ({ id: s.id, startMs: s.startMs + delta, endMs: s.endMs + delta })),
      'studio.undo-move',
      coalesceKey,
    );
    return delta;
  }

  setVoice(ids: readonly string[], voiceId: string | null): void {
    this.edit(
      ids.flatMap((id) => {
        const seg = this.byId(id);
        return seg ? [{ id, before: { voiceId: seg.voiceId ?? null }, after: { voiceId } }] : [];
      }),
      'studio.undo-voice',
    );
  }

  setRate(ids: readonly string[], rate: number | null, coalesceKey?: string): void {
    this.edit(
      ids.flatMap((id) => {
        const seg = this.byId(id);
        return seg ? [{ id, before: { speakingRate: seg.speakingRate ?? null }, after: { speakingRate: rate } }] : [];
      }),
      'studio.undo-rate',
      coalesceKey,
    );
  }

  /** Say who says these lines (null: nobody), as one undoable edit. */
  setSpeaker(ids: readonly string[], speakerId: string | null): void {
    this.edit(
      ids.flatMap((id) => {
        const seg = this.byId(id);
        return seg ? [{ id, before: { speakerId: seg.speakerId ?? null }, after: { speakerId } }] : [];
      }),
      'studio.undo-speaker',
    );
  }

  /** The speakers in the transcript, most speech first. */
  readonly speakers = computed(() => summarizeSpeakers(this.segments()));

  /** The id a new speaker would get. */
  newSpeakerId(): string {
    return nextSpeakerId(this.speakers().map((s) => s.speakerId));
  }

  /**
   * Give a speaker a voice (null: back to the project voice), applied at once
   * like a line's voice: the server marks the lines whose voice moves, and the
   * reload shows them as needing re-voicing. A project setting, so not undone
   * with the line edits.
   */
  async setSpeakerVoice(speakerId: string, voiceId: string | null): Promise<boolean> {
    const settings = this.settings();
    if (!settings) return false;
    const rest = (settings.speakerVoices ?? []).filter((v) => v.speakerId !== speakerId);
    try {
      if (!(await this.flushNow())) return false;
      const updated = await this.ipc.updateProjectSettings(this.projectId(), {
        speakerVoices: voiceId ? [...rest, { speakerId, voiceId }] : rest,
      });
      this.project.set(updated.project);
      await this.reload();
      return true;
    } catch (err) {
      this.error.set(toAppError(err));
      return false;
    }
  }

  /** Speaker detection is running (the Speakers section shows it). */
  readonly detectingSpeakers = signal(false);

  /**
   * Detect who says each line again (no new transcript, timing untouched):
   * the lines are relabelled, those whose voice moves are marked for re-voicing.
   */
  async detectSpeakers(numSpeakers?: number): Promise<boolean> {
    if (this.detectingSpeakers()) return false;
    this.detectingSpeakers.set(true);
    try {
      if (!(await this.flushNow())) return false;
      this.adopt(await this.ipc.detectSpeakers(this.projectId(), numSpeakers));
      const { project } = await this.ipc.getProject(this.projectId());
      this.project.set(project);
      return true;
    } catch (err) {
      this.error.set(toAppError(err));
      return false;
    } finally {
      this.detectingSpeakers.set(false);
    }
  }

  /** One person detected as two: give every line of `from` to `into` (one undo step). */
  mergeSpeaker(from: string, into: string): void {
    if (from === into) return;
    const ids = this.segments()
      .filter((s) => s.speakerId === from)
      .map((s) => s.id);
    this.setSpeaker(ids, into);
  }

  /** Select every line of one speaker. */
  selectSpeaker(speakerId: string): void {
    const ids = this.segments()
      .filter((s) => s.speakerId === speakerId)
      .map((s) => s.id);
    this.selection.set(new Set(ids));
    this.primaryId.set(ids[0] ?? null);
  }

  setLocked(ids: readonly string[], locked: boolean): void {
    this.edit(
      ids.flatMap((id) => {
        const seg = this.byId(id);
        return seg ? [{ id, before: { locked: seg.locked === true }, after: { locked } }] : [];
      }),
      'studio.undo-lock',
    );
  }

  /** Replace translations in bulk (subtitle import) as one undo step. */
  importTexts(texts: Map<string, string>): number {
    const changes: LineChange[] = [];
    for (const [id, text] of texts) {
      const seg = this.byId(id);
      if (!seg) continue;
      changes.push({
        id,
        before: { translatedText: seg.translatedText ?? '', locked: seg.locked === true },
        after: { translatedText: text, locked: true },
      });
    }
    const effective = changes.filter(isEffective);
    this.edit(effective, 'studio.undo-import');
    return effective.length;
  }

  // ---------------------------------------------------------- persistence

  hasUnsavedChanges(): boolean {
    return this.pending.size > 0 || this.inFlight !== null;
  }

  /** Save now and wait (before regenerating, rendering or leaving). */
  async flushNow(): Promise<boolean> {
    clearTimeout(this.timer);
    while (this.inFlight || this.pending.size > 0) {
      if (this.inFlight) await this.inFlight;
      else await this.flush();
    }
    return this.saveState() !== 'error';
  }

  private applyAndQueue(items: { id: string; fields: LineFields }[]): void {
    const settings = this.settings() ?? {};
    this.segments.update((segs) => applyFields(segs, items, (line) => voiceForLine(line, settings)));
    for (const { id, fields } of items) {
      const prev = this.pending.get(id) ?? { id };
      this.pending.set(id, { ...prev, ...fieldsToPatch(fields) });
    }
    this.saveState.set('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS);
  }

  private flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.pending.size === 0) {
      this.saveState.set('saved');
      return Promise.resolve();
    }
    const batch = [...this.pending.values()];
    this.pending = new Map();
    this.saveState.set('saving');
    this.inFlight = (async () => {
      try {
        const doc = await this.ipc.patchTimeline(this.projectId(), batch);
        this.inFlight = null;
        this.adopt(doc);
        this.saveState.set(this.pending.size > 0 ? 'pending' : 'saved');
        if (this.pending.size > 0) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS);
        }
      } catch (err) {
        this.inFlight = null;
        this.error.set(toAppError(err));
        this.saveState.set('error');
        // Never drift from disk: drop the refused batch AND everything queued
        // behind it, and show what the server actually holds.
        this.pending = new Map();
        this.history.clear();
        this.historyTick.update((n) => n + 1);
        await this.reload();
      }
    })();
    return this.inFlight;
  }

  // ------------------------------------------------------------- actions

  /** Re-synthesize lines (sequentially — the TTS engine is one worker). */
  async regenerate(ids: readonly string[]): Promise<void> {
    if (!(await this.flushNow())) return;
    for (const id of ids) {
      this.markBusy(id, true);
      try {
        const res = await this.ipc.synthesizeSingleSegment(this.projectId(), id, {});
        this.bumpAudio(res.alignment.segmentId);
      } catch (err) {
        this.error.set(toAppError(err));
        break;
      } finally {
        this.markBusy(id, false);
      }
    }
    await this.reload();
  }

  /**
   * Voice every line whose text/voice/rate changed. Regenerating one member of
   * a merged clip re-voices ALL its members (it degroups), so the stale list is
   * re-read after each line instead of being fixed up front.
   */
  async regenerateStale(): Promise<void> {
    if (!(await this.flushNow())) return;
    const total = this.staleCount();
    if (total === 0) return;
    this.batch.set({ done: 0, total });
    try {
      for (let guard = 0; guard < total + 5; guard++) {
        const next = this.segments().find((s) => s.ttsStale === true);
        if (!next) break;
        this.markBusy(next.id, true);
        try {
          const res = await this.ipc.synthesizeSingleSegment(this.projectId(), next.id, {});
          this.bumpAudio(res.alignment.segmentId);
        } finally {
          this.markBusy(next.id, false);
        }
        await this.reload();
        this.batch.set({ done: total - this.staleCount(), total });
      }
    } catch (err) {
      this.error.set(toAppError(err));
      await this.reload();
    } finally {
      this.batch.set(null);
    }
  }

  /** Re-translate one overflowing line shorter, then re-voice it. */
  async tighten(id: string): Promise<void> {
    if (!(await this.flushNow())) return;
    this.markBusy(id, true);
    try {
      const res = await this.ipc.refitSegment(this.projectId(), id);
      this.bumpAudio(res.alignment.segmentId);
      const n = this.lines().find((l) => l.seg.id === id)?.n ?? 0;
      this.tightenKept.set(res.shortened === false && res.reason ? { line: n, reason: res.reason } : null);
      await this.reload();
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.markBusy(id, false);
    }
  }

  /**
   * The URL the preview plays for a unit: cut and fitted like the final mix
   * when the mix trims or speeds it up, else the clip itself.
   */
  clipUrl(unit: UnitVm): string | null {
    if (!unit.audioPath || unit.status === 'none') return null;
    const v = `${unit.placedDurationMs}-${this.audioVersion()[unit.id] ?? 0}`;
    return unit.speedRatio > 1.001 || unit.trim
      ? this.ipc.fittedClipUrl(this.projectId(), unit.id, unit.speedRatio, v, unit.trim)
      : this.ipc.fileUrl(unit.audioPath, v);
  }

  videoUrl(): string | null {
    const m = this.media();
    return m ? this.ipc.fileUrl(m.videoPath) : null;
  }

  /** Human label of a voice id (falls back to the id itself). */
  voiceLabel(id: string | undefined | null): string {
    if (!id) return '';
    return this.voices().find((v) => v.id === id)?.label ?? id;
  }

  /** The voice a line would be spoken with: its own, its speaker's, or the project's (shared voiceForLine). */
  effectiveVoice(seg: TimelineSegment): { id: string | undefined; source: 'line' | 'speaker' | 'project' } {
    const s: LineVoiceSettings = this.settings() ?? {};
    const assigned = !!seg.speakerId && (s.speakerVoices ?? []).some((v) => v.speakerId === seg.speakerId);
    return { id: voiceForLine(seg, s), source: seg.voiceId ? 'line' : assigned ? 'speaker' : 'project' };
  }

  dismissError(): void {
    this.error.set(null);
    if (this.saveState() === 'error') this.saveState.set(this.pending.size ? 'pending' : 'saved');
  }

  /** The most recent undoable entry (for tests/tooling). */
  lastEntry(): HistoryEntry | undefined {
    return this.history.peekUndo();
  }

  // -------------------------------------------------------------- helpers

  private byId(id: string): TimelineSegment | undefined {
    const i = this.indexById().get(id);
    return i === undefined ? undefined : this.segments()[i];
  }

  private markBusy(id: string, on: boolean): void {
    this.busy.update((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  private bumpAudio(unitId: string): void {
    this.audioVersion.update((v) => ({ ...v, [unitId]: (v[unitId] ?? 0) + 1 }));
  }
}
