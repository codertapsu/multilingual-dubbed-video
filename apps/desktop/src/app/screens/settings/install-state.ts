/**
 * What a downloadable row in Settings says about itself: a built-in speech
 * model, an Argos language pack. Pure, so the rules are tested
 * (install-state.spec.ts) and the rows only render the answer.
 *
 * The facts come from two places that can disagree for a moment: the app-wide
 * activity (core/activity/activity.service.ts: a download in flight, one that
 * just finished or failed) and what the backend says is on disk. The activity
 * is newer, so it decides while it has something to say.
 */
import type { AppError } from '../../core/models';

/** The part of an activity task a row reads (ActivityTask in core/activity). */
export interface TaskSnapshot {
  state: 'running' | 'done' | 'failed';
  /** 0..100, or null while the size is unknown. */
  percent: number | null;
  message: string;
  error?: AppError;
}

export type DownloadState =
  /** In flight: started here or anywhere else in the app. */
  | { kind: 'downloading'; percent: number | null; message: string }
  /** The last attempt failed: the row shows why, with Try again. */
  | { kind: 'failed'; error: AppError }
  /** On this computer. */
  | { kind: 'ready' }
  /** Not on this computer. */
  | { kind: 'missing' }
  /** What is on disk could not be read (the backend is not answering). */
  | { kind: 'unknown' };

/**
 * The state of one downloadable item.
 *
 * `onDisk` is what the backend last said (null = it could not be asked). A
 * download that just finished counts as on disk before the list is read again:
 * the row must not offer "Download" for a model the top bar has just called
 * downloaded. Settings used to show nothing at all for a model that was not
 * downloaded, and nothing while one downloaded after the page was left and
 * opened again, so a user could not tell whether anything was installed
 * (0.17.0 report).
 */
export function downloadState(task: TaskSnapshot | undefined, onDisk: boolean | null): DownloadState {
  if (task?.state === 'running') return { kind: 'downloading', percent: task.percent, message: task.message };
  if (task?.state === 'failed' && task.error) return { kind: 'failed', error: task.error };
  if (onDisk === true || task?.state === 'done') return { kind: 'ready' };
  return onDisk === null ? { kind: 'unknown' } : { kind: 'missing' };
}

/**
 * The setup installer's name for a speech model (setup/installer.ts), which the
 * activity service lists it under (`setup:<item>`).
 */
export function whisperItem(model: string): string {
  return `whisper:${model}`;
}

/**
 * The setup installer's name for an Argos pair: `argos:<from>-><to>`, the arrow
 * the activity service splits on for its label ("Translation pack en → vi").
 * A different spelling would follow a download nobody reports progress for.
 */
export function argosItem(pair: { from: string; to: string }): string {
  return `argos:${pair.from}->${pair.to}`;
}
