import { Injectable, computed, inject, signal } from '@angular/core';

import { splitSubtitleLines } from '@videodubber/shared';

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
      const untranslated = this.translated() && looksUntranslated(seg.sourceText, text);
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
        long,
        fast,
        status,
        stale: seg.ttsStale === true,
        locked: seg.locked === true,
        problem: untranslated || long || status === 'timing-conflict' || status === 'needs-review',
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
    if (this.pending.size > 0) segs = applyFields(segs, [...this.pending.values()].map(patchToFields));
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
    this.segments.update((segs) => applyFields(segs, items));
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
      await this.reload();
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.markBusy(id, false);
    }
  }

  /** The URL the preview plays for a unit (fitted like the final mix when sped up). */
  clipUrl(unit: UnitVm): string | null {
    if (!unit.audioPath || unit.status === 'none') return null;
    const v = `${unit.placedDurationMs}-${this.audioVersion()[unit.id] ?? 0}`;
    return unit.speedRatio > 1.001
      ? this.ipc.fittedClipUrl(this.projectId(), unit.id, unit.speedRatio, v)
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

  /** The voice a line would be spoken with: its own, its speaker's, or the project's. */
  effectiveVoice(seg: TimelineSegment): { id: string | undefined; source: 'line' | 'speaker' | 'project' } {
    if (seg.voiceId) return { id: seg.voiceId, source: 'line' };
    const s = this.settings();
    const speaker = seg.speakerId ? s?.speakerVoices?.find((v) => v.speakerId === seg.speakerId)?.voiceId : undefined;
    if (speaker) return { id: speaker, source: 'speaker' };
    return { id: s?.ttsVoiceId, source: 'project' };
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

/** Apply line fields to a copy of the segments (null clears an override). */
export function applyFields(
  segs: readonly TimelineSegment[],
  items: readonly { id: string; fields: LineFields }[],
): TimelineSegment[] {
  if (items.length === 0) return segs as TimelineSegment[];
  const byId = new Map(items.map((i) => [i.id, i.fields]));
  return segs.map((s) => {
    const f = byId.get(s.id);
    if (!f) return s;
    const next: TimelineSegment = { ...s };
    if (f.translatedText !== undefined && f.translatedText !== s.translatedText) {
      next.translatedText = f.translatedText;
      next.ttsStale = true;
    }
    if (f.startMs !== undefined) next.startMs = f.startMs;
    if (f.endMs !== undefined) next.endMs = f.endMs;
    if (f.voiceId !== undefined) {
      if (f.voiceId === null) delete next.voiceId;
      else next.voiceId = f.voiceId;
      if ((f.voiceId ?? undefined) !== s.voiceId) next.ttsStale = true;
    }
    if (f.speakingRate !== undefined) {
      if (f.speakingRate === null || Math.abs(f.speakingRate - 1) < 1e-3) delete next.speakingRate;
      else next.speakingRate = f.speakingRate;
      if ((next.speakingRate ?? undefined) !== s.speakingRate) next.ttsStale = true;
    }
    if (f.locked !== undefined) {
      if (f.locked) next.locked = true;
      else delete next.locked;
    }
    return next;
  });
}

function fieldsToPatch(f: LineFields): Omit<SegmentPatch, 'id'> {
  const p: Omit<SegmentPatch, 'id'> = {};
  if (f.translatedText !== undefined) p.translatedText = f.translatedText;
  if (f.startMs !== undefined) p.startMs = f.startMs;
  if (f.endMs !== undefined) p.endMs = f.endMs;
  if (f.voiceId !== undefined) p.voiceId = f.voiceId;
  if (f.speakingRate !== undefined) p.speakingRate = f.speakingRate;
  if (f.locked !== undefined) p.locked = f.locked;
  return p;
}

function patchToFields(p: SegmentPatch): { id: string; fields: LineFields } {
  const { id, ...rest } = p;
  return { id, fields: rest };
}
