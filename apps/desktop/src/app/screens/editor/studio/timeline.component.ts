import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type OnDestroy,
} from '@angular/core';

import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { ThemeService } from '../../../core/theme/theme.service';
import { PlaybackService } from './playback.service';
import { StudioStore, type UnitVm } from './studio.store';
import { matchCuesToLines, parseSubtitles } from './subtitle-import';
import {
  clampZoom,
  constrainDrag,
  constrainGroupMove,
  fitZoom,
  formatRulerLabel,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  rulerTicks,
  snapTo,
  visibleSpans,
  type DragEdge,
  type Span,
} from './timeline-math';

/** MIME type of a voice chip dragged from the inspector onto a line or clip. */
export const VOICE_DRAG_TYPE = 'application/x-vd-voice';

const ZOOM_KEY = 'vd.studio.pxPerSec';
const SNAP_PX = 8;
const DRAG_THRESHOLD_PX = 3;
const OVERSCAN_PX = 300;

interface Drag {
  kind: 'cue' | 'unit';
  pointerId: number;
  originX: number;
  ids: string[];
  edge: DragEdge;
  /** Timing of every segment at drag start (the constraint baseline). */
  base: Span[];
  started: boolean;
}

/**
 * The multi-track timeline: ruler, filmstrip, original waveform, source cues,
 * editable subtitle cues and the dub clips.
 *
 * Performance model (it must stay smooth on a two-hour video with thousands
 * of lines): the ruler, filmstrip and waveform are CANVASES the size of the
 * viewport, redrawn from the scroll position — their cost does not grow with
 * the video. Cues and clips are absolutely positioned DOM, but only those
 * intersecting the viewport (+ overscan) are rendered. A drag mutates a local
 * preview map, not the store, and commits ONE undoable edit on release.
 */
