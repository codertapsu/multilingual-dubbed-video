/**
 * Pure timeline math for the studio editor: time <-> pixels, ruler ticks,
 * snapping, and the drag constraints.
 *
 * The drag constraints MIRROR the orchestrator's timelineEdit.ts invariants —
 * a line never moves past a neighbour, never creates an overlap that wasn't
 * there, never shrinks below MIN_SEGMENT_MS and never leaves the media — so a
 * drag the timeline lets you make is one the server accepts. (If they ever
 * disagreed the server would refuse the save with INVALID_EDIT and the editor
 * would snap back, which is correct but jarring; keep them in step.)
 *
 * Framework-free, so it is unit-tested in plain Node (timeline-math.spec.ts).
 */

/** Same floor as the orchestrator (workspace/timelineEdit.ts). */
export const MIN_SEGMENT_MS = 80;

/**
 * Zoom limits, in pixels per second of media. The floor must let "Fit" show a
 * whole feature: 0.05 px/s puts 8 hours in 1440 px (1 px/s, the first value,
 * could not fit even a 2-hour video on a laptop screen).
 */
export const MIN_PX_PER_SEC = 0.05;
export const MAX_PX_PER_SEC = 800;

export function clampZoom(pxPerSec: number): number {
  if (!Number.isFinite(pxPerSec)) return 100;
  return Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, pxPerSec));
}

/** The zoom that fits `durationMs` into `widthPx` (with a little air). */
export function fitZoom(durationMs: number, widthPx: number): number {
  if (durationMs <= 0 || widthPx <= 0) return 100;
  return clampZoom(((widthPx * 0.98) / durationMs) * 1000);
}

/** One ruler tick. */
export interface RulerTick {
  ms: number;
  major: boolean;
}

/** "Nice" major steps, ms. */
const NICE_STEPS = [
  10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
  900_000, 1_800_000, 3_600_000,
];

/** The major step so labelled ticks stay >= `minLabelPx` apart. */
export function majorStepMs(pxPerSec: number, minLabelPx = 90): number {
  const pxPerMs = pxPerSec / 1000;
  for (const step of NICE_STEPS) {
    if (step * pxPerMs >= minLabelPx) return step;
  }
  return NICE_STEPS[NICE_STEPS.length - 1]!;
}

/** Ticks covering [startMs, endMs] (minor ticks subdivide each major by 5 or 4). */
export function rulerTicks(startMs: number, endMs: number, pxPerSec: number): { stepMs: number; ticks: RulerTick[] } {
  const stepMs = majorStepMs(pxPerSec);
  const minorDiv = String(stepMs).startsWith('2') || String(stepMs).startsWith('15') ? 4 : 5;
  const minor = stepMs / minorDiv;
  const ticks: RulerTick[] = [];
  const first = Math.floor(Math.max(0, startMs) / minor) * minor;
  // Bounded: a pathological range must not allocate millions of ticks.
  for (let ms = first, n = 0; ms <= endMs && n < 5000; ms += minor, n++) {
    const rounded = Math.round(ms);
    ticks.push({ ms: rounded, major: Math.abs(rounded % stepMs) < 1e-6 || Math.abs((rounded % stepMs) - stepMs) < 1e-6 });
  }
  return { stepMs, ticks };
}

