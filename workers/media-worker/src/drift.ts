/**
 * How long a source's audio really is against its picture, counted from its
 * DECODED samples (docs/plans/production-requests-2026-11-23.md, 1.1).
 *
 * Never from the container's durations: Part 4 of the 27.8-hour series
 * claimed 9826.354 s of audio against a 9826.357 s picture while holding
 * 4.8 s more samples than that (its packets' timestamps advance less than the
 * samples they carry). Every sample decoded = 4.8 s of drift behind the
 * picture by the end; the extraction now follows the timestamps (extract.ts),
 * and this says by how much the source was off.
 *
 * Counting, cheapest first:
 *  - packets × frame size − the priming, for codecs whose every packet holds
 *    the same number of samples (AAC 1024, MP3 1152, AC-3 1536…). The frame
 *    size and the priming come from decoding the first seconds. The packet
 *    count is the container's own (instant for MP4) when it agrees with the
 *    picture; otherwise it is counted by demuxing, because an MP4 edit list
 *    can hide samples the container still counts (a `-ss … -c copy` file
 *    claimed 10.5 s of a real 8.0 s).
 *  - a full decode with the samples counted (volumedetect), for codecs whose
 *    packets vary (Opus, Vorbis, FLAC, PCM).
 */
import type { AudioDrift } from '@videodubber/shared';
import { assertInputReadable, runFfmpeg, runFfprobe, type RunOptions } from './exec.js';
import { extractKeepMs, type MediaWindow } from './extract.js';
import { pictureDurationMs, probe, streamDurationMs } from './probe.js';

/** Codecs whose every packet decodes to the same number of samples. */
const FIXED_FRAME_CODECS: ReadonlySet<string> = new Set(['aac', 'mp3', 'mp2', 'mp1', 'ac3', 'eac3']);

/** A container's packet count is confirmed by demuxing when it puts the audio this far from the picture. */
const CONFIRM_FROM_MS = 250;

/** The first seconds decoded for the frame size and the priming. */
const HEAD_SECONDS = 5;

/** A full count reads (and maybe decodes) the whole file: an 18 GB source takes minutes. */
const COUNT_TIMEOUT_MS = 60 * 60_000;

/** ffprobe argv: the first audio stream's codec, rate and packet count (`countPackets`: by demuxing). Pure. */
export function buildAudioPacketsArgs(input: string, opts: { range?: MediaWindow; countPackets: boolean }): string[] {
  const range = opts.range;
  return [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    ...(range ? ['-read_intervals', `${(Math.max(0, range.startMs) / 1000).toFixed(3)}%${(range.endMs / 1000).toFixed(3)}`] : []),
    ...(opts.countPackets ? ['-count_packets'] : []),
    '-show_entries',
    'stream=codec_name,sample_rate,nb_frames,nb_read_packets,initial_padding,duration:stream_tags=DURATION',
    '-print_format',
    'json',
    '-i',
    input,
  ];
}

/** ffprobe argv: the first seconds' audio packets (their times) and decoded frames (their sizes). Pure. */
export function buildAudioHeadArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-read_intervals',
    `%+${HEAD_SECONDS}`,
    '-show_entries',
    'packet=pts_time:frame=nb_samples',
    '-print_format',
    'json',
    '-i',
    input,
  ];
}

/**
 * ffmpeg argv: decode the first audio stream (`range`: only that window) and
 * count its samples. Mono first, so volumedetect's `n_samples` is per channel.
 * Reads only; writes nothing. Pure.
 */
export function buildDecodedSamplesArgs(input: string, range?: MediaWindow): string[] {
  const window = range
    ? ['-ss', (Math.max(0, range.startMs) / 1000).toFixed(3), '-t', (Math.max(0, range.endMs - Math.max(0, range.startMs)) / 1000).toFixed(3)]
    : [];
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    // volumedetect reports at INFO.
    '-v',
    'info',
    ...window,
    '-i',
    input,
    '-map',
    '0:a:0',
    '-af',
    'aformat=channel_layouts=mono,volumedetect',
    '-f',
    'null',
    '-',
  ];
}