@Component({
  selector: 'vd-timeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  templateUrl: './timeline.component.html',
  styleUrl: './timeline.component.scss',
})
export class TimelineComponent implements OnDestroy {
  protected readonly store = inject(StudioStore);
  protected readonly playback = inject(PlaybackService);
  private readonly theme = inject(ThemeService);
  private readonly translate = inject(TranslateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly scrollEl = viewChild.required<ElementRef<HTMLDivElement>>('scroll');
  private readonly rulerCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('ruler');
  private readonly filmCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('film');
  private readonly waveCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('wave');

  readonly pxPerSec = signal(Number(localStorage.getItem(ZOOM_KEY)) || 0);
  /** True once the user zoomed (a stored zoom counts): stop auto-fitting. */
  private userZoomed = Number(localStorage.getItem(ZOOM_KEY)) > 0;
  readonly scrollLeft = signal(0);
  readonly viewportWidth = signal(1000);
  readonly snap = signal(true);
  readonly follow = signal(true);
  protected readonly dropTarget = signal<string | null>(null);
  protected readonly fileOver = signal(false);
  protected readonly importNote = signal<string | null>(null);

  /** Live positions of lines being dragged (the store is untouched until release). */
  protected readonly preview = signal<ReadonlyMap<string, { startMs: number; endMs: number }>>(new Map());
  protected readonly snapGuideMs = signal<number | null>(null);
  protected readonly dragTip = signal<{ ms: number; text: string } | null>(null);

  private drag: Drag | null = null;
  private filmImage: HTMLImageElement | null = null;
  private readonly filmReady = signal(0);
  private resizeObserver: ResizeObserver | null = null;
  private scrubbing = false;

  readonly pxPerMs = computed(() => this.pxPerSec() / 1000);
  readonly contentWidth = computed(() => Math.max(this.viewportWidth(), this.store.durationMs() * this.pxPerMs() + 200));
  private readonly visibleRange = computed(() => {
    const ppm = this.pxPerMs() || 0.1;
    return {
      from: Math.max(0, (this.scrollLeft() - OVERSCAN_PX) / ppm),
      to: (this.scrollLeft() + this.viewportWidth() + OVERSCAN_PX) / ppm,
    };
  });

  /** Lines with drag previews applied. */
  private readonly placedSegments = computed(() => {
    const p = this.preview();
    const segs = this.store.segments();
    if (p.size === 0) return segs;
    return segs.map((s) => {
      const t = p.get(s.id);
      return t ? { ...s, startMs: t.startMs, endMs: t.endMs } : s;
    });
  });

  protected readonly visibleLines = computed(() => {
    const { from, to } = this.visibleRange();
    const lines = this.store.lines();
    const placed = this.placedSegments();
    return visibleSpans(placed, from, to).map((s) => ({ seg: s, line: lines[this.store.indexById().get(s.id) ?? 0]! }));
  });

  protected readonly visibleUnits = computed(() => {
    const { from, to } = this.visibleRange();
    const p = this.preview();
    const units = this.store.units().map((u): UnitVm => {
      const head = p.get(u.segmentIds[0]!);
      const tail = p.get(u.segmentIds[u.segmentIds.length - 1]!);
      return head || tail ? { ...u, startMs: head?.startMs ?? u.startMs, endMs: tail?.endMs ?? u.endMs } : u;
    });
    const spans = units.map((u) => ({ ...u, endMs: u.startMs + Math.max(u.placedDurationMs, u.endMs - u.startMs) }));
    return visibleSpans(spans, from, to);
  });

  protected readonly playheadX = computed(() => this.playback.currentMs() * this.pxPerMs());

  /**
   * Level of detail: zoomed far out (a whole feature in one screen) a typical
   * line is a pixel or two wide, so cues drop their text and trim handles —
   * thousands of unreadable labels would only cost layout time.
   */
  protected readonly tiny = computed(() => this.pxPerSec() < 4);

  constructor() {
    // Fit the whole video until the user picks a zoom: the viewport is only
    // known after layout (and changes when panels open/close), so a one-shot
    // fit measured too early left a 40 s clip drawn across 70 s of ruler.
    effect(() => {
      const d = this.store.durationMs();
      const w = this.viewportWidth();
      if (!this.userZoomed && d > 0 && w > 100) this.pxPerSec.set(fitZoom(d, w));
    });
    // Redraw the canvases whenever what they show changes.
    effect(() => {
      this.scrollLeft();
      this.viewportWidth();
      this.pxPerSec();
      this.theme.effective();
      this.store.waveform();
      this.filmReady();
      this.store.durationMs();
      requestAnimationFrame(() => this.drawAll());
    });
    effect(() => {
      const film = this.store.filmstrip();
      if (!film) return;
      const img = new Image();
      img.onload = () => {
        this.filmImage = img;
        this.filmReady.update((n) => n + 1);
      };
      img.src = film.url;
    });
    // Follow the playhead while playing (page-flip, like every NLE).
    effect(() => {
      const x = this.playheadX();
      if (!this.follow() || !this.playback.playing() || this.drag) return;
      const el = this.scrollEl().nativeElement;
      const left = el.scrollLeft;
      const width = el.clientWidth;
      if (x > left + width - 40 || x < left) el.scrollLeft = Math.max(0, x - width * 0.1);
    });
  }

  ngAfterViewInit(): void {
    const el = this.scrollEl().nativeElement;
    this.viewportWidth.set(el.clientWidth);
    this.resizeObserver = new ResizeObserver(() => {
      this.viewportWidth.set(el.clientWidth);
    });
    this.resizeObserver.observe(el);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  // ----------------------------------------------------------------- zoom

  setZoom(pxPerSec: number, anchorX?: number): void {
    const el = this.scrollEl().nativeElement;
    const x = anchorX ?? el.clientWidth / 2;
    const tMs = (el.scrollLeft + x) / this.pxPerMs();
    const next = clampZoom(pxPerSec);
    this.userZoomed = true;
    this.pxPerSec.set(next);
    localStorage.setItem(ZOOM_KEY, String(next));
    // Keep the time under the cursor (or the centre) where it was.
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, tMs * (next / 1000) - x);
      this.scrollLeft.set(el.scrollLeft);
    });
  }

  zoomBy(factor: number): void {
    this.setZoom(this.pxPerSec() * factor);
  }

  /** The zoom slider is logarithmic: equal travel = equal zoom ratio. */
  protected zoomSlider(): number {
    const lo = Math.log(MIN_PX_PER_SEC);
    const hi = Math.log(MAX_PX_PER_SEC);
    return Math.round(((Math.log(clampZoom(this.pxPerSec() || 100)) - lo) / (hi - lo)) * 1000);
  }

  protected onZoomSlider(e: Event): void {
    const v = Number((e.target as HTMLInputElement).value) / 1000;
    this.setZoom(Math.exp(Math.log(MIN_PX_PER_SEC) + v * (Math.log(MAX_PX_PER_SEC) - Math.log(MIN_PX_PER_SEC))));
  }

  zoomToFit(): void {
    this.setZoom(fitZoom(this.store.durationMs(), this.viewportWidth()), 0);
    // "Fit" means keep fitting (e.g. when the window is resized).
    this.userZoomed = false;
    localStorage.removeItem(ZOOM_KEY);
  }

  /** Bring a time into view (selection from the list, a jump). */
  reveal(ms: number): void {
    const el = this.scrollEl().nativeElement;
    const x = ms * this.pxPerMs();
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 80) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
    }
  }

  protected onScroll(): void {
    this.scrollLeft.set(this.scrollEl().nativeElement.scrollLeft);
  }

  protected onWheel(e: WheelEvent): void {
    const el = this.scrollEl().nativeElement;
    if (e.ctrlKey || e.metaKey) {
      // Pinch on a trackpad arrives as ctrl+wheel: zoom around the pointer.
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      this.setZoom(this.pxPerSec() * Math.exp(-e.deltaY * 0.0025), e.clientX - rect.left);
      return;
    }
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
      // A plain wheel scrolls the timeline sideways — there is nothing to scroll vertically.
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  }

  // ---------------------------------------------------------------- scrub

  protected onScrubStart(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.scrubbing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.seekToEvent(e);
  }

  protected onScrubMove(e: PointerEvent): void {
    if (this.scrubbing) this.seekToEvent(e);
  }

  protected onScrubEnd(): void {
    this.scrubbing = false;
  }

  /** Click on an empty part of a track: seek there and clear the selection. */
  protected onTrackBackground(e: PointerEvent): void {
    if (e.target !== e.currentTarget || e.button !== 0) return;
    this.seekToEvent(e);
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) this.store.clearSelection();
  }

  private seekToEvent(e: PointerEvent): void {
    const rect = this.scrollEl().nativeElement.getBoundingClientRect();
    const x = e.clientX - rect.left + this.scrollEl().nativeElement.scrollLeft;
    this.playback.seek(x / this.pxPerMs());
  }

  // ----------------------------------------------------------------- drag

  protected onCueDown(e: PointerEvent, id: string, edge: DragEdge): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    const sel = this.store.selection();
    if (e.shiftKey) this.store.select(id, 'range');
    else if (e.metaKey || e.ctrlKey) this.store.select(id, 'toggle');
    else if (!sel.has(id) || edge !== 'move') this.store.select(id);
    const ids = edge === 'move' && this.store.selection().has(id) ? [...this.store.selection()] : [id];
    this.beginDrag(e, 'cue', ids, edge);
  }

  protected onUnitDown(e: PointerEvent, unit: UnitVm): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    // A clip IS its member lines: select them all, and a drag moves them together.
    this.store.selection.set(new Set(unit.segmentIds));
    this.store.primaryId.set(unit.segmentIds[0]!);
    this.beginDrag(e, 'unit', unit.segmentIds, 'move');
  }

  protected onCueDblClick(id: string): void {
    const seg = this.store.segments()[this.store.indexById().get(id) ?? -1];
    if (!seg) return;
    this.store.select(id);
    this.playback.seek(seg.startMs);
    this.host.nativeElement.dispatchEvent(new CustomEvent('vd-edit-text', { bubbles: true }));
  }

  private beginDrag(e: PointerEvent, kind: Drag['kind'], ids: string[], edge: DragEdge): void {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.drag = {
      kind,
      pointerId: e.pointerId,
      originX: e.clientX,
      ids,
      edge,
      base: this.store.segments().map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs })),
      started: false,
    };
  }

  protected onDragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.originX;
    if (!d.started && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    d.started = true;
    const ppm = this.pxPerMs();
    let delta = dx / ppm;
    const duration = this.store.durationMs();
    const moving = new Set(d.ids);
    const candidates = this.snap() && !e.altKey ? this.snapCandidates(moving) : [];
    const threshold = SNAP_PX / ppm;
    const next = new Map<string, { startMs: number; endMs: number }>();
    let guide: number | null = null;

    if (d.ids.length === 1 || d.edge !== 'move') {
      const index = d.base.findIndex((s) => s.id === d.ids[0]);
      const cur = d.base[index]!;
      let span = constrainDrag(d.base, index, d.edge, delta, duration);
      if (candidates.length) {
        const edges = d.edge === 'start' ? [span.startMs] : d.edge === 'end' ? [span.endMs] : [span.startMs, span.endMs];
        const best = bestSnap(edges, candidates, threshold);
        if (best) {
          delta += best.shift;
          span = constrainDrag(d.base, index, d.edge, delta, duration);
          guide = best.at;
        }
      }
      next.set(cur.id, span);
    } else {
      let clamped = constrainGroupMove(d.base, moving, delta, duration);
      const first = d.base.find((s) => moving.has(s.id))!;
      if (candidates.length) {
        const best = bestSnap([first.startMs + clamped], candidates, threshold);
        if (best) {
          clamped = constrainGroupMove(d.base, moving, clamped + best.shift, duration);
          guide = best.at;
        }
      }
      for (const s of d.base) if (moving.has(s.id)) next.set(s.id, { startMs: s.startMs + clamped, endMs: s.endMs + clamped });
    }
    this.preview.set(next);
    this.snapGuideMs.set(guide);
    const lead = next.get(d.ids[0]!)!;
    const shownMs = d.edge === 'end' ? lead.endMs : lead.startMs;
    const base = d.base.find((s) => s.id === d.ids[0])!;
    const deltaShown = (d.edge === 'end' ? lead.endMs - base.endMs : lead.startMs - base.startMs) / 1000;
    this.dragTip.set({ ms: shownMs, text: `${formatClock(shownMs)}  (${deltaShown >= 0 ? '+' : ''}${deltaShown.toFixed(2)} s)` });
  }

  protected onDragEnd(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    const moved = this.preview();
    if (d.started && moved.size > 0) {
      this.store.setTiming(
        [...moved].map(([id, t]) => ({ id, ...t })),
        d.edge === 'move' ? 'studio.undo-move' : 'studio.undo-trim',
      );
    }
    this.preview.set(new Map());
    this.snapGuideMs.set(null);
    this.dragTip.set(null);
  }

  private snapCandidates(moving: ReadonlySet<string>): number[] {
    const out = [Math.round(this.playback.currentMs())];
    const { from, to } = this.visibleRange();
    for (const s of this.store.segments()) {
      if (s.endMs < from || s.startMs > to || moving.has(s.id)) continue;
      out.push(s.startMs, s.endMs);
    }
    return out;
  }

  // --------------------------------------------------- drop: voices, files

  protected onDragOver(e: DragEvent, targetId: string): void {
    if (!e.dataTransfer?.types.includes(VOICE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    this.dropTarget.set(targetId);
  }

  protected onDragLeave(targetId: string): void {
    if (this.dropTarget() === targetId) this.dropTarget.set(null);
  }

  /** A voice chip dropped on a line (or a clip: every member line) assigns that voice. */
  protected onVoiceDrop(e: DragEvent, ids: readonly string[]): void {
    const voice = e.dataTransfer?.getData(VOICE_DRAG_TYPE);
    this.dropTarget.set(null);
    if (!voice) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = this.store.selection();
    const targets = ids.length === 1 && sel.has(ids[0]!) && sel.size > 1 ? [...sel] : ids;
    this.store.setVoice(targets, voice === '__default__' ? null : voice);
  }

  protected onFileDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    this.fileOver.set(true);
  }

  /** An .srt/.vtt dropped anywhere on the timeline imports its text by time overlap. */
  protected async onFileDrop(e: DragEvent): Promise<void> {
    this.fileOver.set(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    if (!/\.(srt|vtt)$/i.test(file.name)) {
      this.importNote.set(this.translate.instant('studio.import-unsupported'));
      return;
    }
    const cues = parseSubtitles(await file.text());
    const matched = matchCuesToLines(this.store.segments(), cues);
    const n = this.store.importTexts(matched);
    this.importNote.set(this.translate.instant('studio.import-done', { n, file: file.name }));
    setTimeout(() => this.importNote.set(null), 6000);
  }

  // -------------------------------------------------------------- drawing

  private drawAll(): void {
    this.drawRuler();
    this.drawFilmstrip();
    this.drawWaveform();
  }

  private prepare(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
    const w = this.viewportWidth();
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  private cssVar(name: string): string {
    return getComputedStyle(this.host.nativeElement).getPropertyValue(name).trim() || '#888';
  }

  private drawRuler(): void {
    const p = this.prepare(this.rulerCanvas().nativeElement);
    if (!p) return;
    const { ctx, w, h } = p;
    const ppm = this.pxPerMs();
    const left = this.scrollLeft();
    const { stepMs, ticks } = rulerTicks(left / ppm, (left + w) / ppm, this.pxPerSec());
    const ink = this.cssVar('--vd-ruler-ink');
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    for (const t of ticks) {
      const x = Math.round(t.ms * ppm - left) + 0.5;
      ctx.moveTo(x, t.major ? 0 : h - 6);
      ctx.lineTo(x, h);
      if (t.major) ctx.fillText(formatRulerLabel(t.ms, stepMs), x + 4, 3);
    }
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawFilmstrip(): void {
    const p = this.prepare(this.filmCanvas().nativeElement);
    const film = this.store.filmstrip();
    const img = this.filmImage;
    if (!p || !film || !img) return;
    const { ctx, w, h } = p;
    const ppm = this.pxPerMs();
    const left = this.scrollLeft();
    const tileW = (film.tileWidth / film.tileHeight) * h;
    // Walk the viewport in thumbnail-sized steps: zoomed out, steps skip tiles;
    // zoomed in, a tile repeats across its interval — no gaps either way.
    const startX = -((left % tileW) + tileW) % tileW;
    for (let x = startX; x < w; x += tileW) {
      const ms = Math.max(0, (left + x + tileW / 2) / ppm);
      const i = Math.min(film.count - 1, Math.floor(ms / film.intervalMs));
      const sx = (i % film.columns) * film.tileWidth;
      const sy = Math.floor(i / film.columns) * film.tileHeight;
      ctx.drawImage(img, sx, sy, film.tileWidth, film.tileHeight, x, 0, tileW - 1, h);
    }
  }

  private drawWaveform(): void {
    const p = this.prepare(this.waveCanvas().nativeElement);
    const wave = this.store.waveform();
    if (!p || !wave) return;
    const { ctx, w, h } = p;
    const ppm = this.pxPerMs();
    const left = this.scrollLeft();
    const pps = wave.peaksPerSecond;
    const peaks = wave.peaks;
    const total = peaks.length / 2;
    const mid = h / 2;
    ctx.fillStyle = this.cssVar('--vd-wave');
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(((left + x) / ppm / 1000) * pps);
      const i1 = Math.max(i0 + 1, Math.floor(((left + x + 1) / ppm / 1000) * pps));
      if (i0 >= total) break;
      let lo = 0;
      let hi = 0;
      for (let i = Math.max(0, i0); i < Math.min(total, i1); i++) {
        const a = peaks[i * 2]!;
        const b = peaks[i * 2 + 1]!;
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
      // Square-root scale: quiet speech stays visible next to loud music.
      const top = Math.sqrt(hi / 127) * mid;
      const bottom = Math.sqrt(-lo / 127) * mid;
      ctx.fillRect(x, mid - top, 1, Math.max(1, top + bottom));
    }
  }

  // ------------------------------------------------------------- template

  protected x(ms: number): number {
    return ms * this.pxPerMs();
  }

  protected width(startMs: number, endMs: number): number {
    return Math.max(2, (endMs - startMs) * this.pxPerMs());
  }

  protected unitClass(u: UnitVm): string {
    if (u.status === 'timing-conflict') return 'conflict';
    if (u.status === 'needs-review' || u.speedRatio > 1.001) return 'stretch';
    return 'ok';
  }

  /** 1-based line number of a segment id (for clip labels). */
  protected lineNo(id: string): number {
    return (this.store.indexById().get(id) ?? 0) + 1;
  }

  protected isSelected(id: string): boolean {
    return this.store.selection().has(id);
  }

  protected unitSelected(u: UnitVm): boolean {
    const sel = this.store.selection();
    return u.segmentIds.some((id) => sel.has(id));
  }
}

function bestSnap(
  edges: readonly number[],
  candidates: readonly number[],
  threshold: number,
): { shift: number; at: number } | null {
  let best: { shift: number; at: number } | null = null;
  for (const edge of edges) {
    const s = snapTo(edge, candidates, threshold);
    if (s.snapped !== undefined && (!best || Math.abs(s.snapped - edge) < Math.abs(best.shift))) {
      best = { shift: s.snapped - edge, at: s.snapped };
    }
  }
  return best;
}

function formatClock(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const f = t % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}
