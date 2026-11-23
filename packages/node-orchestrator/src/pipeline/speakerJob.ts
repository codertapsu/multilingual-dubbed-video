/**
 * A speaker detection job's state, kept in the project's folder
 * (audio/speaker_detection.json) so it outlives the app.
 *
 * WHY: the job lived only in the backend's memory. The 27.8-hour series'
 * detection ran almost five hours; a restart in that time lost it without a
 * word, the editor's spinner waited on nothing, and an agent following it with
 * get_speakers saw no job at all (claude-dubber report, 2026-11-23, R3/F6). A
 * job the file says is running while no process runs it is one the app died
 * on: it shows as interrupted, with Retry, which resumes from the parts
 * already saved (audio/diarization-chunks).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException } from '@videodubber/shared';
import type { WorkspacePaths } from '../workspace/paths.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';

/** What a detection job says about itself (GET /projects/:id/speakers `job`). */
export interface SpeakerJobState {
  state: 'running' | 'done' | 'failed';
  /** Parts of the audio done, of the total. */
  done: number;
  total: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Speakers who say a line, after it. */
  speakers?: number;
  /** Lines given only a best guess. */
  lowConfidence?: number;
  /** Old speaker ids that moved to new ones (a whole detection renumbers). */
  remapped?: number;
  /** A ranged detection: only the lines in this range were labelled again. */
  range?: { fromMs: number; toMs: number };
  /** Lines of the range whose speaker changed (ranged). */
  relabelled?: number;
  /** Voices heard for the first time, with new ids (ranged). */
  added?: number;
  /** Parts detected again (ranged; 0 when the saved detection matched the audio). */
  detectedParts?: number;
  /** The known number of people asked for. */
  numSpeakers?: number;
  /** Its entry in the activity list (GET /activity). */
  activityId?: string;
}

/** As shown: a job saved as running that nothing runs was interrupted (the app closed or crashed). */
export type SpeakerJobView = Omit<SpeakerJobState, 'state'> & { state: SpeakerJobState['state'] | 'interrupted' };

const FORMAT = 1;

/** Where a project's detection job is kept. */
export function speakerJobFile(paths: Pick<WorkspacePaths, 'audioDir'>): string {
  return path.join(paths.audioDir, 'speaker_detection.json');
}

const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** The saved job, or undefined: none yet, unreadable, or of another format. */
export async function readSpeakerJob(file: string): Promise<SpeakerJobState | undefined> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<SpeakerJobState> & { format?: number };
    if (raw.format !== FORMAT || (raw.state !== 'running' && raw.state !== 'done' && raw.state !== 'failed')) return undefined;
    if (!isCount(raw.done) || !isCount(raw.total) || typeof raw.startedAt !== 'string') return undefined;
    const { format: _f, ...job } = raw;
    return job as SpeakerJobState;
  } catch {
    return undefined;
  }
}

/** Save the job's state; never throws (a state that could not be saved must not stop the detection). */
export async function saveSpeakerJob(file: string, job: SpeakerJobState): Promise<void> {
  try {
    await writeJsonAtomic(file, { format: FORMAT, ...job, savedAt: new Date().toISOString() });
  } catch {
    /* best effort */
  }
}

/** The job as shown: `live` = this process runs it. Pure. */
export function speakerJobView(job: SpeakerJobState, live: boolean): SpeakerJobView {
  return job.state === 'running' && !live ? { ...job, state: 'interrupted' } : { ...job };
}

/**
 * The range a detection is asked for: both ends or neither (the whole video).
 * Throws INVALID_EDIT for one end alone or a range that ends before it starts. Pure.
 */
export function detectionRange(opts: { fromMs?: unknown; toMs?: unknown }): { fromMs: number; toMs: number } | undefined {
  const given = (v: unknown): boolean => v !== undefined && v !== null;
  if (!given(opts.fromMs) && !given(opts.toMs)) return undefined;
  const fromMs = Number(opts.fromMs);
  const toMs = Number(opts.toMs);
  if (!given(opts.fromMs) || !given(opts.toMs) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0 || toMs <= fromMs) {
    throw new AppErrorException('INVALID_EDIT', 'Give both fromMs and toMs (in ms of the video), the end after the start, or neither for the whole video.');
  }
  return { fromMs: Math.round(fromMs), toMs: Math.round(toMs) };
}

/** How a detection ended, for the activity list ("12 speakers, 40 best guesses"). Pure. */
export function speakerJobSummary(job: SpeakerJobState): string {
  if (job.range) {
    const parts = [`${job.relabelled ?? 0} line(s) changed speaker`];
    if (job.added) parts.push(`${job.added} new speaker(s)`);
    if (job.detectedParts === 0) parts.push('from the saved detection');
    return parts.join(', ');
  }
  return `${job.speakers ?? 0} speaker(s)${job.lowConfidence ? `, ${job.lowConfidence} best guess(es)` : ''}`;
}
