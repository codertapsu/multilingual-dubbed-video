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
 */
import { writeAtomically } from './atomic.js';
import { assertInputReadable, assertOutputWritable, runFfmpeg, type RunOptions } from './exec.js';
import { buildAtempoChain } from './tts-timeline.js';

/** ffmpeg argv to tempo-fit `input` by `ratio` (>1 = faster) into a PCM WAV. Pure. */
export function buildFittedClipArgs(input: string, output: string, ratio: number): string[] {
  const chain = buildAtempoChain(ratio).replace(/,$/, '');
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
  opts: RunOptions = {},
): Promise<string> {
  assertInputReadable(input);
  assertOutputWritable(output);
  await writeAtomically(output, async (partial) => {
    await runFfmpeg(buildFittedClipArgs(input, partial, ratio), { timeoutMs: 60_000, ...opts });
  });
  return output;
}
