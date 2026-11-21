import { describe, expect, it } from 'vitest';

import type { AppError, PipelineState } from '../models';
import type { PipelineEvent } from '../models/view-models';
import { NEW_CONNECTION, isStaleTerminal, nextCursor, startsNewRun, type ReplayCursor } from './pipeline-replay';

const state = (status: PipelineState['status'], extra: Partial<PipelineState> = {}): PipelineEvent => ({
  type: 'state',
  pipeline: { projectId: 'p', steps: [], progressPercent: 0, status, updatedAt: '2026-11-21T10:00:00.000Z', ...extra },
});
const failure: AppError = { code: 'WORKER_TIMEOUT', message: 'The voice engine did not answer.' };
const error: PipelineEvent = { type: 'error', error: failure };
const log: PipelineEvent = { type: 'log', level: 'info', message: 'Step started.', ts: '2026-11-21T10:00:01.000Z' };

/** The cursor a terminal arrives at, after `before` on a fresh connection. */
function cursorAfter(...before: PipelineEvent[]): ReplayCursor {
  return before.reduce(nextCursor, NEW_CONNECTION);
}

describe('replayed terminals', () => {
  it('drops the failure replayed while its retry runs', () => {
    expect(isStaleTerminal('error', cursorAfter(state('running')))).toBe(true);
  });

  it("drops the last dub's done replayed during a re-render, a pause or a review pause", () => {
    expect(isStaleTerminal('done', cursorAfter(state('running')))).toBe(true);
    expect(isStaleTerminal('done', cursorAfter(state('paused')))).toBe(true);
    expect(isStaleTerminal('done', cursorAfter(state('idle', { awaitingReview: true })))).toBe(true);
  });

  it('keeps the terminal replayed beside the state of the run it ended', () => {
    expect(isStaleTerminal('done', cursorAfter(state('completed')))).toBe(false);
    expect(isStaleTerminal('error', cursorAfter(state('failed')))).toBe(false);
  });

  it('keeps an error replayed beside a paused run: a queued Continue that could not start says why', () => {
    expect(isStaleTerminal('error', cursorAfter(state('paused')))).toBe(false);
    expect(isStaleTerminal('error', cursorAfter(state('idle')))).toBe(false);
  });

  it('keeps a terminal that arrives first: no run has emitted a state since it', () => {
    expect(isStaleTerminal('error', NEW_CONNECTION)).toBe(false);
    expect(isStaleTerminal('done', NEW_CONNECTION)).toBe(false);
  });

  it('keeps every live terminal, whatever the state before it', () => {
    // Replayed state, the state read from disk, then a live failure.
    expect(isStaleTerminal('error', cursorAfter(state('running'), state('running')))).toBe(false);
    expect(isStaleTerminal('error', cursorAfter(state('running'), state('running'), log))).toBe(false);
    expect(isStaleTerminal('done', cursorAfter(state('running'), state('completed')))).toBe(false);
  });

  it('reads the replayed state from the first frame only', () => {
    expect(cursorAfter(state('running'), state('failed'))).toEqual({ frames: 2, firstStatus: 'running' });
    expect(cursorAfter(log, state('running'))).toEqual({ frames: 2, firstStatus: null });
  });

  it('takes a state after a first-frame terminal for the disk read, and keeps what follows', () => {
    // A queued start that failed before any run: the bus holds that error and
    // no state, so the state after it is the pipeline read from disk.
    const cursor = cursorAfter(error, state('idle'));
    expect(cursor.firstStatus).toBeNull();
    expect(isStaleTerminal('error', cursor)).toBe(false);
  });
});

describe('a run in progress supersedes an earlier terminal', () => {
  it('is said by a running state only', () => {
    const pipeline = (status: PipelineState['status']): PipelineState =>
      (state(status) as Extract<PipelineEvent, { type: 'state' }>).pipeline;
    expect(startsNewRun(pipeline('running'))).toBe(true);
    for (const status of ['idle', 'paused', 'failed', 'completed'] as const) expect(startsNewRun(pipeline(status))).toBe(false);
  });
});
