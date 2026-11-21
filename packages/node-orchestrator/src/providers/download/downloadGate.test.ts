import { describe, expect, it } from 'vitest';

import { downloadGate, effectiveDownloadPolicy, powerfulForParallel } from './downloadGate.js';

const rtx3050 = { gpus: [{ name: 'NVIDIA GeForce RTX 3050', vramMb: 8192 }], appleSilicon: false, totalRamMb: 32768 };
const rtx4080 = { gpus: [{ name: 'NVIDIA GeForce RTX 4080', vramMb: 16376 }], appleSilicon: false, totalRamMb: 32768 };

describe('downloads while dubbing', () => {
  it('counts a 12 GB card (or a 32 GB Mac) with room for two dubs as powerful; 8 GB is not', () => {
    expect(powerfulForParallel(rtx3050, 4)).toBe(false);
    expect(powerfulForParallel(rtx4080, 4)).toBe(true);
    expect(powerfulForParallel(rtx4080, 1)).toBe(false);
    expect(powerfulForParallel({ gpus: [], appleSilicon: true, totalRamMb: 36864 }, 2)).toBe(true);
    expect(powerfulForParallel({ gpus: [], appleSilicon: true, totalRamMb: 16384 }, 2)).toBe(false);
    expect(effectiveDownloadPolicy('auto', false)).toBe('one-task');
    expect(effectiveDownloadPolicy(undefined, true)).toBe('pause-heavy');
    expect(effectiveDownloadPolicy('no-limit', false)).toBe('no-limit');
  });

  it('one task at a time: nothing downloads while a dub or a GPU edit runs', () => {
    const base = { policy: 'one-task' as const, externalHeavy: false, pressure: false, concurrency: 2 };
    expect(downloadGate({ ...base, runs: [] })).toEqual({ limit: 1 });
    expect(downloadGate({ ...base, runs: [{ projectId: 'p', step: 'render', heavy: false }] })).toEqual({ limit: 0, reason: 'dubbing' });
    expect(downloadGate({ ...base, runs: [], externalHeavy: true })).toEqual({ limit: 0, reason: 'dubbing' });
  });

  it('in parallel, downloads pause in heavy and disk-heavy steps and under pressure', () => {
    const base = { policy: 'pause-heavy' as const, externalHeavy: false, pressure: false, concurrency: 2 };
    expect(downloadGate({ ...base, runs: [{ projectId: 'p', step: 'translation', heavy: true }] })).toEqual({ limit: 0, reason: 'gpu-heavy' });
    expect(downloadGate({ ...base, runs: [{ projectId: 'p', step: 'extract-audio', heavy: false }] })).toEqual({ limit: 0, reason: 'gpu-heavy' });
    // A cloud translation is light: downloads go on.
    expect(downloadGate({ ...base, runs: [{ projectId: 'p', step: 'translation', heavy: false }] })).toEqual({ limit: 2 });
    expect(downloadGate({ ...base, runs: [], pressure: true })).toEqual({ limit: 0, reason: 'pressure' });
    expect(downloadGate({ ...base, policy: 'no-limit', runs: [{ projectId: 'p', step: 'tts', heavy: true }] })).toEqual({ limit: 2 });
  });
});
