/**
 * Which `done`/`error` frames of a project's event stream describe the run on
 * screen, and which are an earlier run's, replayed. Pure: the event service
 * (pipeline-events.service.ts) feeds it every frame of a connection.
 *
 * What the orchestrator sends a new subscriber (server.ts `GET
 * /projects/:id/events` over events.ts `ProjectEventBus.subscribe`), in order:
 *
 *   1. the bus's last `state` frame, when a run emitted one since start-up;
 *   2. the last `done`/`error` the bus ever emitted, written right after it;
 *   3. the pipeline as saved on disk, once that file has been read;
 *   4. live frames.
 *
 * The bus never forgets (2) when a new run starts. So a screen that connected
 * while a retry was running was handed [state: running, error: the failure
 * being retried] and showed that failure over a run that was going fine, and
 * one that connected during a re-render was handed the last dub's `done` and
 * offered "Open editor" and "Export" over a render in progress.
 *
 * The replayed terminal is told apart by its place: the frame right after a
 * first `state` frame. Frames after it are live (or the disk read), and a live
 * terminal always counts.
 */
import type { PipelineState } from '../models';
import type { PipelineEvent } from '../models/view-models';

type RunStatus = PipelineState['status'];

/** What one connection has delivered so far. */
export interface ReplayCursor {
  /** Frames handled on this connection. */
  readonly frames: number;
  /** The status in the connection's first frame, when that was a state: the replayed state. */
  readonly firstStatus: RunStatus | null;
}

/** A connection that has delivered nothing yet (every reconnect starts here). */
export const NEW_CONNECTION: ReplayCursor = { frames: 0, firstStatus: null };

/** The cursor once `event` has been handled. */
export function nextCursor(cursor: ReplayCursor, event: PipelineEvent): ReplayCursor {
  return {
    frames: cursor.frames + 1,
    firstStatus: cursor.frames === 0 && event.type === 'state' ? event.pipeline.status : cursor.firstStatus,
  };
}

/**
 * Whether a `done`/`error` frame, arriving at `cursor`, ended a run before the
 * one the replayed state shows.
 *
 * - `done` is emitted only right after the state that completes the run, so a
 *   replayed `done` beside any other state (running, paused, a review pause)
 *   is the end of an earlier run.
 * - A replayed `error` beside a `running` state is the failure being retried.
 *   Beside a paused or idle state it may be a real one: a queued Continue that
 *   could not start says so with an `error` and no new state. That one stays.
 * - A terminal in the first frame came with no state: no run has emitted one
 *   since, so it is the latest word on this project.
 */
export function isStaleTerminal(kind: 'done' | 'error', cursor: ReplayCursor): boolean {
  if (cursor.frames !== 1 || cursor.firstStatus === null) return false;
  return kind === 'done' ? cursor.firstStatus !== 'completed' : cursor.firstStatus === 'running';
}

/**
 * A `state` frame of a run in progress: whatever ended an earlier run no longer
 * describes this one. A run started while the screen is open (by Claude, from
 * another screen) used to leave the old failure banner up over it.
 */
export function startsNewRun(pipeline: PipelineState): boolean {
  return pipeline.status === 'running';
}
