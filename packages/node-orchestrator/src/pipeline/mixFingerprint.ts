/**
 * Is `final_mix.wav` still the mix of what is on disk?
 *
 * The run skips a step whose artifact exists, and that is right for a pause or
 * a crash, but a finished mix goes out of date without anything noticing: an
 * editor edit re-voices or moves a line, a mix setting changes. Export's
 * "Render again" used to render the old mix under the new subtitles. So the
 * mix records what it was made from (`audio/final_mix.inputs.json`, written
 * after the mix succeeds) and a render compares that with the inputs now.
 *
 * The fingerprint covers everything the mix reads: each dub clip (its file's
 * size and modification time, where it is placed, the part of it that plays,
 * its speed), the original soundtrack, the video's length and the settings
 * that shape the mix. Clip paths are taken relative to the project folder, so
 * moving the projects folder (which rewrites them) does not count as a change.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AlignedSegment, ProjectSettings } from '@videodubber/shared';

import { writeJsonAtomic } from '../workspace/projectStore.js';

/** Bumped when the fingerprint's contents change, so old records read as stale. */
const FINGERPRINT_VERSION = 1;

/** The settings the mix step reads (stepAudioMix). */
export const MIX_SETTING_KEYS = [
  'originalAudioMode',
  'includeOriginalBackgroundAudio',
  'duckOriginalAudio',
  'duckingLevelDb',
  'ttsGainDb',
  'roomTone',
  'timeStretchEngine',
] as const satisfies readonly (keyof ProjectSettings)[];

export interface MixInputs {
  /** The project folder: clip paths are recorded relative to it. */
  workspaceDir: string;
  aligned: readonly AlignedSegment[];
  totalDurationMs: number;
  settings: ProjectSettings;
  originalWav: string;
  /** The spoken greeting's clips (branding), when it plays. */
  greeting?: { file: string; placements: readonly { atMs: number }[]; gainDb: number; key: string };
  /** Where the original plays as it is: the lines kept as a song (songs/songLines.ts). */
  keepOriginal?: readonly { startMs: number; endMs: number }[];
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}

async function stamp(file: string): Promise<FileStamp | null> {
  try {
    const s = await fsp.stat(file);
    // Whole milliseconds, rounded down: a copy that keeps the time (a move
    // across drives) may keep only those.
    return { size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
  } catch {
    return null;
  }
}

/** A path inside the project as a portable relative one; anything else as it is. */
function portable(workspaceDir: string, file: string): string {
  const rel = path.relative(workspaceDir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
}

/** The fingerprint of the mix inputs as they are on disk now. */
export async function mixFingerprint(inputs: MixInputs): Promise<string> {
  const clips = await Promise.all(
    inputs.aligned.map(async (a) => ({
      clip: portable(inputs.workspaceDir, a.audioPath),
      file: await stamp(a.audioPath),
      startMs: a.startMs,
      speedRatio: a.speedRatio,
      durationMs: a.generatedDurationMs,
      trim: a.trimStartMs !== undefined && a.trimEndMs !== undefined ? [a.trimStartMs, a.trimEndMs] : null,
    })),
  );
  const settings = Object.fromEntries(MIX_SETTING_KEYS.map((k) => [k, inputs.settings[k] ?? null]));
  const greeting = inputs.greeting
    ? {
        file: await stamp(inputs.greeting.file),
        at: inputs.greeting.placements.map((p) => p.atMs),
        gainDb: inputs.greeting.gainDb,
        key: inputs.greeting.key,
      }
    : null;
  const body = JSON.stringify({
    v: FINGERPRINT_VERSION,
    totalDurationMs: inputs.totalDurationMs,
    original: await stamp(inputs.originalWav),
    settings,
    clips,
    greeting,
    // Only when there are songs: every mix made before them stays current.
    ...(inputs.keepOriginal?.length ? { keepOriginal: inputs.keepOriginal.map((w) => [w.startMs, w.endMs]) } : {}),
  });
  return crypto.createHash('sha256').update(body).digest('hex');
}

/** Record what the mix just written was made from. */
export async function writeMixFingerprint(file: string, fingerprint: string): Promise<void> {
  await writeJsonAtomic(file, { version: FINGERPRINT_VERSION, fingerprint });
}

/** The fingerprint recorded with the mix, or undefined (no mix, or one made before this existed). */
export async function readMixFingerprint(file: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as { version?: unknown; fingerprint?: unknown };
    return raw.version === FINGERPRINT_VERSION && typeof raw.fingerprint === 'string' ? raw.fingerprint : undefined;
  } catch {
    return undefined;
  }
}
