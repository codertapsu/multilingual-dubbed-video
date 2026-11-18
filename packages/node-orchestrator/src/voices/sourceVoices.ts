/**
 * Voices from a project's own video ("keep the original speaker's voice").
 *
 * The reference comes from the project's extracted audio: either the whole
 * track (a one-speaker video: narration, a lecture, a vlog; the usual window
 * choice finds its cleanest 8 s), or the lines the user picked in the editor,
 * joined with a short pause, which is how a video with several speakers gets
 * one voice per speaker. Everything after that is the cloning flow: checks,
 * the source-video declaration, enrollment. Such voices stay in the project
 * (deleted with it, never exported).
 *
 * Pure helpers first; the I/O function at the end.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException, isSpeakerId, type TranscriptSegment, type VoiceReferencePolicy } from '@videodubber/shared';
import type { PipelineMediaService } from '../media.js';
import { isProjectId } from './profileStore.js';
import { parseWavPcm16, type PcmMono, type TimeRange } from './referenceAnalysis.js';
import type { ReferenceAnalysis, ReferencePrep } from './referencePrep.js';

/** At most this much of the chosen lines is used (a reference needs seconds). */
export const SOURCE_LINES_MAX_MS = 60_000;
/** Silence put between joined lines. */
const JOIN_GAP_MS = 150;

/**
 * The time ranges of the chosen lines: sorted, touching ones merged, and cut
 * off once the total reaches `maxMs`. Lines that are not in the transcript
 * are ignored. Pure.
 */
export function pickLineRanges(
  segments: readonly Pick<TranscriptSegment, 'id' | 'startMs' | 'endMs'>[],
  ids: readonly string[],
  maxMs = SOURCE_LINES_MAX_MS,
): TimeRange[] {
  const wanted = new Set(ids);
  const ranges = segments
    .filter((s) => wanted.has(s.id) && s.endMs > s.startMs)
    .map((s) => ({ startMs: Math.max(0, Math.round(s.startMs)), endMs: Math.round(s.endMs) }))
    .sort((a, b) => a.startMs - b.startMs);
  const merged: TimeRange[] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r.startMs <= last.endMs + 200) last.endMs = Math.max(last.endMs, r.endMs);
    else merged.push({ ...r });
  }
  const out: TimeRange[] = [];
  let total = 0;
  for (const r of merged) {
    if (total >= maxMs) break;
    const take = Math.min(r.endMs - r.startMs, maxMs - total);
    out.push({ startMs: r.startMs, endMs: r.startMs + take });
    total += take;
  }
  return out;
}

/** Lines that overlap another speaker's by more than this are crosstalk. */
const CROSSTALK_MS = 100;

/**
 * The best material for one speaker's voice: their longest lines first (long
 * lines are continuous speech, short ones are often interjections), never a
 * line spoken over someone else's, up to `maxMs`, returned in time order with
 * the line ids used. Lines overlapping another speaker are used only when the
 * speaker has nothing else. Pure.
 */
export function speakerLineRanges(
  segments: readonly Pick<TranscriptSegment, 'id' | 'startMs' | 'endMs' | 'speakerId'>[],
  speakerId: string,
  maxMs = SOURCE_LINES_MAX_MS,
): { ranges: TimeRange[]; segmentIds: string[] } {
  const own = segments.filter((s) => s.speakerId === speakerId && s.endMs > s.startMs);
  const others = segments.filter((s) => s.speakerId !== speakerId && s.endMs > s.startMs);
  const clean = own.filter(
    (s) => !others.some((o) => Math.min(s.endMs, o.endMs) - Math.max(s.startMs, o.startMs) > CROSSTALK_MS),
  );
  const pool = (clean.length > 0 ? clean : own).slice().sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs));
  const chosen: typeof pool = [];
  let total = 0;
  for (const s of pool) {
    if (total >= maxMs) break;
    chosen.push(s);
    total += s.endMs - s.startMs;
  }
  chosen.sort((a, b) => a.startMs - b.startMs);
  const ranges = pickLineRanges(chosen, chosen.map((s) => s.id), maxMs);
  // The cap trims in time order: list only the lines that are still in.
  const used = chosen.filter((s) => ranges.some((r) => r.startMs < s.endMs && s.startMs < r.endMs));
  return { ranges, segmentIds: used.map((s) => s.id) };
}