/** What {@link buildAudioPacketsArgs} reports. */
export interface AudioPackets {
  codec: string;
  sampleRate: number;
  /** The container's own count (MP4: its sample table), when it has one. */
  containerPackets?: number;
  /** Packets the demuxer read (with `countPackets`). */
  readPackets?: number;
  initialPadding?: number;
  claimedMs?: number;
}

/** Parse {@link buildAudioPacketsArgs} output. Pure; undefined when there is no audio stream. */
export function parseAudioPackets(json: unknown): AudioPackets | undefined {
  const s = (json as { streams?: Array<Record<string, unknown>> } | null)?.streams?.[0];
  if (!s) return undefined;
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const sampleRate = num(s.sample_rate) ?? 0;
  const containerPackets = num(s.nb_frames);
  const readPackets = num(s.nb_read_packets);
  const initialPadding = num(s.initial_padding);
  const claimedMs = streamDurationMs({
    ...(typeof s.duration === 'string' ? { duration: s.duration } : {}),
    ...(s.tags && typeof s.tags === 'object' ? { tags: s.tags as Record<string, string> } : {}),
  });
  return {
    codec: typeof s.codec_name === 'string' ? s.codec_name : 'unknown',
    sampleRate,
    ...(containerPackets !== undefined && containerPackets > 0 ? { containerPackets } : {}),
    ...(readPackets !== undefined && readPackets > 0 ? { readPackets } : {}),
    ...(initialPadding !== undefined && initialPadding > 0 ? { initialPadding } : {}),
    ...(claimedMs !== undefined ? { claimedMs } : {}),
  };
}

/** The first seconds of the audio: when its first packet plays, and the samples of each decoded frame. */
export interface AudioHead {
  /** Seconds; negative = priming (or an edit list's preroll) that the decoder drops. */
  firstPtsSec?: number;
  frameSamples: number[];
}

/** Parse {@link buildAudioHeadArgs} output. Pure. */
export function parseAudioHead(json: unknown): AudioHead {
  const items = (json as { packets_and_frames?: Array<Record<string, unknown>> } | null)?.packets_and_frames ?? [];
  let firstPtsSec: number | undefined;
  const frameSamples: number[] = [];
  for (const it of items) {
    if (it.type === 'packet' && firstPtsSec === undefined) {
      const t = Number(it.pts_time);
      if (Number.isFinite(t)) firstPtsSec = t;
    } else if (it.type === 'frame') {
      const n = Number(it.nb_samples);
      if (Number.isFinite(n) && n > 0) frameSamples.push(n);
    }
  }
  return { ...(firstPtsSec !== undefined ? { firstPtsSec } : {}), frameSamples };
}

/**
 * The samples every packet holds, when they all hold the same: the size of
 * the frames after the first (the first is cut by the priming). Undefined
 * when fewer than 3 frames were seen or they differ. Pure.
 */
export function steadyFrameSize(frameSamples: readonly number[]): number | undefined {
  const rest = frameSamples.slice(1);
  if (rest.length < 3) return undefined;
  const size = rest[0]!;
  return rest.every((n) => n === size) ? size : undefined;
}

/**
 * Samples the decoder drops before the first one that plays: the encoder's
 * priming, or an edit list's preroll. A first packet at −0.021333 s of 48 kHz
 * AAC is 1024; Matroska rounds times to the millisecond, so its own
 * `initial_padding` (MP3: 1105) is the exact one when given. Pure.
 */
export function primingSamples(head: AudioHead, sampleRate: number, initialPadding?: number): number {
  if (initialPadding !== undefined && initialPadding > 0) return initialPadding;
  const first = head.firstPtsSec;
  return first !== undefined && first < 0 ? Math.round(-first * sampleRate) : 0;
}

