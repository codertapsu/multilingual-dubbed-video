/**
 * The greeting's share of the mix: its plan on disk, where the original
 * speaks, and the clips laid into the dub's track. Used by the mix step
 * (runner.ts) and by "is the mix still current" (orchestrator.mixIsCurrent),
 * which must agree on what the greeting contributed.
 */
import fsp from 'node:fs/promises';

import type { AlignedSegment, GreetingPlan, GreetingSettings, TimeSpan } from '@videodubber/shared';

/**
 * What a plan was made for. A plan the user edited is kept while these stay
 * the same; changing any of them (another greeting, the opening switched off,
 * a different count) plans afresh.
 */
export function greetingSettingsKey(g: Pick<GreetingSettings, 'assetId' | 'atStart' | 'startWindowSec' | 'repeat'>): string {
  return JSON.stringify([g.assetId, g.atStart, g.startWindowSec, g.repeat]);
}

/** A plan as saved, with what it was made for. */
export interface SavedGreetingPlan extends GreetingPlan {
  settingsKey: string;
  /** The user placed, moved or removed greetings (the editor): used as it is. */
  edited?: boolean;
}

export async function readGreetingPlan(file: string): Promise<SavedGreetingPlan | undefined> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<SavedGreetingPlan>;
    return Array.isArray(raw.placements) && typeof raw.assetId === 'string' ? (raw as SavedGreetingPlan) : undefined;
  } catch {
    return undefined;
  }
}

/** When the dub's voice plays: each line's window on the timeline. */
export function dubWindows(aligned: readonly AlignedSegment[]): TimeSpan[] {
  return aligned
    .filter((a) => typeof a.audioPath === 'string' && a.audioPath.length > 0)
    .map((a) => ({ startMs: a.startMs, endMs: a.startMs + Math.max(0, a.placedDurationMs) }));
}

/**
 * When the original speaks: the speech map (`speech_regions.json`) when the
 * run made one, else the transcript's lines.
 */
export async function originalSpeech(speechRegionsFile: string, sourceJsonFile: string): Promise<TimeSpan[]> {
  const spans = (raw: unknown): TimeSpan[] =>
    Array.isArray(raw)
      ? raw.filter(
          (r): r is TimeSpan =>
            typeof r === 'object' && r !== null && Number.isFinite((r as TimeSpan).startMs) && Number.isFinite((r as TimeSpan).endMs),
        )
      : [];
  try {
    const regions = spans((JSON.parse(await fsp.readFile(speechRegionsFile, 'utf8')) as { regions?: unknown }).regions);
    if (regions.length > 0) return regions;
  } catch {
    /* no speech map: the transcript */
  }
  try {
    return spans((JSON.parse(await fsp.readFile(sourceJsonFile, 'utf8')) as { segments?: unknown }).segments);
  } catch {
    return [];
  }
}
