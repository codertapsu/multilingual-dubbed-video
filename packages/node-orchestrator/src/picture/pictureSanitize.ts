/**
 * The picture options as a client may send them (the editor, the wizard, an
 * agent over MCP), checked field by field like every other setting: what is
 * malformed is dropped, never guessed, so a bad value cannot reach the render.
 */
import type { BlurRegion, SubtitleStyle } from '@videodubber/shared';

/** A project hides at most this many regions (a render chain each). */
export const MAX_BLUR_REGIONS = 20;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * Well-formed regions, at most {@link MAX_BLUR_REGIONS}; undefined when none
 * is left (an empty list or null clears them). A box reaching past the frame
 * is clipped to it; times are whole milliseconds, start before end.
 */
export function sanitizeBlurRegions(input: unknown): BlurRegion[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: BlurRegion[] = [];
  for (const raw of input) {
    if (out.length >= MAX_BLUR_REGIONS) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const mode = r.mode === 'blur' || r.mode === 'pixelate' || r.mode === 'delogo' ? r.mode : undefined;
    if (!mode || !finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h)) continue;
    const x = Math.min(1, Math.max(0, r.x));
    const y = Math.min(1, Math.max(0, r.y));
    const w = Math.min(1 - x, r.w);
    const h = Math.min(1 - y, r.h);
    if (w < 0.001 || h < 0.001) continue;
    const startMs = finite(r.startMs) && r.startMs >= 0 ? Math.round(r.startMs) : undefined;
    const endMs = finite(r.endMs) && r.endMs > 0 ? Math.round(r.endMs) : undefined;
    if (startMs !== undefined && endMs !== undefined && endMs <= startMs) continue;
    const strength = finite(r.strength) ? Math.round(Math.min(10, Math.max(1, r.strength))) : undefined;
    out.push({
      x: round4(x),
      y: round4(y),
      w: round4(w),
      h: round4(h),
      ...(startMs !== undefined && startMs > 0 ? { startMs } : {}),
      ...(endMs !== undefined ? { endMs } : {}),
      mode,
      ...(strength !== undefined ? { strength } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The {@link SubtitleStyle} fields that hide the source's own subtitles, the
 * well-formed ones: `coverOriginal` (true/false, 'solid', 'blur'), the band
 * (`coverBand`, clipped to the frame), `coverStrength` 1–10 and
 * `subtitlesInBand`. orchestrator.ts sanitizeSubtitleStyle keeps them.
 */
export function sanitizeCoverFields(s: Record<string, unknown>): Partial<SubtitleStyle> {
  const out: Partial<SubtitleStyle> = {};
  const c = s.coverOriginal;
  if (typeof c === 'boolean' || c === 'solid' || c === 'blur') out.coverOriginal = c;
  const band = s.coverBand as Record<string, unknown> | null | undefined;
  if (band && typeof band === 'object' && finite(band.y) && finite(band.h) && band.y >= 0 && band.y < 1) {
    const h = Math.min(1 - band.y, band.h);
    if (h >= 0.005) out.coverBand = { y: round4(band.y), h: round4(h) };
  }
  if (finite(s.coverStrength) && s.coverStrength >= 1 && s.coverStrength <= 10) out.coverStrength = Math.round(s.coverStrength);
  if (typeof s.subtitlesInBand === 'boolean') out.subtitlesInBand = s.subtitlesInBand;
  return out;
}

/** The band fields a patch can clear by sending null (going back to the bottom strip, the default strength). */
const CLEARABLE = ['coverBand', 'coverStrength', 'subtitlesInBand'] as const;

/**
 * `style` without the band fields `patch` set to null: a sanitized patch
 * cannot say "remove", and a merge keeps what it does not mention. Pure.
 */
export function withoutClearedCoverFields(style: SubtitleStyle | undefined, patch: unknown): SubtitleStyle | undefined {
  if (!style || !patch || typeof patch !== 'object') return style;
  const p = patch as Record<string, unknown>;
  const cleared = CLEARABLE.filter((k) => p[k] === null);
  if (cleared.length === 0) return style;
  const out: SubtitleStyle = { ...style };
  for (const k of cleared) delete out[k];
  return Object.keys(out).length > 0 ? out : undefined;
}