/** Join mono clips of one rate with `gapMs` of silence between them. Pure. */
export function joinPcm(parts: readonly PcmMono[], gapMs = JOIN_GAP_MS): PcmMono {
  if (parts.length === 0) return { sampleRate: 48_000, samples: new Int16Array(0) };
  const rate = parts[0]!.sampleRate;
  if (parts.some((p) => p.sampleRate !== rate)) throw new Error('clips of different rates');
  const gap = Math.round((gapMs * rate) / 1000);
  const total = parts.reduce((n, p) => n + p.samples.length, 0) + gap * (parts.length - 1);
  const samples = new Int16Array(total);
  let at = 0;
  parts.forEach((p, i) => {
    samples.set(p.samples, at);
    at += p.samples.length + (i < parts.length - 1 ? gap : 0);
  });
  return { sampleRate: rate, samples };
}

/** A 16-bit mono PCM WAV of `pcm`. Pure. */
export function encodePcmWav(pcm: PcmMono): Buffer {
  const data = Buffer.alloc(pcm.samples.length * 2);
  pcm.samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(pcm.sampleRate, 24);
  head.writeUInt32LE(pcm.sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

export interface SourceVoiceDeps {
  /** The project's extracted audio (`audio/original.wav`) and transcript (`subtitles/source.json`). */
  projectAudio: (projectId: string) => Promise<{ audioPath: string; transcriptPath: string } | undefined>;
  media: Pick<PipelineMediaService, 'referenceClip'>;
  prep: ReferencePrep;
  /** Scratch space for joining lines (removed afterwards). */
  workRoot: string;
}

/** What to take a voice from: chosen lines, one speaker's lines, or (neither) the whole track. */
export interface SourceSelection {
  segmentIds?: readonly string[];
  speakerId?: string;
}

/** A project's transcript lines (source.json), or none. */
export async function readProjectLines(transcriptPath: string): Promise<TranscriptSegment[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(transcriptPath, 'utf8')) as { segments?: TranscriptSegment[] } | TranscriptSegment[];
    return Array.isArray(raw) ? raw : (raw.segments ?? []);
  } catch {
    return [];
  }
}

/** Analyse a project's own speech: the whole track, the chosen lines, or one speaker's. */
export async function analyzeProjectSource(
  deps: SourceVoiceDeps,
  projectId: string,
  policy: VoiceReferencePolicy,
  selection: SourceSelection = {},
  signal?: AbortSignal,
): Promise<ReferenceAnalysis> {
  if (!isProjectId(projectId)) throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'That project does not exist.');
  if (selection.speakerId !== undefined && !isSpeakerId(selection.speakerId)) {
    throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'Unknown speaker.');
  }
  const audio = await deps.projectAudio(projectId);
  if (!audio || !(await fsp.stat(audio.audioPath).then((s) => s.size > 44, () => false))) {
    throw new AppErrorException(
      'VOICE_REFERENCE_REJECTED',
      "This project's audio is not ready yet. Start the dub and let it reach speech-to-text first.",
    );
  }
  const segmentIds = selection.segmentIds ?? [];
  if (!selection.speakerId && segmentIds.length === 0) {
    return deps.prep.analyze(audio.audioPath, policy, { sourceName: 'video', origin: { projectId }, ...(signal ? { signal } : {}) });
  }
  const segments = await readProjectLines(audio.transcriptPath);
  let ranges: TimeRange[];
  let usedIds: string[];
  if (selection.speakerId) {
    ({ ranges, segmentIds: usedIds } = speakerLineRanges(segments, selection.speakerId));
    if (ranges.length === 0) throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'This speaker has no lines in the transcript.');
  } else {
    ranges = pickLineRanges(segments, segmentIds);
    usedIds = [...segmentIds];
    if (ranges.length === 0) throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'None of the chosen lines is in the transcript.');
  }
  const referenceClip = deps.media.referenceClip;
  if (!referenceClip) throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'This build cannot prepare voice recordings.');
  const scratch = path.join(deps.workRoot, `lines_${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(scratch, { recursive: true });
  try {
    const parts: PcmMono[] = [];
    for (const [i, r] of ranges.entries()) {
      const file = path.join(scratch, `${i}.wav`);
      await referenceClip(audio.audioPath, file, { startMs: r.startMs, endMs: r.endMs, sampleRate: 48_000 }, signal);
      parts.push(parseWavPcm16(await fsp.readFile(file)));
    }
    const joined = path.join(scratch, 'lines.wav');
    await fsp.writeFile(joined, encodePcmWav(joinPcm(parts)));
    return await deps.prep.analyze(joined, policy, {
      sourceName: selection.speakerId ?? `${usedIds.length} line(s)`,
      origin: { projectId, segmentIds: usedIds, ...(selection.speakerId ? { speakerId: selection.speakerId } : {}) },
      ...(signal ? { signal } : {}),
    });
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
