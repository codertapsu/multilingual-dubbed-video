/**
 * What a change asked of a whole series does with each of its parts, worded
 * for the user and the agent who asked. Pure.
 *
 * WHY (claude-dubber, 48-part series, 2026-11-24): the user wanted the
 * watermark blurred and a new greeting in every part. `applyToParts` left
 * every part that only WAITED in the queue as it was, saying "dubbing now";
 * and start_dubbing on the series with `fromStep` reran the PARENT, whose run
 * skips every step after speech-to-text (runner.ts): it "finished" at once and
 * no part was redone, without a word. Now a waiting part takes a change that
 * only touches its mix and render where it waits, and a series redoes its
 * mix or render in every part that made one.
 */
import { AppErrorException, pipelineStepIndex, type PipelineStepId, type PipelineStepStatus, type ProjectSettings } from '@videodubber/shared';

/** What works on a part now (Orchestrator.workOn); undefined = some other job (a re-transcription). */
export type PartWork = 'running' | 'moving' | 'editing' | 'detecting' | 'queued' | undefined;

/**
 * Settings that change only how a dub is mixed and rendered: what the
 * picture hides, the logo and greeting, the subtitles, the render quality and
 * the levels. None of them is read when the queue classifies a run
 * (scheduler/workload.ts reads the engines, the original-audio mode, forced
 * alignment and auto-fit), so a part waiting in the queue may take them where
 * it waits without its place or lane being wrong.
 */
export const MIX_AND_RENDER_KEYS: ReadonlySet<keyof ProjectSettings> = new Set<keyof ProjectSettings>([
  'blurRegions',
  'watermarkAuto',
  'burnSubtitleStyle',
  'branding',
  'songSubtitles',
  'subtitleExportMode',
  'syncSubtitlesToVoice',
  'renderQuality',
  'duckingLevelDb',
  'ttsGainDb',
]);

/**
 * The mix-and-render settings the alignment step also reads: it writes the
 * subtitle files (song lines shown or not, cues held to the dub voice). A dub
 * running past its alignment has used them already.
 */
export const SUBTITLE_FILE_KEYS: ReadonlySet<keyof ProjectSettings> = new Set<keyof ProjectSettings>(['songSubtitles', 'syncSubtitlesToVoice']);

/** JSON with every object's keys sorted: two settings with the same values compare equal. Pure. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** Whether a settings change touches only the mix and the render ({@link MIX_AND_RENDER_KEYS}). */
export function changesOnlyMixAndRender(patch: Partial<ProjectSettings>): boolean {
  const keys = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k as keyof ProjectSettings);
  return keys.length > 0 && keys.every((k) => MIX_AND_RENDER_KEYS.has(k));
}

/** Why a change made with applyToParts left a part as it was, and what to do. */
export function partSkipReason(work: PartWork): string {
  switch (work) {
    case 'queued':
      return 'waiting in the queue, and this change is not only to its mix or render: pause the series (it keeps all its work), apply again, then start the series';
    case 'running':
      return 'dubbing now: pause it (or the series), then apply again';
    case 'editing':
      return 'busy in the editor (a voice or preview job): apply again when that is done';
    case 'detecting':
      return 'its speakers are being detected: apply again when that is done';
    case 'moving':
      return 'its finished files are being moved: apply again in a moment';
    default:
      return 'busy with a job (a re-transcription, say): apply again when it is done';
  }
}

/**
 * The steps a whole series can redo, in every part that made them: the
 * timing, the mix and the render. Cheap, and they never replace what the user
 * or an agent wrote (a redo of the translation or the voices in 48 parts
 * would be hours of work, and would replace edited lines).
 */
export const SERIES_REDO_STEPS: readonly PipelineStepId[] = ['alignment', 'audio-mix', 'render'];

/**
 * A redo from `stepId` asked of a series parent: refused once its parts exist
 * and the step is one only the parts run and the series cannot redo across
 * them, with the way to do it. Undefined when it may go on: the parent's own
 * steps, a series not split yet, or one of {@link SERIES_REDO_STEPS}.
 */
export function seriesRedoRefusal(stepId: PipelineStepId, partCount: number): AppErrorException | undefined {
  if (partCount === 0 || pipelineStepIndex(stepId) <= pipelineStepIndex('stt') || SERIES_REDO_STEPS.includes(stepId)) return undefined;
  return new AppErrorException(
    'INVALID_EDIT',
    `This is a series of ${partCount} part(s): a redo from "${stepId}" in every part would redo hours of work and replace what was written in them.`,
    {
      remediation:
        'Redo the step in the parts that need it (start_dubbing on each part, with fromStep). Across the whole series, only the timing, the mix and the render can be redone (fromStep "alignment", "audio-mix" or "render").',
    },
  );
}

/**
 * What a series redo from `stepId` does with one part: redo it where the part
 * made that step, else leave the part and say why. `busy` is what works on
 * the part now, when anything does.
 */
export function partRedoAction(
  stepId: PipelineStepId,
  stepStatus: PipelineStepStatus | undefined,
  busy: { work: PartWork } | undefined,
): { redo: true } | { redo: false; reason: string } {
  if (busy?.work === 'queued') return { redo: false, reason: 'waiting in the queue: it uses the change when it gets there' };
  if (busy) return { redo: false, reason: partSkipReason(busy.work).replace('apply again', 'redo it') };
  if (stepStatus === 'completed') return { redo: true };
  return { redo: false, reason: `has not made "${stepId}" yet: it uses the change when it gets there` };
}
