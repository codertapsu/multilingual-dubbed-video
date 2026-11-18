/**
 * Speakers for the transcript's lines, from speaker detection's turns.
 *
 * The STT step runs this after the lines are merged and before they are
 * anchored to the speech (line timing is fixed in exactly one place, at the end
 * of the STT step), so a line that anchoring splits keeps its speaker. A line
 * goes to the speaker who says most of it, when the turns cover enough of it
 * and one speaker clearly dominates; otherwise it stays nobody's (music, a
 * crowd, two people at once). A wrong speaker is worse than none: "nobody" is
 * visible in the editor and fixed in a click, a wrong voice is heard.
 *
 * Speakers are numbered in order of their first line, as SPEAKER_00,
 * SPEAKER_01..., the form the translation prompts read; numbers are
 * contiguous even when the engine heard someone who says no line.
 *
 * The turns are cached in audio/diarization.json with the audio's size and
 * modification time and the model they came from, so a retried STT step does
 * not detect again, and a re-extracted track or another model never reuses
 * them.
 */
import fsp from 'node:fs/promises';
import type { DiarizationService, SpeakerTurn } from '../providers/diarization/sherpaDiarizationProvider.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';

/** At least this share of a line must be inside some speaker's turns... */
export const MIN_COVERED = 0.4;
/** ...and one speaker must hold this share of what is covered. */
export const MIN_MAJORITY = 0.6;

/** Give each line the speaker who says it (or nobody). Pure; lines keep their order. */
export function assignSpeakers<T extends { startMs: number; endMs: number; speakerId?: string }>(
  segments: readonly T[],
  turns: readonly SpeakerTurn[],
): T[] {
  const ids = new Map<number, string>();
  return segments.map((seg) => {
    const { speakerId: _previous, ...line } = seg;
    const duration = seg.endMs - seg.startMs;
    if (duration <= 0) return line as T;
    const bySpeaker = new Map<number, number>();
    for (const t of turns) {
      const overlap = Math.min(seg.endMs, t.endMs) - Math.max(seg.startMs, t.startMs);
      if (overlap > 0) bySpeaker.set(t.speaker, (bySpeaker.get(t.speaker) ?? 0) + overlap);
    }
    const covered = [...bySpeaker.values()].reduce((a, b) => a + b, 0);
    if (covered === 0 || Math.min(covered, duration) / duration < MIN_COVERED) return line as T;
    const [top, held] = [...bySpeaker].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
    if (held / covered < MIN_MAJORITY) return line as T;
    if (!ids.has(top)) ids.set(top, `SPEAKER_${String(ids.size).padStart(2, '0')}`);
    return { ...line, speakerId: ids.get(top)! } as T;
  });
}

interface DiarizationFile {
  /** The audio the turns were detected in, and how. */
  audio: { sizeBytes: number; mtimeMs: number };
  model: string;
  numSpeakers?: number;
  turns: SpeakerTurn[];
}

/** Speaker turns of `audioPath`, from the cache when they were detected in this very file the same way. */
export async function cachedSpeakerTurns(
  service: DiarizationService,
  audioPath: string,
  cachePath: string,
  opts: { numSpeakers?: number },
  signal?: AbortSignal,
): Promise<SpeakerTurn[] | null> {
  const stat = await fsp.stat(audioPath);
  const audio = { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  try {
    const saved = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as Partial<DiarizationFile>;
    if (
      saved.audio?.sizeBytes === audio.sizeBytes &&
      saved.audio.mtimeMs === audio.mtimeMs &&
      saved.model === service.modelKey &&
      (saved.numSpeakers ?? 0) === (opts.numSpeakers ?? 0) &&
      Array.isArray(saved.turns)
    ) {
      return saved.turns;
    }
  } catch {
    /* absent or unreadable: detect */
  }
  const turns = await service.diarize(audioPath, opts, signal);
  if (turns === null) return null;
  await writeJsonAtomic(cachePath, {
    audio,
    model: service.modelKey,
    ...(opts.numSpeakers ? { numSpeakers: opts.numSpeakers } : {}),
    turns,
  } satisfies DiarizationFile);
  return turns;
}
