/**
 * The editor preview's clock conversions (PlaybackService), pure so a spec
 * holds them. A series part plays inside its parent's video: its timeline
 * starts at 0 where the part's window starts (project.sourceRange).
 *
 * Out of the service since 0.16.0 shipped `videoMs()` calling itself (a
 * replace of `v.currentTime * 1000` that caught its own definition): Play,
 * every seek, frame and tick overflowed the stack, so through 0.17.1 the
 * preview showed the picture but never played the dub voices, and the
 * playhead stood still.
 */

/** The timeline's time (ms) of a video time (s). */
export function timelineMs(videoSeconds: number, windowStartMs = 0): number {
  return videoSeconds * 1000 - windowStartMs;
}

/** The video's time (s) of a timeline time (ms). */
export function videoSecondsAt(timelineMs: number, windowStartMs = 0): number {
  return (timelineMs + windowStartMs) / 1000;
}