/** Ruler label for a major tick: "1:05", "1:02:30", or "0:05.250" below 1 s steps. */
export function formatRulerLabel(ms: number, stepMs: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const frac = total % 1000;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const base = `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
  if (stepMs >= 1000) return base;
  const digits = stepMs >= 100 ? 1 : stepMs >= 10 ? 2 : 3;
  return `${base}.${String(frac).padStart(3, '0').slice(0, digits)}`;
}

/**
 * Parse an editor timecode: "1:02.345", "01:02:03.004", "62.5", "62,5" or
 * "1500ms". Returns ms, or null when it is not a time.
 */
export function parseTimecode(text: string): number | null {
  const raw = text.trim().replace(',', '.');
  if (!raw) return null;
  const ms = /^(\d+(?:\.\d+)?)\s*ms$/i.exec(raw);
  if (ms) return Math.round(Number(ms[1]));
  const parts = raw.split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || !/^\d+(?:\.\d+)?$/.test(p))) return null;
  // Only the last field may carry a fraction.
  if (parts.slice(0, -1).some((p) => p.includes('.'))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

/** A line or clip on the timeline. */
export interface Span {
  id: string;
  startMs: number;
  endMs: number;
}

/** How far a line may go on each side without breaking an invariant. */
function bounds(spans: readonly Span[], i: number, durationMs: number): { lower: number; upper: number } {
  const cur = spans[i]!;
  const prev = spans[i - 1];
  const next = spans[i + 1];
  // A pre-existing overlap (from the recogniser) is tolerated but not extended:
  // the line may only move AWAY from the neighbour it already overlaps.
  const lower = prev ? Math.min(prev.endMs, cur.startMs) : 0;
  const upper = next ? Math.max(next.startMs, cur.endMs) : Math.max(durationMs, cur.endMs);
  return { lower, upper };
}

export type DragEdge = 'move' | 'start' | 'end';

/** Constrain a drag of ONE line by `deltaMs` (move, or trim an edge). Pure. */
export function constrainDrag(
  spans: readonly Span[],
  index: number,
  edge: DragEdge,
  deltaMs: number,
  durationMs: number,
): { startMs: number; endMs: number } {
  const cur = spans[index]!;
  const { lower, upper } = bounds(spans, index, durationMs);
  if (edge === 'move') {
    const len = cur.endMs - cur.startMs;
    const startMs = clamp(cur.startMs + deltaMs, lower, Math.max(lower, upper - len));
    return { startMs, endMs: startMs + len };
  }
  if (edge === 'start') {
    return { startMs: clamp(cur.startMs + deltaMs, lower, cur.endMs - MIN_SEGMENT_MS), endMs: cur.endMs };
  }
  return { startMs: cur.startMs, endMs: clamp(cur.endMs + deltaMs, cur.startMs + MIN_SEGMENT_MS, upper) };
}

/**
 * Constrain a move of SEVERAL lines together (a multi-select drag, or a merged
 * dub clip whose member cues all shift). Lines inside the selection keep their
 * spacing; only unselected neighbours and the media bounds limit the delta.
 * Returns the clamped delta. Pure.
 */
export function constrainGroupMove(
  spans: readonly Span[],
  selected: ReadonlySet<string>,
  deltaMs: number,
  durationMs: number,
): number {
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  spans.forEach((s, i) => {
    if (!selected.has(s.id)) return;
    const prev = spans[i - 1];
    const next = spans[i + 1];
    if (!prev) lo = Math.max(lo, -s.startMs);
    else if (!selected.has(prev.id)) lo = Math.max(lo, Math.min(prev.endMs, s.startMs) - s.startMs);
    if (!next) hi = Math.min(hi, Math.max(durationMs, s.endMs) - s.endMs);
    else if (!selected.has(next.id)) hi = Math.min(hi, Math.max(next.startMs, s.endMs) - s.endMs);
  });
  if (lo > hi) return 0;
  return clamp(deltaMs, lo, hi);
}

/** Snap `ms` to the nearest candidate within `thresholdMs`. */
export function snapTo(ms: number, candidates: readonly number[], thresholdMs: number): { ms: number; snapped?: number } {
  let best: number | undefined;
  let bestDist = thresholdMs;
  for (const c of candidates) {
    const d = Math.abs(c - ms);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best === undefined ? { ms } : { ms: best, snapped: best };
}

/** Index of the last span whose start is <= ms (binary search; spans sorted). */
export function spanIndexAt(spans: readonly Span[], ms: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.startMs <= ms) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Spans intersecting [fromMs, toMs] — the windowing that keeps long videos fast. */
export function visibleSpans<T extends Span>(spans: readonly T[], fromMs: number, toMs: number): T[] {
  if (spans.length === 0) return [];
  // Start a little before: a long line that began earlier can still be on screen.
  let i = Math.max(0, spanIndexAt(spans, fromMs));
  while (i > 0 && spans[i - 1]!.endMs > fromMs) i--;
  const out: T[] = [];
  for (; i < spans.length; i++) {
    const s = spans[i]!;
    if (s.startMs > toMs) break;
    if (s.endMs >= fromMs) out.push(s);
  }
  return out;
}

/** Characters per second — the subtitle reading-speed measure. */
export function charsPerSecond(text: string, durationMs: number): number {
  const chars = text.replace(/\s+/g, ' ').trim().length;
  return durationMs > 0 ? chars / (durationMs / 1000) : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  // `|| 0` folds -0 into 0: a "no movement" delta must compare equal to 0.
  return Math.round(Math.max(lo, Math.min(hi, v))) || 0;
}
