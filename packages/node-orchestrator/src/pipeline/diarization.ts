/**
 * Speakers for the transcript's lines, from speaker detection's turns.
 *
 * The STT step runs this after the lines are merged and before they are
 * anchored to the speech (line timing is fixed in exactly one place, at the end
 * of the STT step), so a line that anchoring splits keeps its speaker.
 *
 * A line goes to the speaker who says most of it, when the turns cover enough
 * of it and one speaker clearly dominates. A line that fails that rule (music,
 * a crowd, two people at once, a turn the diarizer cut short) used to stay
 * nobody's and was dubbed in the project voice: one line in twelve of the
 * field report's 10-hour drama (2026-11-21, B2). It now takes the speaker it
 * overlaps most, else the nearest turn within 3 s, else its nearest labelled
 * neighbour's, and is marked `speakerLowConfidence` for the editor to list.
 * (Relabelling such lines by their own voice print was tried in that run and
 * failed: a 1-3 s line over music ranked its own speaker first only 37-51 % of
 * the time among 30.)
 *
 * Speakers are numbered in order of their first line, as SPEAKER_00,
 * SPEAKER_01..., the form the translation prompts read; numbers are
 * contiguous even when the engine heard someone who says no line.
 *
 * The turns and what each detected speaker sounds like (voice print, pitch,
 * gender) are cached in audio/diarization.json with the audio's size and
 * modification time and the model they came from, so a retried STT step does
 * not detect again, and a re-extracted track or another model never reuses
 * them. Labelling the lines records there which SPEAKER_xx each detected
 * speaker became, for casting (readSpeakerProfiles).
 */
import fsp from 'node:fs/promises';
import type { StepDetail, TranscriptSegment } from '@videodubber/shared';
import type {
  DetectedVoice,
  Diarization,
  DiarizationService,
  DiarizeOptions,
  SpeakerTurn,
} from '../providers/diarization/sherpaDiarizationProvider.js';
import { cosineSimilarity } from '../providers/diarization/voicePrint.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';

/** At least this share of a line must be inside some speaker's turns... */
export const MIN_COVERED = 0.4;
/** ...and one speaker must hold this share of what is covered. */
export const MIN_MAJORITY = 0.6;
/** A line no turn touches takes the nearest turn this close (the field report's rescue used 3 s). */
export const NEAREST_TURN_MS = 3_000;

interface Line {
  startMs: number;
  endMs: number;
  speakerId?: string;
  speakerLowConfidence?: true;
}

/** Lines labelled with speakers. */
export interface SpeakerLabels<T> {
  /** The lines, in order, each with its speaker (a best guess is marked speakerLowConfidence). */
  segments: T[];
  /** The id each detected speaker's lines carry: its number in the turns -> "SPEAKER_03". */
  idBySpeaker: Map<number, string>;
  /** Lines that got only a best guess. */
  lowConfidence: number;
}

const BIN_MS = 10_000;

/** Turns by 10-second bins: a 10-hour transcript (19k lines, 36k turns) is labelled in well under a second. */
function turnsNear(turns: readonly SpeakerTurn[]): (fromMs: number, toMs: number) => SpeakerTurn[] {
  const bins = new Map<number, SpeakerTurn[]>();
  for (const t of turns) {
    for (let b = Math.floor(t.startMs / BIN_MS); b <= Math.floor(t.endMs / BIN_MS); b++) {
      const bin = bins.get(b);
      if (bin) bin.push(t);
      else bins.set(b, [t]);
    }
  }
  return (fromMs, toMs) => {
    const found = new Set<SpeakerTurn>();
    for (let b = Math.floor(fromMs / BIN_MS); b <= Math.floor(toMs / BIN_MS); b++) {
      for (const t of bins.get(b) ?? []) found.add(t);
    }
    return [...found];
  };
}

/** Time between two lines (0 when they touch or overlap). */
function gapMs(a: Line, b: Line): number {
  return Math.max(0, a.startMs - b.endMs, b.startMs - a.endMs);
}

