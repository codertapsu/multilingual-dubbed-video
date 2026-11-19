/**
 * A series part dubs a window of the source video (`project.sourceRange`).
 * Everything inside the part is timed from the window's start; its media info
 * says the window's length, so the timeline, the mix and the render all agree.
 */
import type { MediaInfo, TimeSpan } from '@videodubber/shared';

/** The probe of the whole video, as the window sees it. Pure. */
export function rangedMediaInfo(info: MediaInfo, range: TimeSpan | undefined): MediaInfo {
  if (!range) return info;
  const durationMs = Math.max(0, Math.min(info.durationMs || range.endMs, range.endMs) - range.startMs);
  return { ...info, durationMs };
}
