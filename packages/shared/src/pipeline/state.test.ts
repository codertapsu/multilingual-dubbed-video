import { describe, it, expect } from 'vitest';
import {
  createInitialPipelineState,
  pausePipelineState,
  resumePipelineState,
  setStepStatus,
  withEndsAfter,
} from './state.js';
import { PIPELINE_STEP_DEFS } from './steps.js';

const FIXED = '2026-01-01T00:00:00.000Z';

describe('createInitialPipelineState', () => {
  it('creates all 9 steps in pending status', () => {
    const state = createInitialPipelineState('p1', FIXED);
    expect(state.steps).toHaveLength(9);
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
    // complete 2 of 9 steps -> 22%
    state = setStepStatus(state, 'probe-video', 'completed', undefined, FIXED);
    state = setStepStatus(state, 'extract-audio', 'completed', undefined, FIXED);
    expect(state.progressPercent).toBe(22);
  });

  it("counts the running step's own share, so the overall percent moves inside a long step", () => {
    let state = createInitialPipelineState('p1', FIXED);
    state = setStepStatus(state, 'probe-video', 'completed', undefined, FIXED);
    state = setStepStatus(state, 'extract-audio', 'completed', undefined, FIXED);
    // Speech-to-text at 45 %: (2 + 0.45) / 9. It read 22 % for the whole step.
    state = setStepStatus(state, 'stt', 'running', { progressPercent: 45 }, FIXED);
    expect(state.progressPercent).toBe(27);
    state = setStepStatus(state, 'stt', 'running', { progressPercent: 100 }, FIXED);
    expect(state.progressPercent).toBe(33);
    // Paused, the step waits as pending with its progress: only finished steps count.
    state = pausePipelineState(state, FIXED);
    expect(state.progressPercent).toBe(22);
  });

  it('counts only its own steps when it ends early: a series parent transcribes, its parts dub (claude-dubber, 2026-11-27)', () => {
    let state = withEndsAfter(createInitialPipelineState('p1', FIXED), 'stt');
    state = setStepStatus(state, 'probe-video', 'completed', undefined, FIXED);
    state = setStepStatus(state, 'extract-audio', 'completed', undefined, FIXED);
    // Speaker detection 47/102 of the Phong Thủy Thiên Sư analysis: (2 + 0.73) / 3, not / 9 ("30%").
    state = setStepStatus(state, 'stt', 'running', { progressPercent: 73 }, FIXED);
    expect(state.progressPercent).toBe(91);
    // Paused, then the steps its parts do skipped at the end: done.
    expect(pausePipelineState(state, FIXED).progressPercent).toBe(67);
    state = setStepStatus(state, 'stt', 'completed', undefined, FIXED);
    expect(state.progressPercent).toBe(100);
    // Set on a pipeline already under way, and taken off again: counted again at once.
    const whole = withEndsAfter(state, undefined);
    expect(whole.endsAfter).toBeUndefined();
    expect(whole.progressPercent).toBe(33);
    expect(withEndsAfter(whole, 'stt').progressPercent).toBe(100);
  });

  it('counts skipped steps toward progress', () => {
    let state = createInitialPipelineState('p1', FIXED);
    state = setStepStatus(state, 'probe-video', 'skipped', undefined, FIXED);
    state = setStepStatus(state, 'extract-audio', 'completed', undefined, FIXED);
    expect(state.progressPercent).toBe(22);
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

describe('pausePipelineState / resumePipelineState', () => {
  const LATER = '2026-01-01T00:05:00.000Z';
  const midTranslation = () => {
    let state = createInitialPipelineState('p1', FIXED);
    for (const id of ['probe-video', 'extract-audio', 'stt'] as const) state = setStepStatus(state, id, 'completed', undefined, FIXED);
    return setStepStatus(state, 'translation', 'running', { progressPercent: 45 }, FIXED);
  };

  it('puts the running step back to pending with the progress it had, and pauses there', () => {
    const paused = pausePipelineState(midTranslation(), LATER);
    expect(paused.status).toBe('paused');
    expect(paused.pausedAt).toBe(LATER);
    expect(paused.pausedStep).toBe('translation');
    expect(paused.currentStep).toBe('translation');
    const step = paused.steps.find((s) => s.id === 'translation')!;
    expect(step.status).toBe('pending');
    expect(step.progressPercent).toBe(45);
    expect(step.startedAt).toBeUndefined();
    // Finished steps are untouched.
    expect(paused.steps.filter((s) => s.status === 'completed').map((s) => s.id)).toEqual(['probe-video', 'extract-audio', 'stt']);
  });

  it('pauses at the next step when the run stopped between steps', () => {
    const between = setStepStatus(midTranslation(), 'translation', 'completed', undefined, FIXED);
    const paused = pausePipelineState(between, LATER);
    expect(paused.pausedStep).toBe('refine');
    expect(paused.steps.every((s) => s.status !== 'running')).toBe(true);
  });

  it('leaves a finished pipeline alone', () => {
    let state = createInitialPipelineState('p1', FIXED);
    for (const def of PIPELINE_STEP_DEFS) state = setStepStatus(state, def.id, 'completed', undefined, FIXED);
    expect(pausePipelineState(state, LATER)).toBe(state);
  });

  it('resumes to a status read from the steps again, without the pause fields', () => {
    const resumed = resumePipelineState(pausePipelineState(midTranslation(), LATER), LATER);
    expect(resumed.status).toBe('idle');
    expect(resumed.pausedAt).toBeUndefined();
    expect(resumed.pausedStep).toBeUndefined();
    expect(resumed.currentStep).toBe('translation');
    // A pipeline that was never paused is returned as it is.
    const fresh = createInitialPipelineState('p1', FIXED);
    expect(resumePipelineState(fresh, LATER)).toBe(fresh);
  });
});
