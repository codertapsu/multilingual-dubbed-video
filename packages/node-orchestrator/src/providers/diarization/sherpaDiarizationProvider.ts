/**
 * Speaker detection, backed by the `diarization-sherpa` engine pack
 * (workers/diarization-engine, sherpa-onnx). Answers who speaks when, as turns
 * with a speaker number, and what each speaker sounds like (a voice print, a
 * pitch, a gender); pipeline/diarization.ts turns those into the lines'
 * speaker ids. Returns null when the pack isn't installed: the dub then goes
 * on without speakers, and says so.
 *
 * Audio under 20 minutes is detected in one request (POST /diarize). Longer
 * audio is detected in 10-minute parts and linked afterwards. One request over
 * the field report's 10-hour drama (2026-11-21, B2) ran 2 h 56 min under a
 * 6-hour timeout, showed no progress, and ended in HTTP 500; the series was
 * then dubbed in one voice. Each part is now its own request with a timeout
 * sized to the part, is saved as it finishes (a pause, a crash or a retry
 * resumes at the first missing part), and is reported ("Detecting speakers
 * 12/60"); POST /link then groups the parts' speakers by voice print.
 *
 * Parts run side by side when the machine has room: the engine keeps up to
 * four model pairs (its GET /health `pool`), and the orchestrator's
 * `setParallelism` budget says 1 while a heavy step runs anywhere. The
 * 27.8-hour series ran its 168 parts one after another, 4 h 56 min with ~3.6
 * of 16 threads busy (claude-dubber report, 2026-11-23, F6). A ranged
 * detection (`diarizeWindows`) runs only the parts it is given, unlinked:
 * pipeline/diarization.ts links them to the speakers already known.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException } from '@videodubber/shared';
import type { EngineManager } from '../../engines/engineManager.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';
import { DIARIZATION_EMBEDDING } from '../../engines/enginePackCatalog.js';
import { pickInstalledPack } from '../../engines/packSelection.js';
import { checkpointKey, readCheckpoint } from '../../pipeline/translationCheckpoint.js';
import { writeJsonAtomic } from '../../workspace/projectStore.js';

import { getWorkerJson, postWorkerJson } from '../workerHttp.js';

/** A stretch of audio said by one speaker (numbers from 0). */
export interface SpeakerTurn {
  startMs: number;
  endMs: number;
  speaker: number;
}

export type SpeakerGender = 'male' | 'female' | 'unknown';

/** One speaker of the turns, as their voice was measured. */
export interface DetectedVoice {
  /** Their number in the turns. */
  speaker: number;
  /** Seconds of talk. */
  sec: number;
  /** Median pitch of their voiced frames; null when too little was voiced. */
  f0Hz: number | null;
  /** From the voice print, not the pitch: shouting men measure 300-400 Hz. */
  gender: SpeakerGender;
  /** 0.9 for a pitch seed, 0.5-0.85 by voice print, 0.3 by pitch alone, 0 when unknown. */
  genderConfidence: number;
  /** L2-normalised voice print (the diarizer's own embedding model); empty when none could be made. */
  print: number[];
}

/** Who speaks when, and what each of them sounds like. */
export interface Diarization {
  turns: SpeakerTurn[];
  speakers: DetectedVoice[];
}

export interface DiarizeOptions {
  /**
   * A known number of people. One pass clusters into exactly that many; long
   * audio keeps at most that many (a 10-minute part rarely has everyone in it).
   */
  numSpeakers?: number;
  /** Parts done of the total: once before the first, then after each. */
  onProgress?: (done: number, total: number) => void;
  /** Where each finished part of long audio is saved (audio/diarization-chunks). */
  checkpointDir?: string;
}

/** The voice of one short recording (POST /embed). */
export interface VoiceEmbedding {
  /** L2-normalised, in the same space as the detected speakers' prints; empty when there was no speech. */
  print: number[];
  /** Median pitch of the voiced frames; null when too little was voiced. */
  f0Hz: number | null;
  /** Share of the voiced frames under 165 Hz; null with the pitch. */
  lowShare: number | null;
  /** Seconds of speech found in the recording. */
  speechSec: number;
}

