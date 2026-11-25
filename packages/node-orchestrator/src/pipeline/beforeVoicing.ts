/**
 * What a dub would voice with a problem, said in the project's warnings: the
 * lines still failing the translation checks before any voice is made, and the
 * lines whose voice cannot fit their time even at the fastest speed allowed.
 * claude-dubber found both in finished parts of 《反相之地》 only by reading
 * the reports and the alignment (2026-11-25, H7): "Flagged lines are voiced
 * anyway". Pure.
 */
import type { AlignedSegment, ProjectWarning } from '@videodubber/shared';
import type { FlaggedLine } from '../providers/translation/dubPasses.js';
import type { QualityFlag } from '../providers/translation/lineQuality.js';

type Warning = Omit<ProjectWarning, 'at' | 'step'>;

/** Lines a warning names; more are an ellipsis. */
const NAMED = 5;

/** The held lines kept in pipeline.json (PipelineState.heldLines), at most. */
export const MAX_HELD_LINES = 200;

/** Each check in a few words, for the English message (the app's own wording names only the ids). */
const FLAG_WORDS: Record<QualityFlag, string> = {
  untranslated: 'untranslated',
  'wrong-script': 'letters of another script',
  pinyin: 'a pinyin name',
  'no-diacritics': 'no diacritics',
  alternatives: '"/" alternatives',
};

const named = (ids: readonly string[]): string => ids.slice(0, NAMED).join(', ') + (ids.length > NAMED ? ', …' : '');

/**
 * The lines still failing the checks after both repairs. `held`: the run
 * stops before voicing for them (settings.holdFlaggedLines); otherwise they
 * are voiced as they are, and the warning says how to fix them after.
 */
export function flaggedLinesWarning(flagged: readonly FlaggedLine[], held: boolean): Warning {
  const ids = flagged.map((f) => f.id);
  const detail =
    flagged
      .slice(0, NAMED)
      .map((f) => `${f.id} (${f.flags.map((x) => FLAG_WORDS[x]).join(', ')})`)
      .join(', ') + (flagged.length > NAMED ? ', …' : '');
  return {
    code: 'lines-flagged',
    key: held ? 'warning.lines-flagged-held' : 'warning.lines-flagged',
    params: { count: flagged.length, ids: named(ids) },
    message: held
      ? `${flagged.length} line(s) still fail the translation checks after two repairs: ${detail}. ` +
        'The dub stopped before voicing: fix them (get_transcript marks them NEEDS FIX; set_translations), then continue dubbing.'
      : `${flagged.length} line(s) still fail the translation checks after two repairs and are voiced as they are: ${detail}. ` +
        'Fix them (get_transcript marks them NEEDS FIX; set_translations) and regenerate their voices, ' +
        'or turn on holdFlaggedLines to stop before voicing next time.',
  };
}

/** The units that cannot fit even at the fastest speed allowed (alignment `timing-conflict`). */
export function timingConflictWarning(aligned: readonly AlignedSegment[], maxSpeedRatio: number): Warning {
  const ids = aligned.filter((a) => a.status === 'timing-conflict').map((a) => a.segmentId);
  return {
    code: 'timing-conflicts',
    key: 'warning.timing-conflicts',
    params: { count: ids.length, ids: named(ids), speed: Number(maxSpeedRatio.toFixed(2)) },
    message:
      `${ids.length} line(s) cannot fit their time even at the fastest speed allowed (${Number(maxSpeedRatio.toFixed(2))}x), ` +
      `so they run over into what follows: ${named(ids)}. Shorten them (set_translations, then regenerate_voices) or allow a higher maxSpeedRatio.`,
  };
}