/** The largest `n_samples` volumedetect printed (ffmpeg may set a filter up twice). Pure. */
export function parseDecodedSamples(stderr: string): number | undefined {
  let best: number | undefined;
  for (const m of stderr.matchAll(/n_samples:\s*(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && (best === undefined || n > best)) best = n;
  }
  return best;
}

/** Decoded length, ms, of `packets` packets of `frameSize` samples less the priming. Pure. */
export function packetsToMs(packets: number, frameSize: number, priming: number, sampleRate: number): number {
  if (!(sampleRate > 0)) return 0;
  return Math.round((Math.max(0, packets * frameSize - priming) / sampleRate) * 1000);
}

/** Options for {@link measureAudioDrift}. */
export interface MeasureAudioDriftOptions extends RunOptions {
  /** Only this window of the input (a series part). */
  range?: MediaWindow;
}

/**
 * The input's audio against its picture (for a window: inside it). Undefined
 * for audio-only input (no picture to follow) or when there is no audio.
 * Reads only. Errors are thrown: the caller decides that a failed measurement
 * never stops an extraction.
 */
export async function measureAudioDrift(
  input: string,
  opts: MeasureAudioDriftOptions = {},
): Promise<Omit<AudioDrift, 'measuredAt'> | undefined> {
  assertInputReadable(input);
  const { range, ...rest } = opts;
  const run: RunOptions = { timeoutMs: COUNT_TIMEOUT_MS, ...rest };
  // Audio-only input has no picture to be off from (a window of it neither).
  const picture = pictureDurationMs(await probe(input, run));
  const pictureMs = picture === undefined ? undefined : extractKeepMs(range, picture);
  if (pictureMs === undefined) return undefined;

  const packetsOf = async (countPackets: boolean): Promise<AudioPackets | undefined> => {
    const { stdout } = await runFfprobe(buildAudioPacketsArgs(input, { ...(range ? { range } : {}), countPackets }), run);
    return parseAudioPackets(JSON.parse(stdout));
  };
  // A window has no container count: its packets are counted by demuxing it.
  const stream = await packetsOf(range !== undefined);
  if (!stream || !(stream.sampleRate > 0)) return undefined;
  const head = parseAudioHead(JSON.parse((await runFfprobe(buildAudioHeadArgs(input), run)).stdout));
  const frameSize = FIXED_FRAME_CODECS.has(stream.codec) ? steadyFrameSize(head.frameSamples) : undefined;
  const base = {
    pictureMs,
    ...(range ? { range: { startMs: range.startMs, endMs: range.endMs } } : {}),
    ...(!range && stream.claimedMs !== undefined ? { claimedAudioMs: stream.claimedMs } : {}),
  };

  if (frameSize !== undefined) {
    // A window starts mid-stream: nothing of it is priming.
    const priming = range ? 0 : primingSamples(head, stream.sampleRate, stream.initialPadding);
    const at = (packets: number): number => packetsToMs(packets, frameSize, priming, stream.sampleRate);
    let packets = range ? stream.readPackets : (stream.containerPackets ?? stream.readPackets);
    if (packets === undefined || (!range && stream.containerPackets !== undefined && Math.abs(at(packets) - pictureMs) >= CONFIRM_FROM_MS)) {
      packets = (await packetsOf(true))?.readPackets ?? packets;
    }
    if (packets !== undefined) {
      const audioMs = at(packets);
      return {
        ...base,
        driftMs: audioMs - pictureMs,
        audioMs,
        method: 'packets',
        count: { codec: stream.codec, sampleRate: stream.sampleRate, packets, frameSize, primingSamples: priming },
      };
    }
  }

  const decoded = await runFfmpeg(buildDecodedSamplesArgs(input, range), run);
  const samples = parseDecodedSamples(decoded.stderr);
  if (samples === undefined) return undefined;
  const audioMs = Math.round((samples / stream.sampleRate) * 1000);
  return {
    ...base,
    driftMs: audioMs - pictureMs,
    audioMs,
    method: 'decode',
    count: { codec: stream.codec, sampleRate: stream.sampleRate, samples },
  };
}
