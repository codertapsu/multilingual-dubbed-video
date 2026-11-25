/**
 * "Find the watermark and blur it" (`settings.watermarkAuto`): what a picture
 * detection gives the render. Pure.
 *
 * WHY (claude-dubber, 2026-11-25): the user wanted every dub's watermark
 * hidden, and the agent ran detect_watermark, read the boxes and saved them
 * into each project by hand, part after part of a 48-part series. Now a
 * setting asks for it. A series finds the mark ONCE, in the whole video,
 * during its analysis (series/seriesService.ts), and every part is made with
 * those boxes, shown at review; a single video, or a part whose series found
 * none, looks for it when it renders (pipeline/runner.ts). What is found is
 * saved as the project's `blurRegions`, so the editor shows it and the next
 * render uses it as it is.
 */
import type { BlurRegion, PictureDetection, WatermarkAutoSettings, WatermarkProposal } from '@videodubber/shared';

/** A mark this clear is hidden by itself (the detection's own threshold for "clear"). */
export const WATERMARK_MIN_CONFIDENCE = 0.5;

/** The setting as a client may send it: an object, or `true` for a plain blur; anything else is none. */
export function sanitizeWatermarkAuto(input: unknown): WatermarkAutoSettings | undefined {
  if (input === true) return { mode: 'blur' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const r = input as Record<string, unknown>;
  const mode = r.mode === 'pixelate' || r.mode === 'delogo' ? r.mode : r.mode === undefined || r.mode === 'blur' ? 'blur' : undefined;
  if (!mode) return undefined;
  const strength = typeof r.strength === 'number' && Number.isFinite(r.strength) ? Math.round(Math.min(10, Math.max(1, r.strength))) : undefined;
  return { mode, ...(strength !== undefined ? { strength } : {}) };
}

/** The clear marks of a detection as boxes to hide, the way the setting asks. */
export function autoBlurRegions(detection: Pick<PictureDetection, 'regions'>, auto: WatermarkAutoSettings): BlurRegion[] {
  return detection.regions
    .filter((r) => r.confidence >= WATERMARK_MIN_CONFIDENCE)
    .map((r) => ({
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      ...(r.startMs !== undefined ? { startMs: r.startMs } : {}),
      ...(r.endMs !== undefined ? { endMs: r.endMs } : {}),
      mode: auto.mode,
      ...(auto.strength !== undefined ? { strength: auto.strength } : {}),
    }));
}

/** The marks hidden, in words: "a watermark at the top-right (clear: 83 %)". */
export function describeMarks(detection: Pick<PictureDetection, 'regions'>): string {
  const clear = detection.regions.filter((r) => r.confidence >= WATERMARK_MIN_CONFIDENCE);
  const one = (r: WatermarkProposal): string =>
    `the ${r.corner.replace('-', ' ')}${r.fileName ? ` of ${r.fileName}` : ''} (clear: ${Math.round(r.confidence * 100)} %)`;
  if (clear.length === 0) return 'no watermark';
  return `${clear.length === 1 ? 'a watermark' : `${clear.length} watermarks`} at ${clear.map(one).join(', ')}`;
}

/** The marks found but too faint to hide by themselves, said so the agent or the user can look. */
export function faintMarks(detection: Pick<PictureDetection, 'regions'>): number {
  return detection.regions.filter((r) => r.confidence < WATERMARK_MIN_CONFIDENCE).length;
}