export interface DiarizationService {
  /**
   * Who speaks when in a 16 kHz mono WAV, with each speaker's voice when the
   * engine measures it (an engine that only finds turns returns them alone);
   * null when no engine is installed.
   */
  diarize(audioPath: string, opts: DiarizeOptions, signal?: AbortSignal): Promise<Diarization | SpeakerTurn[] | null>;
  /**
   * The voice print of a short clean recording (a cloned voice's preview.wav,
   * any PCM WAV) or of a window of one; null when no engine is installed.
   * Absent on engines, and test doubles, that make no prints.
   */
  embed?(audioPath: string, opts?: { startMs?: number; endMs?: number }, signal?: AbortSignal): Promise<VoiceEmbedding | null>;
  /**
   * Detect only these windows of a 16 kHz mono WAV (a ranged detection): each
   * window's turns on the file's clock with its speakers numbered within it,
   * and their voice prints, NOT linked to the rest of the file
   * (pipeline/diarization.ts links them to the speakers already known). Saved
   * and resumed like the parts of a long detection; null when no engine is
   * installed. Absent on engines, and test doubles, that cannot.
   */
  diarizeWindows?(
    audioPath: string,
    windows: readonly DiarizationChunk[],
    opts: Pick<DiarizeOptions, 'onProgress' | 'checkpointDir'>,
    signal?: AbortSignal,
  ): Promise<DiarizationPart[] | null>;
  /** Whether `diarize` can do anything here. */
  available(): Promise<boolean>;
  /** What the turns depend on besides the audio (the model and its threshold), for caching. */
  readonly modelKey: string;
}

/** Bytes per second of the 16 kHz mono 16-bit WAV speaker detection reads. */
const BYTES_PER_SECOND_16K_MONO = 16_000 * 2;
/** ffmpeg's plain WAV header: a few ms of error at most when it carries more. */
const WAV_HEADER_BYTES = 44;
/** From this length on, detection goes in parts. */
export const ONE_PASS_MAX_MS = 20 * 60_000;
/** One part: what Phase 0 measured the engine on, and what the field report's rescue used. */
export const DIARIZATION_CHUNK_MS = 10 * 60_000;
/** A last part shorter than this rides with the one before (10 min + 40 s is one part). */
const MIN_LAST_CHUNK_MS = 2 * 60_000;
/** A project's speaker voices hold 100 (sanitizeSpeakerVoices): the rest merge by gender and voice. */
export const MAX_DETECTED_SPEAKERS = 100;
/** Prints from less clean speech than this are too noisy to link by; they join a group afterwards. */
const MIN_PRINT_SEC = 3;
/** Print pieces per speaker of a part: 20 made each part of the field report's rescue cost ~4 min. */
const MAX_PRINT_PIECES = 8;
/** Bump when a saved part's meaning changes. */
const CHUNK_FORMAT = 1;
const WORKER_NAME = 'Speaker detection engine';

/**
 * How long one speaker-detection request may take: the usual worker timeout,
 * or 0.6x the audio's length plus five minutes when that is longer. Its time
 * grows with the length, so on a multi-hour video the fixed 30-minute timeout
 * failed a request that was working. For long audio this is a PART's length:
 * the whole file's came to ~6 hours on the 10-hour drama. Pure.
 */
export function diarizationTimeoutMs(baseMs: number, audioBytes: number): number {
  const audioMs = (Math.max(0, audioBytes) / BYTES_PER_SECOND_16K_MONO) * 1000;
  return Math.max(baseMs, Math.ceil(audioMs * 0.6 + 5 * 60_000));
}

/** The length of a 16 kHz mono 16-bit WAV from its size. Pure. */
export function wavDurationMs(sizeBytes: number): number {
  return Math.ceil((Math.max(0, sizeBytes - WAV_HEADER_BYTES) / BYTES_PER_SECOND_16K_MONO) * 1000);
}

/** A part of long audio, by position. */
export interface DiarizationChunk {
  index: number;
  startMs: number;
  endMs: number;
}

