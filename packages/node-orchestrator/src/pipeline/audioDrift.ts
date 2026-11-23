/**
 * What the extract-audio step says about the source's audio against its
 * picture (docs/plans/production-requests-2026-11-23.md, 1.1).
 *
 * Both audio tracks are extracted on the picture's clock and cut to its
 * length whatever the drift (media-worker extract.ts), so this only reports:
 * always in the log and the project's media info, and as a warning from
 * {@link AUDIO_DRIFT_WARN_MS}. Measured on the 27.8-hour series: P4 +4.81 s
 * (the one that drifted audibly), P1/P2 +0.56 s over 10 h (at the edge),
 * P3/P5 +0.02 / +0.14 s (quiet: the re-timing makes them harmless).
 */
import type { AudioDrift, ProjectWarning } from '@videodubber/shared';

/** From this much longer than the picture, the project gets a warning. */
export const AUDIO_DRIFT_WARN_MS = 500;

const sec = (ms: number, digits = 2): string => (ms / 1000).toFixed(digits);

/** The log line, every time it was measured. Pure. */
export function describeAudioDrift(d: AudioDrift): string {
  const signed = `${d.driftMs >= 0 ? '+' : '-'}${sec(Math.abs(d.driftMs))} s`;
  const c = d.count;
  const how =
    d.method === 'packets' && c?.packets !== undefined && c.frameSize !== undefined
      ? `${c.packets} packets x ${c.frameSize} samples${c.primingSamples ? ` - ${c.primingSamples} priming` : ''}`
      : c?.samples !== undefined
        ? `${c.samples} samples decoded`
        : d.method;
  const where = d.range ? ` in this part's window (${sec(d.range.startMs, 1)}-${sec(d.range.endMs, 1)} s of the video)` : '';
  const claimed = d.claimedAudioMs !== undefined ? `; the container claimed ${sec(d.claimedAudioMs)} s` : '';
  return (
    `Audio vs picture${where}: the audio holds ${sec(d.audioMs)} s, the picture lasts ${sec(d.pictureMs)} s: ${signed} ` +
    `(${how}${c?.codec ? `, ${c.codec} ${c.sampleRate} Hz` : ''}${claimed}). Both audio tracks follow the picture's clock and end with it.`
  );
}

/**
 * The project warning, when the audio was at least {@link AUDIO_DRIFT_WARN_MS}
 * longer than the picture. Audio that ends before the picture is not one: the
 * extraction pads its end with silence, and a soundtrack that simply stops
 * early is common. Pure.
 */
export function audioDriftWarning(d: AudioDrift): Omit<ProjectWarning, 'at' | 'step'> | undefined {
  if (d.driftMs < AUDIO_DRIFT_WARN_MS) return undefined;
  const seconds = Math.round(d.driftMs / 100) / 10;
  return {
    code: 'audio-drift',
    key: 'warning.audio-drift',
    params: { seconds },
    message:
      `The audio was ${seconds} s longer than the picture (counted from its decoded samples): it was re-timed to the picture, ` +
      'so the dub stays in sync and the video keeps its length.',
  };
}
