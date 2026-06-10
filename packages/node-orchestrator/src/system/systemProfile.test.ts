import { describe, expect, it } from 'vitest';
import type { SystemProfile } from '@videodubber/shared';
import { recommendSetup } from './systemProfile.js';

function profile(overrides: Partial<SystemProfile> = {}): SystemProfile {
  return {
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'Test CPU',
    cpuCores: 8,
    totalRamMb: 16 * 1024,
    freeRamMb: 8 * 1024,
    gpus: [],
    appleSilicon: false,
    ...overrides,
  };
}

describe('recommendSetup', () => {
  it('constrained machines get tiny + cloud suggestions for STT and translation', () => {
    const rec = recommendSetup(profile({ totalRamMb: 4 * 1024 }));
    expect(rec.tier).toBe('constrained');
    expect(rec.whisperModel).toBe('tiny');
    expect(rec.suggestCloud.stt).toBe(true);
    expect(rec.suggestCloud.translation).toBe(true);
    expect(rec.suggestCloud.tts).toBe(false);
  });

  it('8-16 GB machines get the balanced turbo model', () => {
    const rec = recommendSetup(profile({ totalRamMb: 8 * 1024 }));
    expect(rec.tier).toBe('balanced');
    expect(rec.whisperModel).toBe('large-v3-turbo');
    expect(rec.suggestCloud.stt).toBe(false);
  });

  it('16-32 GB machines get the performance turbo model', () => {
    expect(recommendSetup(profile({ totalRamMb: 24 * 1024 })).whisperModel).toBe('large-v3-turbo');
    const apple = recommendSetup(
      profile({ totalRamMb: 24 * 1024, platform: 'darwin', arch: 'arm64', appleSilicon: true }),
    );
    expect(apple.whisperModel).toBe('large-v3-turbo');
    expect(apple.tier).toBe('performance');
    // Apple Silicon should be nudged toward the Metal engine pack.
    expect(apple.reasons.join(' ')).toMatch(/whisper\.cpp|Metal/);
  });

  it('32+ GB machines get the performance turbo model', () => {
    const rec = recommendSetup(profile({ totalRamMb: 64 * 1024 }));
    expect(rec.whisperModel).toBe('large-v3-turbo');
    expect(rec.tier).toBe('performance');
  });

  it('few CPU cores push STT toward cloud even with plenty of RAM', () => {
    const rec = recommendSetup(profile({ totalRamMb: 32 * 1024, cpuCores: 2 }));
    expect(rec.suggestCloud.stt).toBe(true);
    expect(rec.reasons.join(' ')).toMatch(/CPU cores/);
  });

  it('mentions an NVIDIA GPU in the reasons when detected', () => {
    const rec = recommendSetup(
      profile({ gpus: [{ name: 'NVIDIA GeForce RTX 4070', vramMb: 12288 }] }),
    );
    expect(rec.reasons.join(' ')).toMatch(/NVIDIA/);
  });
});
