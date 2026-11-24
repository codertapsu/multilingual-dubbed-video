/**
 * What a change asked of a whole series does with each of its parts, worded
 * for the user and the agent who asked. Pure.
 *
 * WHY (claude-dubber, 48-part series, 2026-11-24): `applyToParts` left every
 * part that only WAITED in the queue as it was, saying "dubbing now", so the
 * agent could not tell why most parts kept their old picture settings. And
 * start_dubbing on the series with `fromStep` reran the PARENT, whose run
 * skips every step after speech-to-text (runner.ts): it "finished" at once and
 * no part was redone, without a word.
 */
import { AppErrorException, pipelineStepIndex, type PipelineStepId } from '@videodubber/shared';

/** What works on a part now (Orchestrator.workOn); undefined = some other job (a re-transcription). */
export type PartWork = 'running' | 'moving' | 'editing' | 'detecting' | 'queued' | undefined;

/** Why a change made with applyToParts left a part as it was, and what to do. */
export function partSkipReason(work: PartWork): string {
  switch (work) {
    case 'queued':
      return 'waiting in the queue: pause the series (it keeps all its work), apply again, then start the series';
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
 * A redo from `stepId` asked of a series parent: refused once its parts
 * exist and the step is one only the parts run (after speech-to-text), with
 * the way to do it. Undefined when the redo is the parent's own to do.
 */
export function seriesRedoRefusal(stepId: PipelineStepId, partCount: number): AppErrorException | undefined {
  if (partCount === 0 || pipelineStepIndex(stepId) <= pipelineStepIndex('stt')) return undefined;
  return new AppErrorException(
    'INVALID_EDIT',
    `This is a series of ${partCount} part(s): every step after speech-to-text runs in its parts, so a redo from "${stepId}" is done part by part.`,
    {
      remediation:
        'Redo the step in each finished part (start_dubbing on the part, with fromStep), or start the series without fromStep to continue its parts in order.',
    },
  );
}
