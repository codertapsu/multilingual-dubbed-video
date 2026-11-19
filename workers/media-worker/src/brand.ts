/**
 * Brand kit files (Settings → Logo & lời chào): a logo made into a PNG, a
 * greeting made into the WAV the mix lays in.
 *
 * A greeting is trimmed of silence at both ends (it is placed into quiet
 * moments: lead-in silence would push it off its moment) and levelled to the
 * loudness the dub's voices have before the final mix, so it neither shouts
 * over nor hides under them. Both written atomically.
 */
import { writeAtomically } from './atomic.js';
import { assertInputReadable, assertOutputWritable, runFfmpeg, type RunOptions } from './exec.js';
import { probeDurationMs, probeVideoGeometry } from './probe.js';

/** The longest a greeting may be: it has to fit between lines. */
export const MAX_GREETING_MS = 15_000;

/** ffmpeg args: any picture (PNG, JPG, WebP, a video's first frame) → a PNG at most 1024 px wide. Pure. */
export function buildPrepareLogoArgs(input: string, output: string): string[] {
  return [
    '-y',
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(1024,iw)':-2:flags=lanczos,format=rgba",
    '-c:v',
    'png',
    '-f',
    'image2',
    output,
  ];
}

/**
 * ffmpeg args: any audio or video → the greeting WAV: silence trimmed from
 * both ends (below -45 dBFS), levelled to -16 LUFS (the final mix's target),
 * 48 kHz stereo. Pure.
 */
export function buildPrepareGreetingArgs(input: string, output: string): string[] {
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05';
  return [
    '-y',
    '-i',
    input,
    '-vn',
    '-sn',
    '-dn',
    '-af',
    `${trim},areverse,${trim},areverse,loudnorm=I=-16:TP=-1.5:LRA=11`,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    output,
  ];
}

/** Make a logo PNG; its pixel size. */
export async function prepareLogo(input: string, output: string, opts: RunOptions = {}): Promise<{ width: number; height: number }> {
  assertInputReadable(input);
  assertOutputWritable(output);
  await writeAtomically(output, (partial) => runFfmpeg(buildPrepareLogoArgs(input, partial), opts));
  const g = await probeVideoGeometry(output, opts);
  return { width: g.width, height: g.height };
}

/** Make a greeting WAV; its length. Refuses silence and anything over {@link MAX_GREETING_MS}. */
export async function prepareGreeting(input: string, output: string, opts: RunOptions = {}): Promise<{ durationMs: number }> {
  assertInputReadable(input);
  assertOutputWritable(output);
  await writeAtomically(output, (partial) => runFfmpeg(buildPrepareGreetingArgs(input, partial), opts));
  const durationMs = await probeDurationMs(output, opts);
  return { durationMs };
}