/** The parts long audio is detected in. Pure. */
export function planDiarizationChunks(durationMs: number, chunkMs = DIARIZATION_CHUNK_MS): DiarizationChunk[] {
  const plan: DiarizationChunk[] = [];
  for (let startMs = 0; startMs < durationMs; startMs += chunkMs) {
    plan.push({ index: plan.length, startMs, endMs: Math.min(durationMs, startMs + chunkMs) });
  }
  const last = plan[plan.length - 1];
  if (plan.length > 1 && last && last.endMs - last.startMs < MIN_LAST_CHUNK_MS) {
    plan.pop();
    plan[plan.length - 1]!.endMs = durationMs;
  }
  return plan;
}

/**
 * What a saved part depends on: the very audio file (size and modification
 * time; a re-extracted track never reuses an old part, a moved projects folder
 * keeps them), the model, the window and how it was asked. Pure.
 */
export function chunkCheckpointKey(
  audio: { sizeBytes: number; mtimeMs: number },
  modelKey: string,
  chunk: Pick<DiarizationChunk, 'startMs' | 'endMs'>,
  request: Record<string, unknown>,
): string {
  return checkpointKey(['diarize-chunk', CHUNK_FORMAT, audio.sizeBytes, audio.mtimeMs, modelKey, chunk.startMs, chunk.endMs, request]);
}

/** A local speaker of one part (POST /diarize-chunk's `speakers`). */
export interface ChunkSpeaker {
  local: number;
  /** Seconds of talk in the part. */
  sec: number;
  /** Seconds of clean speech the print was made from. */
  printSec: number;
  /** L2-normalised; empty when none could be made. */
  print: number[];
  f0Hz: number | null;
  lowShare: number | null;
}

/** One part's answer, as saved: turns on the file's clock, speakers numbered within the part. */
interface ChunkResult {
  turns: SpeakerTurn[];
  speakers: ChunkSpeaker[];
}

/** A window detected on its own (`diarizeWindows`): its turns' speakers are its local ones. */
export interface DiarizationPart extends ChunkResult {
  window: DiarizationChunk;
}

const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null);
const isPrint = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum);

function cleanTurns(raw: unknown): SpeakerTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t: Partial<SpeakerTurn> | null) =>
    t && isNum(t.startMs) && isNum(t.endMs) && t.endMs > t.startMs && isCount(t.speaker)
      ? [{ startMs: t.startMs, endMs: t.endMs, speaker: t.speaker }]
      : [],
  );
}

function cleanVoices(raw: unknown): DetectedVoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v: Record<string, unknown> | null) => {
    if (!v || !isCount(v.speaker) || !isNum(v.sec)) return [];
    const gender: SpeakerGender = v.gender === 'male' || v.gender === 'female' ? v.gender : 'unknown';
    const confidence = isNum(v.genderConfidence) ? Math.min(1, Math.max(0, v.genderConfidence)) : 0;
    return [
      {
        speaker: v.speaker,
        sec: v.sec,
        f0Hz: numOrNull(v.f0Hz),
        gender,
        genderConfidence: gender === 'unknown' ? 0 : confidence,
        print: isPrint(v.print) ? v.print : [],
      },
    ];
  });
}

/** A part's answer when it is whole, else undefined (an unreadable save is detected again). */
function parseChunk(raw: unknown): ChunkResult | undefined {
  const r = raw as { turns?: unknown; speakers?: unknown } | null | undefined;
  if (!r || !Array.isArray(r.turns) || !Array.isArray(r.speakers)) return undefined;
  const speakers = r.speakers.flatMap((s: Record<string, unknown> | null) =>
    s && isCount(s.local) && isNum(s.sec)
      ? [
          {
            local: s.local,
            sec: s.sec,
            printSec: isNum(s.printSec) ? s.printSec : 0,
            print: isPrint(s.print) ? s.print : [],
            f0Hz: numOrNull(s.f0Hz),
            lowShare: numOrNull(s.lowShare),
          },
        ]
      : [],
  );
  return { turns: cleanTurns(r.turns), speakers };
}