/** Give each line a speaker, the strict rule first, then the best guesses. Pure; lines keep their order. */
export function labelSpeakers<T extends Line>(segments: readonly T[], turns: readonly SpeakerTurn[]): SpeakerLabels<T> {
  const near = turnsNear(turns);
  const picked: (number | undefined)[] = [];
  const sure: boolean[] = [];
  for (const seg of segments) {
    const bySpeaker = new Map<number, number>();
    for (const t of near(seg.startMs, seg.endMs)) {
      const overlap = Math.min(seg.endMs, t.endMs) - Math.max(seg.startMs, t.startMs);
      if (overlap > 0) bySpeaker.set(t.speaker, (bySpeaker.get(t.speaker) ?? 0) + overlap);
    }
    const covered = [...bySpeaker.values()].reduce((a, b) => a + b, 0);
    if (covered > 0) {
      const [top, held] = [...bySpeaker].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
      const duration = seg.endMs - seg.startMs;
      picked.push(top);
      sure.push(duration > 0 && Math.min(covered, duration) / duration >= MIN_COVERED && held / covered >= MIN_MAJORITY);
      continue;
    }
    let best: SpeakerTurn | undefined;
    let bestGap = Infinity;
    for (const t of near(seg.startMs - NEAREST_TURN_MS, seg.endMs + NEAREST_TURN_MS)) {
      const gap = Math.max(0, t.startMs - seg.endMs, seg.startMs - t.endMs);
      if (gap > NEAREST_TURN_MS) continue;
      if (gap < bestGap || (gap === bestGap && best && (t.startMs < best.startMs || (t.startMs === best.startMs && t.speaker < best.speaker)))) {
        best = t;
        bestGap = gap;
      }
    }
    picked.push(best?.speaker);
    sure.push(false);
  }

  // The rest take their nearest neighbour's speaker, among the lines the
  // turns labelled, so a guess never travels down a run of silent lines.
  const previous: number[] = [];
  let last = -1;
  for (let i = 0; i < segments.length; i++) {
    previous.push(last);
    if (picked[i] !== undefined) last = i;
  }
  const speakerOf = [...picked];
  let next = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (picked[i] === undefined) {
      const p = previous[i]!;
      const candidates = [p, next].filter((j) => j >= 0);
      if (candidates.length > 0) {
        const from = candidates.reduce((a, b) => (gapMs(segments[b]!, segments[i]!) < gapMs(segments[a]!, segments[i]!) ? b : a));
        speakerOf[i] = picked[from];
      }
    } else {
      next = i;
    }
  }

  const ids = new Map<number, string>();
  let lowConfidence = 0;
  const out = segments.map((seg, i) => {
    const { speakerId: _previous, speakerLowConfidence: _guess, ...line } = seg;
    const speaker = speakerOf[i];
    if (speaker === undefined) return line as T;
    if (!ids.has(speaker)) ids.set(speaker, `SPEAKER_${String(ids.size).padStart(2, '0')}`);
    if (!sure[i]) lowConfidence++;
    return { ...line, speakerId: ids.get(speaker)!, ...(sure[i] ? {} : { speakerLowConfidence: true as const }) } as T;
  });
  return { segments: out, idBySpeaker: ids, lowConfidence };
}

/** Give each line the speaker who says it (see labelSpeakers). Pure; lines keep their order. */
export function assignSpeakers<T extends Line>(segments: readonly T[], turns: readonly SpeakerTurn[]): T[] {
  return labelSpeakers(segments, turns).segments;
}

/**
 * Copy the speakers (and their best-guess marks) of `labelled` onto the lines
 * of `target` with the same id: source.json is labelled, translated.json
 * follows. Lines of `target` that `labelled` lacks are left alone. Pure.
 */
