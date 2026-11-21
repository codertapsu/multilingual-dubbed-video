import { describe, expect, it } from 'vitest';

import type { PipelineState, PipelineStepState } from '../../core/models';
import { isNeverStarted } from './never-started';

const step = (id: PipelineStepState['id'], status: PipelineStepState['status']): PipelineStepState => ({
  id,
  label: id,
  status,
  progressPercent: status === 'completed' ? 100 : 0,
});
const pipeline = (status: PipelineState['status'], steps: PipelineStepState[], extra: Partial<PipelineState> = {}): PipelineState => ({
  projectId: 'p',
  steps,
  progressPercent: 0,
  status,
  updatedAt: '2026-11-21T10:00:00.000Z',
  ...extra,
});
const fresh = pipeline('idle', [step('probe-video', 'pending'), step('extract-audio', 'pending'), step('stt', 'pending')]);

describe('isNeverStarted', () => {
  it('offers Start for a project left at the wizard, and for one whose queued start failed', () => {
    expect(isNeverStarted(fresh, 'created', false)).toBe(true);
    expect(isNeverStarted(fresh, 'failed', false)).toBe(true);
  });

  it('not while it waits in the queue or runs', () => {
    expect(isNeverStarted(fresh, 'created', true)).toBe(false);
    expect(isNeverStarted(fresh, 'queued', false)).toBe(false);
    expect(isNeverStarted(fresh, 'running', false)).toBe(false);
  });

  it('not between two steps of a run, where the pipeline reads idle', () => {
    const between = pipeline('idle', [step('probe-video', 'completed'), step('extract-audio', 'pending'), step('stt', 'pending')]);
    expect(isNeverStarted(between, 'created', false)).toBe(false);
  });

  it('not for a dub paused in its first step, nor one paused for review', () => {
    expect(isNeverStarted(pipeline('paused', fresh.steps, { pausedStep: 'probe-video' }), 'paused', false)).toBe(false);
    expect(isNeverStarted({ ...fresh, awaitingReview: true }, 'paused', false)).toBe(false);
  });

  it('not before the project and its pipeline have loaded', () => {
    expect(isNeverStarted(null, 'created', false)).toBe(false);
    expect(isNeverStarted(fresh, undefined, false)).toBe(false);
    expect(isNeverStarted(pipeline('idle', []), 'created', false)).toBe(false);
  });
});
