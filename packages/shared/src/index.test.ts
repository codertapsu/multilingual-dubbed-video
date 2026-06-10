import { describe, it, expect } from 'vitest';
import * as shared from './index.js';

/**
 * Barrel smoke test: ensures the public API surface is exported and wired up.
 */
describe('@videodubber/shared public API', () => {
  it('exports subtitle helpers', () => {
    expect(typeof shared.toSrtTimestamp).toBe('function');
    expect(typeof shared.toVttTimestamp).toBe('function');
    expect(typeof shared.splitSubtitleLines).toBe('function');
    expect(typeof shared.segmentsToSrt).toBe('function');
    expect(typeof shared.segmentsToVtt).toBe('function');
    expect(typeof shared.transcriptSegmentsToCues).toBe('function');
  });

  it('exports language helpers and COMMON_LANGUAGES', () => {
    expect(typeof shared.normalizeLanguageCode).toBe('function');
    expect(typeof shared.toWhisperLanguage).toBe('function');
    expect(typeof shared.toArgosLanguage).toBe('function');
    expect(typeof shared.isValidLanguageCode).toBe('function');
    expect(Array.isArray(shared.COMMON_LANGUAGES)).toBe(true);
  });

  it('exports pipeline helpers', () => {
    expect(Array.isArray(shared.PIPELINE_STEP_DEFS)).toBe(true);
    expect(typeof shared.createInitialPipelineState).toBe('function');
    expect(typeof shared.setStepStatus).toBe('function');
  });

  it('exports the error model', () => {
    expect(typeof shared.toAppError).toBe('function');
    expect(typeof shared.makeAppError).toBe('function');
    expect(typeof shared.AppErrorException).toBe('function');
    expect(shared.REMEDIATIONS.UNKNOWN).toBeDefined();
  });

  it('end-to-end: transcript -> cues -> srt/vtt', () => {
    const cues = shared.transcriptSegmentsToCues([
      {
        id: 'seg_0001',
        index: 0,
        startMs: 0,
        endMs: 1500,
        sourceText: 'Hello',
        translatedText: 'Xin chào',
      },
    ]);
    const srt = shared.segmentsToSrt(cues);
    const vtt = shared.segmentsToVtt(cues);
    expect(srt).toContain('Xin chào');
    expect(srt).toContain('00:00:00,000 --> 00:00:01,500');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('Xin chào');
  });
});
