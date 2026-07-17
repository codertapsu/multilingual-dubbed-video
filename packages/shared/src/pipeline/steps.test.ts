import { describe, it, expect } from 'vitest';
import {
  PIPELINE_STEP_DEFS,
  PIPELINE_STEP_IDS,
  pipelineStepLabel,
  pipelineStepIndex,
} from './steps.js';
import { createInitialPipelineState, normalizePipelineState } from './state.js';

describe('PIPELINE_STEP_DEFS', () => {
  it('defines exactly 9 steps in pipeline order', () => {
    expect(PIPELINE_STEP_DEFS.map((d) => d.id)).toEqual([
      'probe-video',
      'extract-audio',
      'stt',
      'translation',
      'refine',
      'tts',
      'alignment',
      'audio-mix',
      'render',
    ]);
  });

  it('gives every step a non-empty label', () => {
    for (const def of PIPELINE_STEP_DEFS) {
      expect(def.label.length).toBeGreaterThan(0);
    }
  });

  it('PIPELINE_STEP_IDS mirrors the def order', () => {
    expect(PIPELINE_STEP_IDS).toEqual(PIPELINE_STEP_DEFS.map((d) => d.id));
  });
});

describe('pipelineStepLabel', () => {
  it('returns the human label for a known id', () => {
    expect(pipelineStepLabel('stt')).toBe('Transcribe (Speech-to-Text)');
  });
});

describe('pipelineStepIndex', () => {
  it('returns the zero-based execution index', () => {
    expect(pipelineStepIndex('probe-video')).toBe(0);
    expect(pipelineStepIndex('render')).toBe(8);
  });
});

describe('normalizePipelineState (older pipeline.json back-compat)', () => {
  it('inserts steps added since the state was written, in canonical order', () => {
    const old = createInitialPipelineState('p1', '2026-01-01T00:00:00Z');
    // Simulate a pre-refine pipeline.json: drop the refine step + mark some done.
    const legacy = {
      ...old,
      steps: old.steps
        .filter((s) => s.id !== 'refine')
        .map((s) => (s.id === 'stt' ? { ...s, status: 'completed' as const } : s)),
    };
    const normalized = normalizePipelineState(legacy);
    expect(normalized.steps.map((s) => s.id)).toEqual(PIPELINE_STEP_IDS);
    expect(normalized.steps.find((s) => s.id === 'refine')?.status).toBe('pending');
    // Existing progress is preserved.
    expect(normalized.steps.find((s) => s.id === 'stt')?.status).toBe('completed');
  });

  it('returns the same reference when already current', () => {
    const state = createInitialPipelineState('p1', '2026-01-01T00:00:00Z');
    expect(normalizePipelineState(state)).toBe(state);
  });
});