interface LinkResponse {
  assignments?: { chunk?: unknown; local?: unknown; speaker?: unknown }[];
  speakers?: unknown;
}

export class SherpaDiarizationProvider implements DiarizationService {
  readonly modelKey = `sherpa-2.0.1:${DIARIZATION_EMBEDDING.sha256.slice(0, 12)}:${DIARIZATION_EMBEDDING.threshold}`;
  /** How many parts the machine has room for now (setParallelism); unset: one at a time. */
  private budget: (() => number) | undefined;
  /** The model pairs of each running engine (its GET /health `pool`), by base URL. */
  private readonly pools = new Map<string, Promise<number>>();

  constructor(
    private readonly engines: EngineManager,
    private readonly store: EnginePackStore,
    private readonly timeoutMs: number,
  ) {}

  /**
   * How many parts may run at once right now, asked before each part starts:
   * the server answers 1 while a heavy step runs anywhere (a GPU engine, a
   * big model, a render) and unlimited otherwise; the engine's own pool caps
   * it. Without it, one part at a time, as before.
   */
  setParallelism(budget: () => number): void {
    this.budget = budget;
  }

  async available(): Promise<boolean> {
    return (await pickInstalledPack(this.store, 'speaker-diarization')) !== undefined;
  }

  /**
   * Parts to keep in flight: the budget, capped by the engine's model pairs.
   * An engine of before 0.18 says nothing about a pool: one at a time.
   */
  private async width(engineUrl: () => Promise<string>): Promise<number> {
    let wanted = 1;
    try {
      wanted = this.budget ? this.budget() : 1;
    } catch {
      /* a failing budget is no budget */
    }
    if (!(wanted > 1)) return 1;
    const url = await engineUrl();
    let pool = this.pools.get(url);
    if (!pool) {
      pool = getWorkerJson<{ pool?: unknown }>(`${url}/health`, { timeoutMs: 10_000, workerName: WORKER_NAME })
        .then((h) => (isCount(h?.pool) && h.pool >= 1 ? h.pool : 1))
        .catch(() => 1);
      this.pools.set(url, pool);
    }
    return Math.max(1, Math.min(wanted, await pool));
  }