export function copySpeakerLabels<T extends Line & { id: string }>(target: readonly T[], labelled: readonly (Line & { id: string })[]): T[] {
  const byId = new Map(labelled.map((l) => [l.id, l]));
  return target.map((t) => {
    const l = byId.get(t.id);
    if (!l) return t;
    const { speakerId: _old, speakerLowConfidence: _guess, ...rest } = t;
    return {
      ...rest,
      ...(l.speakerId ? { speakerId: l.speakerId } : {}),
      ...(l.speakerId && l.speakerLowConfidence ? { speakerLowConfidence: true as const } : {}),
    } as T;
  });
}

// ---- audio/diarization.json ---------------------------------------------------

/** One detected speaker in audio/diarization.json. */
export interface CachedSpeaker extends DetectedVoice {
  /** The id this speaker's lines carry ("SPEAKER_03"), written when lines were labelled; absent for one who says no line. */
  speakerId?: string;
}

/** A detected speaker as the project's lines know them (get_speakers, casting). */
export interface DetectedSpeaker extends CachedSpeaker {
  speakerId: string;
}

/** audio/diarization.json. */
export interface DiarizationCache {
  /** 2 since each speaker's voice is kept: a turns-only file of 0.16 is detected again. */
  format: 2;
  /** The audio the turns were detected in, and how. */
  audio: { sizeBytes: number; mtimeMs: number };
  model: string;
  numSpeakers?: number;
  turns: SpeakerTurn[];
  speakers: CachedSpeaker[];
}

/** The whole cache file; undefined when absent, unreadable or of an older format. */
export async function readDiarizationCache(cachePath: string): Promise<DiarizationCache | undefined> {
  try {
    const saved = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as Partial<DiarizationCache> | null;
    if (
      !saved ||
      saved.format !== 2 ||
      typeof saved.audio?.sizeBytes !== 'number' ||
      typeof saved.audio.mtimeMs !== 'number' ||
      typeof saved.model !== 'string' ||
      !Array.isArray(saved.turns) ||
      !Array.isArray(saved.speakers)
    ) {
      return undefined;
    }
    return saved as DiarizationCache;
  } catch {
    return undefined;
  }
}

/**
 * The detected speakers of a project as its lines carry them (SPEAKER_00
 * first): talk time, pitch, gender with its confidence, voice print. Empty
 * before detection, after a failed one, and for a 0.16 cache.
 */
export async function readSpeakerProfiles(cachePath: string): Promise<DetectedSpeaker[]> {
  const saved = await readDiarizationCache(cachePath);
  return (saved?.speakers ?? [])
    .filter((s): s is DetectedSpeaker => typeof s.speakerId === 'string')
    .sort((a, b) => a.speakerId.localeCompare(b.speakerId));
}

