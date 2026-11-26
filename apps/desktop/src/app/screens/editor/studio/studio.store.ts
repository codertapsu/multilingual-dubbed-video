import { Injectable, computed, inject, signal, type OnDestroy } from '@angular/core';

import {
  isFlaggedLine,
  nextSpeakerId,
  splitSubtitleLines,
  summarizeSpeakers,
  voiceForLine,
  warningDismissed,
  type LineVoiceSettings,
} from '@videodubber/shared';

import { IpcService } from '../../../core/ipc/ipc.service';
import { toAppError } from '../../../core/state/project.store';
import type {
  AlignedSegment,
  AppError,
  PipelineState,
  Project,
  SegmentPatch,
  TimelineDocument,
  TimelineFilmstrip,
  TimelineSegment,
} from '../../../core/models';
import type { PiperVoiceInfo } from '../../../core/models/setup';
import { clipOf, clipsToVoice } from './clips';
import { EditHistory, isEffective, type HistoryEntry, type LineChange, type LineFields } from './history';
import { applyFields, fieldsToPatch, patchToFields } from './line-fields';
import { StudioJobsService } from './studio-jobs.service';
import { charsPerSecond, constrainGroupMove, type Span } from './timeline-math';

/** Reading-speed ceiling (chars/s) — Netflix-style guidance for most languages. */
export const MAX_CPS = 17;
const LONG_SUBTITLE_CHARS = 84;
/** Debounce between the last edit and the save (ms). */
const SAVE_DEBOUNCE_MS = 450;
/**
 * How often the editor asks whether a dub of the project runs: often while
 * one runs or waits in the queue (to give the editor back the moment it
 * ends), rarely otherwise (a dub started from elsewhere: the queue, a series,
 * Claude over MCP).
 */
const RUN_POLL_ACTIVE_MS = 3000;
const RUN_POLL_IDLE_MS = 15_000;
/** Speaker detection's progress poll, and how many failed polls mean the backend is gone. */
const DETECT_POLL_MS = 1500;
const DETECT_MAX_MISSES = 10;

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
  /**
   * Still failing the checks: flagged, and neither kept as it is (locked) nor
   * a song, the server's rule (shared isFlaggedLine). The Flagged filter, the
   * editor's banner and the project's chip in the lists count these (H7).
   */
  flagged: boolean;
  long: boolean;
  fast: boolean;
  status: UnitVm['status'];
  stale: boolean;
  locked: boolean;
  problem: boolean;
}

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

/** What the lines list shows: everything, the problems, the lines still flagged by the checks, changed or locked ones. */
export type LinesFilter = 'all' | 'problems' | 'flagged' | 'changed' | 'locked';

/**
 * Why the last speaker detection ended without a result: it failed (the
 * server's words in `detail`), or it is gone: the backend stopped while it
 * ran. The backend saves the job in the project's folder and answers
 * `interrupted` for it after a restart (an older one forgot it), and the
 * editor used to wait for it forever.
 */
export interface DetectFailure {
  kind: 'failed' | 'gone';
  detail?: string;
}

type SpeakerJobState = NonNullable<Awaited<ReturnType<IpcService['getSpeakers']>>['job']> & {
  startedAt?: string;
  finishedAt?: string;
};

/** Two reads of the same server object (small: a project or its pipeline). */
function sameContent<T>(a: T, b: T): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

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
 * Provided by the editor component, so each open project gets a fresh store
 * (and loses it on leaving: work that must outlive the screen lives in
 * {@link StudioJobsService}, or on the server, and is picked up again here).
 */