  async diarize(audioPath: string, opts: DiarizeOptions, signal?: AbortSignal): Promise<Diarization | null> {
    const packId = await pickInstalledPack(this.store, 'speaker-diarization');
    if (!packId) return null;
    // Asked before every request: an engine that died between parts is started again.
    const engineUrl = async (): Promise<string> => (await this.engines.ensureRunning(packId)).replace(/\/$/, '');
    const stat = await fsp.stat(audioPath).catch(() => undefined);
    const durationMs = wavDurationMs(stat?.size ?? 0);
    if (!stat || durationMs < ONE_PASS_MAX_MS) return this.onePass(engineUrl, audioPath, stat?.size ?? 0, opts, signal);
    return this.inParts(engineUrl, audioPath, { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) }, durationMs, opts, signal);
  }

  async embed(audioPath: string, opts: { startMs?: number; endMs?: number } = {}, signal?: AbortSignal): Promise<VoiceEmbedding | null> {
    const packId = await pickInstalledPack(this.store, 'speaker-diarization');
    if (!packId) return null;
    const baseUrl = (await this.engines.ensureRunning(packId)).replace(/\/$/, '');
    const window = {
      ...(isCount(opts.startMs) ? { startMs: opts.startMs } : {}),
      ...(isCount(opts.endMs) ? { endMs: opts.endMs } : {}),
    };
    // Seconds of work, but it can wait behind a part of a long detection
    // holding the models: the usual worker timeout, not a short one.
    const data = await postWorkerJson<Record<string, unknown> | null>(
      `${baseUrl}/embed`,
      { audioPath, ...window },
      { timeoutMs: this.timeoutMs, workerName: WORKER_NAME, signal },
    );
    return {
      print: isPrint(data?.print) ? data.print : [],
      f0Hz: numOrNull(data?.f0Hz),
      lowShare: numOrNull(data?.lowShare),
      speechSec: isNum(data?.speechSec) ? Math.max(0, data.speechSec) : 0,
    };
  }

  private async onePass(
    engineUrl: () => Promise<string>,
    audioPath: string,
    sizeBytes: number,
    opts: DiarizeOptions,
    signal?: AbortSignal,
  ): Promise<Diarization> {
    opts.onProgress?.(0, 1);
    const data = await postWorkerJson<{ turns?: unknown; speakerInfo?: unknown }>(
      `${await engineUrl()}/diarize`,
      {
        audioPath,
        threshold: DIARIZATION_EMBEDDING.threshold,
        ...(opts.numSpeakers && opts.numSpeakers > 0 ? { numSpeakers: opts.numSpeakers } : {}),
        withSpeakers: true,
      },
      { timeoutMs: diarizationTimeoutMs(this.timeoutMs, sizeBytes), workerName: WORKER_NAME, signal },
    );
    const found = { turns: cleanTurns(data.turns), speakers: cleanVoices(data.speakerInfo) };
    opts.onProgress?.(1, 1);
    return found;
  }

  private async inParts(
    engineUrl: () => Promise<string>,
    audioPath: string,
    audio: { sizeBytes: number; mtimeMs: number },
    durationMs: number,
    opts: DiarizeOptions,
    signal?: AbortSignal,
  ): Promise<Diarization> {
    const plan = planDiarizationChunks(durationMs);
    const parts = await this.detectParts(engineUrl, audioPath, audio, plan, opts, signal);
    return this.link(engineUrl, parts, opts, signal);
  }

  async diarizeWindows(
    audioPath: string,
    windows: readonly DiarizationChunk[],
    opts: Pick<DiarizeOptions, 'onProgress' | 'checkpointDir'>,
    signal?: AbortSignal,
  ): Promise<DiarizationPart[] | null> {
    const packId = await pickInstalledPack(this.store, 'speaker-diarization');
    if (!packId) return null;
    const engineUrl = async (): Promise<string> => (await this.engines.ensureRunning(packId)).replace(/\/$/, '');
    const stat = await fsp.stat(audioPath);
    const audio = { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
    const parts = await this.detectParts(engineUrl, audioPath, audio, windows, opts, signal);
    return parts.map((part, i) => ({ ...part, window: windows[i]! }));
  }

  /**
   * Each window from its saved part or from the engine, as many at once as
   * {@link width} allows when each starts; the answers in the order given.
   * A failed part stops new ones from starting, lets those in flight finish
   * (and be saved), then throws; a stop (the signal) throws CANCELLED. Saved
   * as each finishes, so a pause or a retry detects only the parts missing.
   */
  private async detectParts(
    engineUrl: () => Promise<string>,
    audioPath: string,
    audio: { sizeBytes: number; mtimeMs: number },
    plan: readonly DiarizationChunk[],
    opts: Pick<DiarizeOptions, 'onProgress' | 'checkpointDir'>,
    signal?: AbortSignal,
  ): Promise<ChunkResult[]> {
    // No known speaker count here: forcing it on a part where two of the cast
    // talk would split those two into that many. It caps the linking instead,
    // so saved parts stay valid when only the count changes.
    const request = { threshold: DIARIZATION_EMBEDDING.threshold, maxPrintPieces: MAX_PRINT_PIECES };
    const results: (ChunkResult | undefined)[] = plan.map(() => undefined);
    const inFlight = new Set<Promise<void>>();
    let failure: { err: unknown } | undefined;
    let done = 0;
    const finished = (): void => {
      done += 1;
      opts.onProgress?.(done, plan.length);
    };
    opts.onProgress?.(0, plan.length);
    for (const [i, chunk] of plan.entries()) {
      if (signal?.aborted || failure) break;
      const file = opts.checkpointDir ? path.join(opts.checkpointDir, `chunk_${String(chunk.index).padStart(4, '0')}.json`) : undefined;
      const key = chunkCheckpointKey(audio, this.modelKey, chunk, request);
      const saved = file ? parseChunk(await readCheckpoint<unknown>(file, key)) : undefined;
      if (saved) {
        results[i] = saved;
        finished();
        continue;
      }
      // Room for one more? Asked again each time: a heavy step that started
      // since narrows it to one, one that ended widens it again.
      while (inFlight.size > 0 && inFlight.size >= (await this.width(engineUrl))) await Promise.race(inFlight);
      if (signal?.aborted || failure) break;
      const job: Promise<void> = this.detectPart(engineUrl, audioPath, chunk, request, signal)
        .then(async (part) => {
          // Atomic: a resumed run trusts a part that exists.
          if (file) await writeJsonAtomic(file, { key, data: part, savedAt: new Date().toISOString() });
          results[i] = part;
          finished();
        })
        .catch((err: unknown) => {
          failure ??= { err };
        })
        .finally(() => inFlight.delete(job));
      inFlight.add(job);
    }
    await Promise.all(inFlight);
    if (failure && !signal?.aborted) throw failure.err;
    if (signal?.aborted || failure) throw new AppErrorException('CANCELLED', `${WORKER_NAME} request cancelled.`);
    return results.map((r) => r!);
  }

  /**
   * One part, tried twice: an engine that dies on one part of sixty (it can
   * fall over hours in) is restarted by ensureRunning, and the parts already
   * saved are not lost either way. A stop is never retried, nor a part that
   * ran out of time: a 10-minute part takes a minute or two, so one that
   * needed half an hour would need it again.
   */
  private async detectPart(
    engineUrl: () => Promise<string>,
    audioPath: string,
    chunk: DiarizationChunk,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ChunkResult> {
    const partBytes = ((chunk.endMs - chunk.startMs) / 1000) * BYTES_PER_SECOND_16K_MONO;
    for (let attempt = 1; ; attempt++) {
      try {
        const data = await postWorkerJson<unknown>(
          `${await engineUrl()}/diarize-chunk`,
          { audioPath, startMs: chunk.startMs, endMs: chunk.endMs, ...request },
          { timeoutMs: diarizationTimeoutMs(this.timeoutMs, partBytes), workerName: WORKER_NAME, signal },
        );
        const part = parseChunk(data);
        if (!part) throw new AppErrorException('UNKNOWN', `${WORKER_NAME} gave an unreadable answer for part ${chunk.index + 1}.`);
        return part;
      } catch (err) {
        const timedOut = err instanceof AppErrorException && err.appError.code === 'WORKER_TIMEOUT';
        if (signal?.aborted || timedOut || attempt >= 2) throw err;
      }
    }
  }

  private async link(
    engineUrl: () => Promise<string>,
    parts: readonly ChunkResult[],
    opts: DiarizeOptions,
    signal?: AbortSignal,
  ): Promise<Diarization> {
    const items = parts.flatMap((part, chunk) =>
      part.speakers.map((s) => ({ chunk, local: s.local, sec: s.sec, printSec: s.printSec, print: s.print, f0Hz: s.f0Hz, lowShare: s.lowShare })),
    );
    const maxSpeakers = opts.numSpeakers && opts.numSpeakers > 0 ? Math.min(opts.numSpeakers, MAX_DETECTED_SPEAKERS) : MAX_DETECTED_SPEAKERS;
    const data = await postWorkerJson<LinkResponse>(
      `${await engineUrl()}/link`,
      { items, minPrintSec: MIN_PRINT_SEC, maxSpeakers },
      { timeoutMs: this.timeoutMs, workerName: WORKER_NAME, signal },
    );
    const globalOf = new Map<string, number>();
    for (const a of data.assignments ?? []) {
      if (isCount(a.chunk) && isCount(a.local) && isCount(a.speaker)) globalOf.set(`${a.chunk}:${a.local}`, a.speaker);
    }
    const turns = parts
      .flatMap((part, chunk) =>
        part.turns.flatMap((t) => {
          const speaker = globalOf.get(`${chunk}:${t.speaker}`);
          return speaker === undefined ? [] : [{ startMs: t.startMs, endMs: t.endMs, speaker }];
        }),
      )
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    return { turns, speakers: cleanVoices(data.speakers) };
  }
}
