import { describe, expect, it } from 'vitest';
import { resolveUvRequirements } from './uvRequirements.js';

describe('resolveUvRequirements', () => {
  it('returns undefined for a pack with no uv spec', () => {
    expect(resolveUvRequirements('whisper-cpp')).toBeUndefined();
    expect(resolveUvRequirements('nope')).toBeUndefined();
  });

  it('pins the VieNeu base stack on every platform', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const r = resolveUvRequirements('tts-neural', platform)!;
      expect(r.requirements).toContain('llama-cpp-python==0.3.16');
      expect(r.requirements).toContain('neucodec==0.0.4');
      expect(r.requirements).toContain('torch==2.5.1');
      // NeuTTS Air comes from git (Apache-2.0; not on PyPI).
      expect(r.requirements.some((x) => x.startsWith('neuttsair @ git+'))).toBe(true);
      // Everything is exactly pinned (no loose >= specifiers) except the git dep.
      const loose = r.requirements.filter((x) => x.includes('>=') || x.includes('~='));
      expect(loose).toEqual([]);
    }
  });

  it('routes torch to the CPU wheel index on Linux and Windows only', () => {
    const cpuIndex = 'https://download.pytorch.org/whl/cpu';
    expect(resolveUvRequirements('tts-neural', 'linux')!.extraIndexUrls).toContain(cpuIndex);
    expect(resolveUvRequirements('tts-neural', 'win32')!.extraIndexUrls).toContain(cpuIndex);
    // macOS uses the default wheel (CPU/MPS) — no extra index.
    expect(resolveUvRequirements('tts-neural', 'darwin')!.extraIndexUrls).toEqual([]);
  });

  it('de-duplicates extra index urls', () => {
    const r = resolveUvRequirements('tts-neural', 'linux')!;
    expect(new Set(r.extraIndexUrls).size).toBe(r.extraIndexUrls.length);
  });

  it('keeps the other uv packs resolvable (base-only)', () => {
    const sep = resolveUvRequirements('separation-audio', 'linux')!;
    expect(sep.requirements).toContain('audio-separator>=0.18');
    expect(sep.extraIndexUrls).toEqual([]);
    expect(resolveUvRequirements('alignment-whisperx', 'darwin')!.requirements).toContain('whisperx>=3.8');
  });
});