@Injectable()
export class StudioStore implements OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly jobs = inject(StudioJobsService);

  readonly projectId = signal('');
  readonly loading = signal(false);
  readonly error = signal<AppError | null>(null);
  /**
   * Why "Tighten to fit" kept a line as it was (the model's proposal was not
   * shorter, failed the checks, or cut too far). Without it the button looked
   * like it did nothing. `reason` is the server's; the editor says it in words.
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

  /**
   * The project (settings drive the voice list, mix simulation, re-dub).
   * Compared by content: the run poll reads it every few seconds, and a copy
   * equal to the last one must not hand every form a new settings object (the
   * logo's periods field follows it and would lose what the user is typing).
   */
  readonly project = signal<Project | null>(null, { equal: sameContent });
  readonly settings = computed(() => this.project()?.settings ?? null);
  /** The project's pipeline as last read: the review checkpoint, the finished render. */
  readonly pipeline = signal<PipelineState | null>(null, { equal: sameContent });
  /**
   * A dub of this project is running. The server refuses every edit then
   * (RUN_IN_PROGRESS), yet the editor let the user make them: each one
   * failed, and the failure threw away the queued edits and the undo history.
   * While one runs the editor is read-only, says so and links to the
   * progress; Render and Re-dub ask before they stop it.
   */
  readonly dubRunning = computed(() => this.project()?.status === 'running');
  /** The dub waits at the review checkpoint: translated, no voice made yet. */
  readonly awaitingReview = computed(() => !this.dubRunning() && this.pipeline()?.awaitingReview === true);
  /** Lines that stopped the dub before voicing (holdFlaggedLines): they still fail the translation checks. */
  readonly heldCount = computed(() => (this.awaitingReview() ? (this.pipeline()?.heldLines?.length ?? 0) : 0));
  /** "Continue dubbing" (the toolbar's, at the review checkpoint) is on its way. */
  readonly continuing = signal(false);
  /** Voices the project's TTS engine offers here (installed ones). */
  readonly voices = signal<PiperVoiceInfo[]>([]);
  /**
   * Bumped when a voice was made in the editor from the project's video: the
   * project panel, which loads the voice lists, reloads them so every picker
   * offers the new voice.
   */
  readonly voicesVersion = signal(0);
  /** The side panel's tab (the shell shows it; the Project tab can switch to Line). */
  readonly sideTab = signal<'line' | 'project' | 'history'>('line');

  readonly selection = signal<ReadonlySet<string>>(new Set());
  /** The line the inspector shows (the last one clicked). */
  readonly primaryId = signal<string | null>(null);

  readonly saveState = signal<SaveState>('saved');
  /** Clips this editor is (re)synthesizing (by clip id: see clips.ts). */
  private readonly ownBusy = signal<ReadonlySet<string>>(new Set());
  /** Progress of a "voice all changed lines" batch (it outlives the editor: StudioJobsService). */
  readonly batch = computed(() => this.jobs.voicing(this.projectId()));
  /** Clips being (re)synthesized: this editor's, and the batch's current one. */
  readonly busy = computed<ReadonlySet<string>>(() => {
    const own = this.ownBusy();
    const clip = this.batch()?.clipId;
    return clip && !own.has(clip) ? new Set([...own, clip]) : own;
  });
  /** Bumped per unit when its WAV is rewritten in place (cache-busts previews). */
  readonly audioVersion = signal<Readonly<Record<string, number>>>({});

  private readonly history = new EditHistory();
  private readonly historyTick = signal(0);
  readonly canUndo = computed(() => (this.historyTick(), this.history.canUndo));
  readonly canRedo = computed(() => (this.historyTick(), this.history.canRedo));
  readonly undoLabel = computed(() => (this.historyTick(), this.history.peekUndo()?.label ?? null));
  readonly redoLabel = computed(() => (this.historyTick(), this.history.peekRedo()?.label ?? null));

  private pending = new Map<string, SegmentPatch>();
  /** The save on the wire; resolves false when the server refused it. */
  private inFlight: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private runTimer: ReturnType<typeof setTimeout> | undefined;
  private unwatchJobs: (() => void) | null = null;
  private disposed = false;

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
        flagged: isFlaggedLine(seg),
        long,
        fast,
        status,
        stale: seg.ttsStale === true,
        locked: seg.locked === true,
        problem:
          untranslated ||
          // A finding the user set aside (kept the line as it is) is no problem any more.
          (quality.length > 0 && seg.locked !== true) ||
          long ||
          status === 'timing-conflict' ||
          status === 'needs-review' ||
          seg.loopSuspect === true ||
          seg.speakerLowConfidence === true,
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
  /** Lines still failing the translation checks (LineVm.flagged), voiced as they are or not yet (H7). */
  readonly flaggedCount = computed(() => this.lines().filter((l) => l.flagged).length);
  /** The run's warning about them was dismissed: the banner keeps quiet, the lines stay marked. */
  readonly flagsSetAside = computed(() => warningDismissed(this.pipeline() ?? undefined, 'lines-flagged'));
  /** The lines list's filter, kept here so the banner's "Show them" can set it. */
  readonly linesFilter = signal<LinesFilter>('all');

  /** The banner's "Show them": the lines list shows only the flagged lines. */
  showFlagged(): void {
    this.linesFilter.set('flagged');
  }

  /** The clip a line is voiced in (a merged take's id is its first line's). */
  clipOf(segmentId: string): string {
    return clipOf(segmentId, this.unitBySegment());
  }

  /** The line's clip is being voiced (whichever of its lines asked). */
  isLineBusy(segmentId: string): boolean {
    return this.busy().has(this.clipOf(segmentId));
  }

  // ------------------------------------------------------------- loading

  async load(projectId: string): Promise<void> {
    this.projectId.set(projectId);
    this.loading.set(true);
    this.error.set(null);
    // A "voice the changed lines" batch may be running from an earlier visit:
    // follow it (its progress shows through `batch`), and show the error of
    // one that failed while the editor was closed.
    this.unwatchJobs?.();
    this.unwatchJobs = this.jobs.watch(projectId, {
      voiced: (doc, clipId) => {
        this.bumpAudio(clipId);
        this.adopt(doc);
      },
      failed: (error) => this.fail(error),
    });
    const failure = this.jobs.takeFailure(projectId);
    if (failure) this.error.set(failure);
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
    this.watchRun();
    void this.resumeDetection();
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

  // --------------------------------------------------------- the dub's run

  /** Re-read the project and its pipeline (what runs, the review checkpoint). */
  async refreshProject(): Promise<void> {
    const { project, pipeline } = await this.ipc.getProject(this.projectId());
    this.adoptProject(project, pipeline ?? null);
  }

  /** Take a freshly read project + pipeline (the project panel reads them at load). */
  adoptProject(project: Project, pipeline: PipelineState | null): void {
    const wasRunning = this.dubRunning();
    this.project.set(project);
    this.pipeline.set(pipeline);
    if (this.disposed) return;
    if (wasRunning && !this.dubRunning()) void this.afterRun();
    // A dub just started: from now on ask often, to hand the editor back soon.
    else if (!wasRunning && this.dubRunning()) this.watchRun();
  }

  /**
   * A dub ended while the editor was open. It rewrote the lines, so read them
   * again, and forget the undo history: an undo from before the dub would put
   * back text and timing it replaced.
   */
  private async afterRun(): Promise<void> {
    this.history.clear();
    this.historyTick.update((n) => n + 1);
    await this.reload();
    const doc = this.doc();
    // Opened before the audio was extracted: the tracks can be drawn now.
    if (doc && !this.waveform()) void this.loadMedia(doc);
  }

  private watchRun(): void {
    clearTimeout(this.runTimer);
    if (this.disposed) return;
    const status = this.project()?.status;
    const delay = status === 'running' || status === 'queued' ? RUN_POLL_ACTIVE_MS : RUN_POLL_IDLE_MS;
    this.runTimer = setTimeout(() => {
      this.refreshProject()
        .catch(() => undefined) // the backend is restarting: ask again at the next tick
        .finally(() => this.watchRun());
    }, delay);
  }

  /**
   * Pause the project's running dub (what it finished is kept) and wait until
   * it has stopped: Render and Re-dub save settings, voice lines or re-mix,
   * and the server refuses all of that while a dub runs.
   */
  async stopRunningDub(): Promise<boolean> {
    try {
      await this.ipc.pausePipeline(this.projectId());
      await this.refreshProject();
      return !this.dubRunning();
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** Leave the review checkpoint: save the edits, resume at synthesis. True once it started. */
  async continueDubbing(): Promise<boolean> {
    if (this.continuing()) return false;
    this.continuing.set(true);
    try {
      if (!(await this.flushNow())) return false;
      await this.ipc.retryPipelineStep(this.projectId(), 'tts');
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    } finally {
      this.continuing.set(false);
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

  /**
   * Record + apply + queue a set of line changes as ONE undoable edit. Nothing
   * while a dub runs: every edit path (drags, drops, shortcuts, the inspector)
   * comes through here, and the server would refuse it.
   */
  edit(changes: LineChange[], label: string, coalesceKey?: string): void {
    if (this.dubRunning()) return;
    const effective = changes.filter(isEffective);
    if (effective.length === 0) return;
    this.history.push({ label, changes: effective, ...(coalesceKey ? { coalesceKey } : {}), at: Date.now() });
    this.historyTick.update((n) => n + 1);
    this.applyAndQueue(effective.map((c) => ({ id: c.id, fields: c.after })));
  }

  undo(): void {
    if (this.dubRunning()) return;
    const entry = this.history.undo();
    if (!entry) return;
    this.historyTick.update((n) => n + 1);
    this.applyAndQueue(entry.changes.map((c) => ({ id: c.id, fields: c.before })));
  }

  redo(): void {
    if (this.dubRunning()) return;
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
    if (this.dubRunning()) return 0;
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
    if (!settings || this.dubRunning()) return false;
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
      this.fail(err);
      return false;
    }
  }

  /** Speaker detection is running (the Speakers section shows it). */
  readonly detectingSpeakers = signal(false);
  /** Its parts done, of the total (long audio is detected in 10-minute parts). */
  readonly detectProgress = signal<{ done: number; total: number } | null>(null);
  /** Why the last detection ended without a result (shown with a Retry), or null. */
  readonly detectFailure = signal<DetectFailure | null>(null);

  /**
   * Detect who says each line again (no new transcript, timing untouched):
   * the lines are relabelled, those whose voice moves are marked for
   * re-voicing. A background job on the server (hours of audio take an hour
   * or more): followed here until it ends, then the timeline is read again.
   * Asking while one runs follows that one (the server starts no second).
   */
  async detectSpeakers(numSpeakers?: number): Promise<boolean> {
    if (this.detectingSpeakers() || this.dubRunning()) return false;
    this.detectFailure.set(null);
    this.detectingSpeakers.set(true);
    this.detectProgress.set(null);
    try {
      if (!(await this.flushNow())) {
        this.detectingSpeakers.set(false);
        return false;
      }
      await this.ipc.detectSpeakers(this.projectId(), numSpeakers);
    } catch (err) {
      this.fail(err);
      this.detectingSpeakers.set(false);
      return false;
    }
    return this.followDetection();
  }

  /**
   * Follow the server's detection job to its end. Also one started before
   * this editor opened: leaving the editor used to drop the spinner while the
   * job went on, and the editor opened again knew nothing of it.
   */
  private async followDetection(): Promise<boolean> {
    this.detectingSpeakers.set(true);
    this.markDetecting(true);
    let misses = 0;
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, DETECT_POLL_MS));
        if (this.disposed) return false;
        let job: SpeakerJobState | undefined;
        try {
          job = (await this.ipc.getSpeakers(this.projectId())).job;
          misses = 0;
        } catch {
          // The backend may be restarting: give it a little while, then stop
          // spinning and offer Retry (it resumes from the parts already done).
          if (++misses < DETECT_MAX_MISSES) continue;
          this.detectFailure.set({ kind: 'gone' });
          return false;
        }
        // No job, or one saved as running that nothing runs: the backend restarted under it.
        if (!job || job.state === 'interrupted') {
          this.detectFailure.set({ kind: 'gone' });
          return false;
        }
        if (job.total) this.detectProgress.set({ done: job.done, total: job.total });
        if (job.state === 'running') continue;
        if (job.state === 'failed') {
          this.showDetectFailure(job);
          return false;
        }
        break;
      }
      this.adopt(await this.ipc.getTimeline(this.projectId()));
      await this.refreshProject();
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    } finally {
      this.detectingSpeakers.set(false);
      this.detectProgress.set(null);
      // Left mid-way, the mark stays for the next editor of the project to find.
      if (!this.disposed) this.markDetecting(false);
    }
  }

  /**
   * On opening: follow a detection still running, or say how one ended while
   * the editor was closed (failed, or lost with a backend restart).
   */
  private async resumeDetection(): Promise<void> {
    let job: SpeakerJobState | undefined;
    try {
      job = (await this.ipc.getSpeakers(this.projectId())).job;
    } catch {
      return; // the Speakers section works without it
    }
    if (this.disposed) return;
    if (job?.state === 'running') {
      if (!this.detectingSpeakers()) void this.followDetection();
      return;
    }
    const followed = this.wasDetecting();
    this.markDetecting(false);
    // Followed here before and the backend has no job now, or it saved one as
    // running when it stopped: it restarted under it. Said once per session.
    if (!job || job.state === 'interrupted') {
      if (followed || (job && !this.detectFailureSeen(job))) this.showDetectGone(job);
    } else if (job.state === 'failed' && !this.detectFailureSeen(job)) {
      this.showDetectFailure(job);
    }
  }

  /** The backend stopped while it detected: Retry resumes from the parts it saved. */
  private showDetectGone(job: SpeakerJobState | undefined): void {
    this.detectFailure.set({ kind: 'gone' });
    if (!job) return;
    try {
      sessionStorage.setItem(this.detectSeenKey(), job.finishedAt ?? job.startedAt ?? 'failed');
    } catch {
      /* storage disabled: it may show once more */
    }
  }

  /** A detection is being followed in this session (survives leaving the editor, not the app). */
  private markDetecting(on: boolean): void {
    try {
      if (on) sessionStorage.setItem(this.detectingKey(), '1');
      else sessionStorage.removeItem(this.detectingKey());
    } catch {
      /* storage disabled: a lost job is then only noticed while the editor is open */
    }
  }

  private wasDetecting(): boolean {
    try {
      return sessionStorage.getItem(this.detectingKey()) === '1';
    } catch {
      return false;
    }
  }

  private detectingKey(): string {
    return `vd.studio.detecting.${this.projectId()}`;
  }

  private showDetectFailure(job: SpeakerJobState): void {
    this.detectFailure.set({ kind: 'failed', ...(job.error ? { detail: job.error } : {}) });
    try {
      sessionStorage.setItem(this.detectSeenKey(), job.finishedAt ?? job.startedAt ?? 'failed');
    } catch {
      /* storage disabled: the failure may show once more */
    }
  }

  /** A failure already shown in this session is not shown again on every visit. */
  private detectFailureSeen(job: SpeakerJobState): boolean {
    try {
      return sessionStorage.getItem(this.detectSeenKey()) === (job.finishedAt ?? job.startedAt ?? 'failed');
    } catch {
      return false;
    }
  }

  private detectSeenKey(): string {
    return `vd.studio.detectSeen.${this.projectId()}`;
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
    if (this.dubRunning()) return 0;
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

  /**
   * Save now and wait (before regenerating, rendering or leaving). True when
   * everything it waited for reached the disk. It answers for THESE saves
   * only: it used to answer from the sticky save state, so after one refused
   * save Render, Regenerate, Tighten and Detect did nothing at all until the
   * message was dismissed.
   */
  async flushNow(): Promise<boolean> {
    clearTimeout(this.timer);
    let saved = true;
    while (this.inFlight || this.pending.size > 0) {
      // The request on the wire, else what is queued.
      if (!(await (this.inFlight ?? this.flush()))) saved = false;
    }
    return saved;
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

  private flush(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (this.pending.size === 0) {
      this.saveState.set('saved');
      return Promise.resolve(true);
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
        return true;
      } catch (err) {
        this.inFlight = null;
        this.fail(err);
        // Says "not saved" until the next save or the message is dismissed;
        // flushNow() no longer reads it, so it blocks nothing.
        this.saveState.set('error');
        // Never drift from disk: drop the refused batch AND everything queued
        // behind it, and show what the server actually holds.
        this.pending = new Map();
        this.history.clear();
        this.historyTick.update((n) => n + 1);
        await this.reload();
        return false;
      }
    })();
    return this.inFlight;
  }

  // ------------------------------------------------------------- actions

  /**
   * Re-voice the clips of these lines, one after another (the TTS engine is
   * one worker): each clip once, none already being voiced. They are marked
   * busy before the save below, so a second click meanwhile finds them busy
   * instead of queueing them again.
   */
  async regenerate(segmentIds: readonly string[], limit?: number): Promise<void> {
    if (this.dubRunning()) return;
    const clips = clipsToVoice(segmentIds, this.unitBySegment(), this.busy(), limit);
    if (clips.length === 0) return;
    for (const id of clips) this.markBusy(id, true);
    try {
      if (!(await this.flushNow())) return;
      for (const id of clips) {
        try {
          const res = await this.ipc.synthesizeSingleSegment(this.projectId(), id, {});
          this.bumpAudio(res.alignment.segmentId);
        } catch (err) {
          this.fail(err);
          break;
        } finally {
          this.markBusy(id, false);
        }
      }
      if (!this.disposed) await this.reload();
    } finally {
      for (const id of clips) this.markBusy(id, false);
    }
  }

  /**
   * Voice every line whose text/voice/rate changed. The batch belongs to the
   * app, not to this screen (StudioJobsService): leaving the editor no longer
   * hides it, and asking again while it runs joins it.
   */
  async regenerateStale(): Promise<void> {
    if (this.dubRunning()) return;
    if (!(await this.flushNow())) return;
    const pid = this.projectId();
    if (this.staleCount() === 0 && !this.jobs.voicing(pid)) return;
    await this.jobs.voiceStale(pid, this.staleCount());
    if (!this.disposed) await this.reload();
  }

  /** Re-translate one overflowing line shorter, then re-voice it. */
  async tighten(id: string): Promise<void> {
    if (this.dubRunning()) return;
    const clip = this.clipOf(id);
    if (this.busy().has(clip)) return;
    this.markBusy(clip, true);
    try {
      if (!(await this.flushNow())) return;
      const res = await this.ipc.refitSegment(this.projectId(), id);
      this.bumpAudio(res.alignment.segmentId);
      const n = this.lines().find((l) => l.seg.id === id)?.n ?? 0;
      this.tightenKept.set(res.shortened === false && res.reason ? { line: n, reason: res.reason } : null);
      if (!this.disposed) await this.reload();
    } catch (err) {
      this.fail(err);
    } finally {
      this.markBusy(clip, false);
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

  ngOnDestroy(): void {
    // The editor is gone: stop asking about the run and following jobs. A
    // detection or a voicing batch goes on without it and is picked up again
    // by the next editor of the project.
    this.disposed = true;
    clearTimeout(this.runTimer);
    this.unwatchJobs?.();
    this.unwatchJobs = null;
  }

  // -------------------------------------------------------------- helpers

  /**
   * Show an error. A refusal because a dub started (from the queue, a series
   * or Claude) re-reads the run at once, so the editor turns read-only now
   * rather than at its next poll.
   */
  private fail(err: unknown): void {
    const error = toAppError(err);
    this.error.set(error);
    if (error.code === 'RUN_IN_PROGRESS' && !this.disposed) void this.refreshProject().catch(() => undefined);
  }

  private byId(id: string): TimelineSegment | undefined {
    const i = this.indexById().get(id);
    return i === undefined ? undefined : this.segments()[i];
  }

  private markBusy(id: string, on: boolean): void {
    this.ownBusy.update((set) => {
      if (set.has(id) === on) return set;
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
