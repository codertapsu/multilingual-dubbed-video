import { describe, expect, it } from 'vitest';
import { resolveUvRequirements } from './uvRequirements.js';

describe('resolveUvRequirements', () => {
  it('returns undefined for a pack with no uv spec', () => {
    expect(resolveUvRequirements('whisper-cpp')).toBeUndefined();
    expect(resolveUvRequirements('nope')).toBeUndefined();
  });

  it('pins the VieNeu (v3-Turbo / vieneu SDK) stack identically on every platform', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const r = resolveUvRequirements('tts-neural', platform)!;
      expect(r.requirements).toContain('vieneu==3.0.5');
      // Torch-free ONNX path: none of the old heavy/GGUF deps.
      for (const gone of ['torch', 'llama-cpp-python', 'neucodec', 'neuttsair', 'phonemizer']) {
        expect(r.requirements.some((x) => x.includes(gone))).toBe(false);
      }
      // No extra index URLs (no PyTorch CPU index needed) on any platform.
      expect(r.extraIndexUrls).toEqual([]);
      // Everything is exactly pinned (no loose >= / ~= specifiers).
      expect(r.requirements.filter((x) => x.includes('>=') || x.includes('~='))).toEqual([]);
    }
  });

  it('pins the VieNeu v2 stack (vieneu 2.7.0) with the llama-cpp CPU wheel index', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const r = resolveUvRequirements('tts-neural-v2', platform)!;
      expect(r.requirements).toContain('vieneu==2.7.0');
      expect(r.requirements).not.toContain('vieneu==3.0.5');
      expect(r.extraIndexUrls).toContain('https://pnnbao97.github.io/llama-cpp-python-v0.3.16/cpu/');
      expect(r.requirements.filter((x) => x.includes('>=') || x.includes('~='))).toEqual([]);
    }
  });

  it('keeps the other uv packs resolvable (base-only)', () => {
    const sep = resolveUvRequirements('separation-audio', 'linux')!;
    expect(sep.requirements).toContain('audio-separator>=0.18');
    expect(sep.extraIndexUrls).toEqual([]);
    expect(resolveUvRequirements('alignment-whisperx', 'darwin')!.requirements).toContain('whisperx>=3.8');
  });
});
