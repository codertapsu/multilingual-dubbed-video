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
  it('exports the NVIDIA driver gate helpers', () => {
    expect(typeof shared.compareDriverVersions).toBe('function');
    expect(typeof shared.outdatedNvidiaDriver).toBe('function');
    expect(shared.NVIDIA_GPU_RE).toBeInstanceOf(RegExp);
  });
});

/**
 * The comparator decides whether a user is told to update a driver or to buy
 * RAM, so it is pinned rather than smoke-tested. Numbers come from a real
 * failure: a GTX 1650 aborted every CUDA run on driver 546.29 and served the
 * byte-for-byte identical allocation on 610.88.
 */
describe('NVIDIA driver comparison', () => {
  const gtx = (driverVersion?: string) => [
    { name: 'NVIDIA GeForce GTX 1650', ...(driverVersion ? { driverVersion } : {}) },
  ];
  const pack = { minNvidiaDriver: '551.61' };

  it('compares segment-wise and numerically, not lexicographically', () => {
    expect(shared.compareDriverVersions('546.29', '551.61')).toBeLessThan(0);
    expect(shared.compareDriverVersions('610.88', '551.61')).toBeGreaterThan(0);
    expect(shared.compareDriverVersions('551.61', '551.61')).toBe(0);
    // "9" > "5" as a string; 9 < 551 as a number. This is the trap.
    expect(shared.compareDriverVersions('9.99', '551.61')).toBeLessThan(0);
    // Linux drivers carry a third segment; a missing one counts as 0.
    expect(shared.compareDriverVersions('550.54.14', '550.54')).toBeGreaterThan(0);
    expect(shared.compareDriverVersions('551.61.02', '551.61')).toBeGreaterThan(0);
  });

  it('reports the driver only when it is genuinely too old', () => {
    expect(shared.outdatedNvidiaDriver(pack, gtx('546.29'))).toBe('546.29');
    expect(shared.outdatedNvidiaDriver(pack, gtx('551.60'))).toBe('551.60');
    expect(shared.outdatedNvidiaDriver(pack, gtx('551.61'))).toBeUndefined();
    expect(shared.outdatedNvidiaDriver(pack, gtx('610.88'))).toBeUndefined();
  });

  it('fails open on anything it cannot establish', () => {
    expect(shared.outdatedNvidiaDriver(pack, gtx(undefined))).toBeUndefined();
    expect(shared.outdatedNvidiaDriver(pack, gtx(''))).toBeUndefined();
    expect(shared.outdatedNvidiaDriver(pack, [])).toBeUndefined();
    // Non-NVIDIA GPUs are not judged by an NVIDIA driver floor...
    expect(shared.outdatedNvidiaDriver(pack, [{ name: 'AMD Radeon RX 7900', driverVersion: '1.0' }])).toBeUndefined();
    // ...nor is a pack that declares no floor.
    expect(shared.outdatedNvidiaDriver({}, gtx('546.29'))).toBeUndefined();
  });

  it('passes when ANY installed NVIDIA GPU is new enough, and names the newest when none is', () => {
    const mixed = [
      { name: 'NVIDIA GeForce GTX 1650', driverVersion: '546.29' },
      { name: 'NVIDIA RTX 4070', driverVersion: '560.00' },
    ];
    // CUDA picks one device and llama.cpp takes the best, so one is enough.
    expect(shared.outdatedNvidiaDriver(pack, mixed)).toBeUndefined();
    const bothOld = [
      { name: 'NVIDIA GeForce GTX 1650', driverVersion: '546.29' },
      { name: 'NVIDIA GeForce GTX 1060', driverVersion: '540.00' },
    ];
    // Name the one the runtime would actually use.
    expect(shared.outdatedNvidiaDriver(pack, bothOld)).toBe('546.29');
  });
});
