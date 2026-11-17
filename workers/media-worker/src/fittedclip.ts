/**
 * A dub clip time-fitted exactly as the final mix will play it — for the
 * editor's live preview.
 *
 * The editor previews the dub by scheduling each clip in WebAudio at its
 * placement. WebAudio can only change speed by resampling, which shifts pitch:
 * a line the aligner sped up 1.3× would preview as a chipmunk while the render
 * sounds natural. So a sped-up clip is rendered here with the SAME `atempo`
 * chain the timeline mix applies (buildAtempoChain), and the editor plays that
 * at 1×. (The final mix may use Rubber Band instead when it is installed; the
 * preview is then a close, not exact, match — the timing is identical either way.)
 * A trimmed clip (only its speech plays in the mix) is cut the same way first,
 * or the preview would start a lead-in late and play a botched clip's noise.
 */
import { writeAtomically } from './atomic.js';
import { assertInputReadable, assertOutputWritable, runFfmpeg, type RunOptions } from './exec.js';
import { buildAtempoChain, buildTrimChain } from './tts-timeline.js';

/** The part of the clip the mix plays, in ms of the clip. */
export interface FittedClipTrim {
  startMs: number;
  endMs: number;
}

/** ffmpeg argv to trim `input` and tempo-fit it by `ratio` (>1 = faster) into a PCM WAV. Pure. */
export function buildFittedClipArgs(input: string, output: string, ratio: number, trim?: FittedClipTrim): string[] {
  const chain = `${buildTrimChain(trim?.startMs, trim?.endMs)}${buildAtempoChain(ratio)}`.replace(/,$/, '');
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-i',
    input,
    '-vn',
    ...(chain ? ['-filter:a', chain] : []),
    '-c:a',
    'pcm_s16le',
    '-y',
    output,
  ];
}

/** Render the fitted clip to `output` (a .wav path), atomically. */
export async function renderFittedClip(
  input: string,
  output: string,
  ratio: number,
  opts: RunOptions & { trim?: FittedClipTrim } = {},
): Promise<string> {
  assertInputReadable(input);
  assertOutputWritable(output);
  const { trim, ...run } = opts;
  await writeAtomically(output, async (partial) => {
    await runFfmpeg(buildFittedClipArgs(input, partial, ratio, trim), { timeoutMs: 60_000, ...run });
  });
  return output;
}