/** Who speaks when in `audioPath`, from the cache when it was detected in this very file the same way. */
export async function cachedDiarization(
  service: DiarizationService,
  audioPath: string,
  cachePath: string,
  opts: DiarizeOptions,
  signal?: AbortSignal,
): Promise<Diarization | null> {
  const stat = await fsp.stat(audioPath);
  const audio = { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  const saved = await readDiarizationCache(cachePath);
  if (
    saved &&
    saved.audio.sizeBytes === audio.sizeBytes &&
    saved.audio.mtimeMs === audio.mtimeMs &&
    saved.model === service.modelKey &&
    (saved.numSpeakers ?? 0) === (opts.numSpeakers ?? 0)
  ) {
    return { turns: saved.turns, speakers: saved.speakers.map(({ speakerId: _id, ...voice }) => voice) };
  }
  const found = await service.diarize(audioPath, opts, signal);
  if (found === null) return null;
  const result: Diarization = Array.isArray(found) ? { turns: found, speakers: [] } : found;
  await writeJsonAtomic(cachePath, {
    format: 2,
    audio,
    model: service.modelKey,
    ...(opts.numSpeakers ? { numSpeakers: opts.numSpeakers } : {}),
    turns: result.turns,
    speakers: result.speakers,
  } satisfies DiarizationCache);
  return result;
}

/** Speaker turns of `audioPath` (cachedDiarization without the voices). */
export async function cachedSpeakerTurns(
  service: DiarizationService,
  audioPath: string,
  cachePath: string,
  opts: DiarizeOptions,
  signal?: AbortSignal,
): Promise<SpeakerTurn[] | null> {
  return (await cachedDiarization(service, audioPath, cachePath, opts, signal))?.turns ?? null;
}

/** Record which line id each detected speaker became (see readSpeakerProfiles). */
async function recordSpeakerIds(cachePath: string, idBySpeaker: ReadonlyMap<number, string>): Promise<void> {
  const saved = await readDiarizationCache(cachePath);
  if (!saved) return;
  let changed = false;
  const speakers = saved.speakers.map((s) => {
    const { speakerId: old, ...voice } = s;
    const speakerId = idBySpeaker.get(s.speaker);
    if (speakerId !== old) changed = true;
    return speakerId ? { ...voice, speakerId } : voice;
  });
  if (changed) await writeJsonAtomic(cachePath, { ...saved, speakers } satisfies DiarizationCache);
}

// ---- detection over a transcript -------------------------------------------

export interface SpeakerDetectionInput {
  service: DiarizationService;
  /** The project's audio/original_16k_mono.wav. */
  audioPath: string;
  /** audio/diarization.json. */
  cachePath: string;
  /** audio/diarization-chunks: long audio's finished parts, so a pause or a retry resumes. */
  checkpointDir?: string;
  /** The lines to label, in order. */
  segments: readonly TranscriptSegment[];
  /** A known number of people (2 and up). */
  numSpeakers?: number;
  /** Parts of the audio done, of the total. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface SpeakerDetectionResult {
  /** The same lines with their speakers, best guesses marked; text, timing and voices untouched. */
  segments: TranscriptSegment[];
  /** The detected speakers who say a line, SPEAKER_00 first. */
  speakers: DetectedSpeaker[];
  /** Lines given only a best guess. */
  lowConfidence: number;
}

/**
 * Detect who speaks when (or reuse the cache) and label the lines with it.
 * Null when no engine is installed. A stop is the signal: whatever it throws
 * then, callers check `signal.aborted`.
 */
export async function detectLineSpeakers(input: SpeakerDetectionInput): Promise<SpeakerDetectionResult | null> {
  const opts: DiarizeOptions = {
    ...(input.numSpeakers ? { numSpeakers: input.numSpeakers } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.checkpointDir ? { checkpointDir: input.checkpointDir } : {}),
  };
  const found = await cachedDiarization(input.service, input.audioPath, input.cachePath, opts, input.signal);
  if (!found) return null;
  const labels = labelSpeakers(input.segments, found.turns);
  await recordSpeakerIds(input.cachePath, labels.idBySpeaker);
  const speakers = found.speakers
    .flatMap((voice) => {
      const speakerId = labels.idBySpeaker.get(voice.speaker);
      return speakerId ? [{ ...voice, speakerId }] : [];
    })
    .sort((a, b) => a.speakerId.localeCompare(b.speakerId));
  return { segments: labels.segments, speakers, lowConfidence: labels.lowConfidence };
}

export interface RedetectSpeakersResult extends SpeakerDetectionResult {
  /**
   * Old speaker id -> new id, one to one, so the project's speaker voices
   * follow their people: matched by voice print, else by the lines the two
   * share. An old id missing here has no counterpart; drop its voice.
   */
  remap: Record<string, string>;
}

/**
 * Detect the speakers again over the transcript as it is: only detection and
 * labelling (never speech-to-text, never re-timing), each line's own voice
 * kept. The speakers are renumbered by first line, so the remap says where
 * each old id went. Null when no engine is installed.
 */
export async function redetectSpeakers(input: SpeakerDetectionInput): Promise<RedetectSpeakersResult | null> {
  const before = await readSpeakerProfiles(input.cachePath);
  const detected = await detectLineSpeakers(input);
  if (!detected) return null;
  return { ...detected, remap: remapSpeakers(before, detected.speakers, input.segments, detected.segments) };
}

/** Below this the two prints are not taken for one voice (a drama's separated voices: median 0.58). */
export const REMAP_MIN_SIMILARITY = 0.7;

/**
 * Where each old speaker id went: the most alike prints first, one to one.
 * An old id no print matched (labelled by hand, detected by 0.16, or heard
 * differently this time) goes to the free new id that now holds most of its
 * lines, when that is at least half of them. Pure.
 */
export function remapSpeakers(
  before: readonly { speakerId: string; print: readonly number[] }[],
  after: readonly { speakerId: string; print: readonly number[] }[],
  oldLines: readonly { id: string; startMs: number; endMs: number; speakerId?: string }[],
  newLines: readonly { id: string; speakerId?: string }[],
): Record<string, string> {
  const remap: Record<string, string> = {};
  const taken = new Set<string>();
  const pairs: { from: string; to: string; sim: number }[] = [];
  for (const o of before) {
    for (const n of after) {
      const sim = cosineSimilarity(o.print, n.print);
      if (sim >= REMAP_MIN_SIMILARITY) pairs.push({ from: o.speakerId, to: n.speakerId, sim });
    }
  }
  pairs.sort((a, b) => b.sim - a.sim || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  for (const p of pairs) {
    if (p.from in remap || taken.has(p.to)) continue;
    remap[p.from] = p.to;
    taken.add(p.to);
  }

  const newById = new Map(newLines.map((l) => [l.id, l.speakerId]));
  const total = new Map<string, number>();
  const shared = new Map<string, Map<string, number>>();
  for (const line of oldLines) {
    if (!line.speakerId || line.speakerId in remap) continue;
    const ms = Math.max(1, line.endMs - line.startMs);
    total.set(line.speakerId, (total.get(line.speakerId) ?? 0) + ms);
    const now = newById.get(line.id);
    if (!now) continue;
    const by = shared.get(line.speakerId) ?? new Map<string, number>();
    by.set(now, (by.get(now) ?? 0) + ms);
    shared.set(line.speakerId, by);
  }
  const olds = [...total.keys()].sort((a, b) => total.get(b)! - total.get(a)! || a.localeCompare(b));
  for (const old of olds) {
    const best = [...(shared.get(old) ?? [])]
      .filter(([to]) => !taken.has(to))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best && best[1] * 2 >= total.get(old)!) {
      remap[old] = best[0];
      taken.add(best[0]);
    }
  }
  return remap;
}

/** A project's speaker voices after a remap: each voice follows its speaker; a speaker with no counterpart loses it. Pure. */
export function remapSpeakerVoices(
  voices: readonly { speakerId: string; voiceId: string }[] | undefined,
  remap: Readonly<Record<string, string>>,
): { speakerId: string; voiceId: string }[] {
  return (voices ?? [])
    .flatMap((v) => (remap[v.speakerId] ? [{ speakerId: remap[v.speakerId]!, voiceId: v.voiceId }] : []))
    .sort((a, b) => a.speakerId.localeCompare(b.speakerId));
}

/**
 * Speaker detection's progress as the STT step's: the bar over the parts,
 * with "Detecting speakers 3/12" under it, and a log line per part of long
 * audio. The field report's UI showed "Transcribe" for the 2 h 56 min that
 * detection ran.
 */
export function speakerDetectionProgress(
  step: (fraction: number, detail: StepDetail) => Promise<void>,
  log: (message: string) => void,
): (done: number, total: number) => void {
  return (done, total) => {
    if (!(total > 0)) return;
    void step(Math.min(1, done / total), {
      key: 'step-detail.speakers',
      params: { done, total },
      text: `Detecting speakers ${done}/${total}`,
    }).catch(() => undefined);
    if (total > 1) {
      log(done === 0 ? `Detecting speakers in ${total} parts of up to 10 minutes...` : `Speaker detection: part ${done}/${total} done.`);
    }
  };
}
