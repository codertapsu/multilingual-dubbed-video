import { describe, it, expect } from 'vitest';
import {
  PIPELINE_STEP_DEFS,
  PIPELINE_STEP_IDS,
  pipelineStepLabel,
  pipelineStepIndex,
} from './steps.js';

describe('PIPELINE_STEP_DEFS', () => {
  it('defines exactly 8 steps in pipeline order', () => {
    expect(PIPELINE_STEP_DEFS.map((d) => d.id)).toEqual([
      'probe-video',
      'extract-audio',
      'stt',
      'translation',
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
    expect(pipelineStepIndex('render')).toBe(7);
  });
});
