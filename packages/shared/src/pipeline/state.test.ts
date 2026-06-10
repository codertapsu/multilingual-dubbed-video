import { describe, it, expect } from 'vitest';
import {
  createInitialPipelineState,
  setStepStatus,
} from './state.js';
import { PIPELINE_STEP_DEFS } from './steps.js';

const FIXED = '2026-01-01T00:00:00.000Z';

describe('createInitialPipelineState', () => {
  it('creates all 8 steps in pending status', () => {
    const state = createInitialPipelineState('p1', FIXED);
    expect(state.steps).toHaveLength(8);
    expect(state.steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('starts at idle with 0% progress and no currentStep', () => {
    const state = createInitialPipelineState('p1', FIXED);
    expect(state.status).toBe('idle');
    expect(state.progressPercent).toBe(0);
    expect(state.currentStep).toBeUndefined();
  });

  it('orders steps as defined in PIPELINE_STEP_DEFS', () => {
    const state = createInitialPipelineState('p1', FIXED);
    expect(state.steps.map((s) => s.id)).toEqual(PIPELINE_STEP_DEFS.map((d) => d.id));
  });

  it('stores the projectId and updatedAt', () => {
    const state = createInitialPipelineState('proj-42', FIXED);
    expect(state.projectId).toBe('proj-42');
    expect(state.updatedAt).toBe(FIXED);
  });
});

describe('setStepStatus', () => {
  it('does not mutate the input state', () => {
    const initial = createInitialPipelineState('p1', FIXED);
    const next = setStepStatus(initial, 'probe-video', 'running', undefined, FIXED);
    expect(initial.steps[0]?.status).toBe('pending');
    expect(next).not.toBe(initial);
    expect(next.steps).not.toBe(initial.steps);
  });

  it('marks the step running and rolls up overall status to running', () => {
    const state = setStepStatus(
      createInitialPipelineState('p1', FIXED),
      'probe-video',
      'running',
      undefined,
      FIXED,
    );
    expect(state.steps[0]?.status).toBe('running');
    expect(state.status).toBe('running');
    expect(state.currentStep).toBe('probe-video');
  });

  it('sets startedAt automatically when entering running', () => {
    const state = setStepStatus(
      createInitialPipelineState('p1', FIXED),
      'probe-video',
      'running',
      undefined,
      FIXED,
    );
    expect(state.steps[0]?.startedAt).toBe(FIXED);
  });

  it('sets progress to 100 and finishedAt on completion', () => {
    const state = setStepStatus(
      createInitialPipelineState('p1', FIXED),
      'probe-video',
      'completed',
      undefined,
      FIXED,
    );
    expect(state.steps[0]?.progressPercent).toBe(100);
    expect(state.steps[0]?.finishedAt).toBe(FIXED);
  });

  it('recomputes overall progress as completed/total*100', () => {
    let state = createInitialPipelineState('p1', FIXED);
    // complete 2 of 8 steps -> 25%
    state = setStepStatus(state, 'probe-video', 'completed', undefined, FIXED);
    state = setStepStatus(state, 'extract-audio', 'completed', undefined, FIXED);
    expect(state.progressPercent).toBe(25);
  });

  it('counts skipped steps toward progress', () => {
    let state = createInitialPipelineState('p1', FIXED);
    state = setStepStatus(state, 'probe-video', 'skipped', undefined, FIXED);
    state = setStepStatus(state, 'extract-audio', 'completed', undefined, FIXED);
    expect(state.progressPercent).toBe(25);
  });

  it('advances currentStep to the next non-done step', () => {
    let state = createInitialPipelineState('p1', FIXED);
    state = setStepStatus(state, 'probe-video', 'completed', undefined, FIXED);
    expect(state.currentStep).toBe('extract-audio');
  });

  it('rolls up to failed when any step fails and records the error', () => {
    let state = createInitialPipelineState('p1', FIXED);
    state = setStepStatus(state, 'probe-video', 'completed', undefined, FIXED);
    state = setStepStatus(
      state,
      'extract-audio',
      'failed',
      { error: 'FFmpeg missing' },
      FIXED,
    );
    expect(state.status).toBe('failed');
    expect(state.error).toBe('FFmpeg missing');
    expect(state.steps[1]?.error).toBe('FFmpeg missing');
  });

  it('failed takes precedence over running', () => {
    let state = createInitialPipelineState('p1', FIXED);
    state = setStepStatus(state, 'stt', 'running', undefined, FIXED);
    state = setStepStatus(state, 'extract-audio', 'failed', { error: 'x' }, FIXED);
    expect(state.status).toBe('failed');
  });

  it('rolls up to completed when all steps are completed or skipped', () => {
    let state = createInitialPipelineState('p1', FIXED);
    for (const def of PIPELINE_STEP_DEFS) {
      state = setStepStatus(state, def.id, 'completed', undefined, FIXED);
    }
    expect(state.status).toBe('completed');
    expect(state.progressPercent).toBe(100);
    expect(state.currentStep).toBeUndefined();
    expect(state.error).toBeUndefined();
  });

  it('clears a stale error when transitioning away from failed', () => {
    let state = createInitialPipelineState('p1', FIXED);
    state = setStepStatus(state, 'probe-video', 'failed', { error: 'boom' }, FIXED);
    expect(state.status).toBe('failed');
    // retry: reset to pending then running
    state = setStepStatus(state, 'probe-video', 'pending', undefined, FIXED);
    expect(state.steps[0]?.error).toBeUndefined();
    state = setStepStatus(state, 'probe-video', 'running', undefined, FIXED);
    expect(state.status).toBe('running');
    expect(state.error).toBeUndefined();
  });

  it('is idempotent: applying the same completed transition twice is stable', () => {
    const base = createInitialPipelineState('p1', FIXED);
    const once = setStepStatus(base, 'probe-video', 'completed', undefined, FIXED);
    const twice = setStepStatus(once, 'probe-video', 'completed', undefined, FIXED);
    expect(twice.steps[0]).toEqual(once.steps[0]);
    expect(twice.progressPercent).toBe(once.progressPercent);
    expect(twice.status).toBe(once.status);
  });

  it('honors an explicit progressPercent patch and clamps it', () => {
    let state = createInitialPipelineState('p1', FIXED);
    state = setStepStatus(state, 'stt', 'running', { progressPercent: 250 }, FIXED);
    expect(state.steps[2]?.progressPercent).toBe(100);
    state = setStepStatus(state, 'stt', 'running', { progressPercent: -5 }, FIXED);
    expect(state.steps[2]?.progressPercent).toBe(0);
  });

  it('resetting a step to pending sets its progress back to 0', () => {
    let state = createInitialPipelineState('p1', FIXED);
    state = setStepStatus(state, 'stt', 'completed', undefined, FIXED);
    expect(state.steps[2]?.progressPercent).toBe(100);
    state = setStepStatus(state, 'stt', 'pending', undefined, FIXED);
    expect(state.steps[2]?.progressPercent).toBe(0);
  });

  it('updates updatedAt on each transition', () => {
    const state = createInitialPipelineState('p1', FIXED);
    const later = '2026-02-02T02:02:02.000Z';
    const next = setStepStatus(state, 'probe-video', 'running', undefined, later);
    expect(next.updatedAt).toBe(later);
  });
});
