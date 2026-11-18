import { describe, expect, it } from 'vitest';
import { allCatalogVoices } from '../voices/voiceCatalog.js';
import { PIPER_VOICES } from './catalog.js';
import { listVoicesForLanguage, resolvePiperVoice, voiceCatalogStats } from './voicesCatalog.js';

describe('voicesCatalog', () => {
  it('resolves a voice id to commit-pinned, checksummed download URLs', () => {
    const v = resolvePiperVoice('vi_VN-vais1000-medium');
    expect(v).toBeDefined();
    expect(v!.url).toMatch(
      /^https:\/\/huggingface\.co\/rhasspy\/piper-voices\/resolve\/[0-9a-f]{40}\/vi\/vi_VN\/vais1000\/medium\/vi_VN-vais1000-medium\.onnx$/,
    );
    // Never a branch: an upstream push must not change what installs.
    expect(v!.url).not.toContain('/resolve/main/');
    expect(v!.configUrl).toBe(`${v!.url}.json`);
    expect(v!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v!.bytes).toBeGreaterThan(1_000_000);
    expect(v!.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v!.quality).toBe('medium');
    expect(v!.language).toBe('vi-VN');
    expect(v!.languageCode).toBe('vi_VN');
    expect(v!.label).toBe('Vietnamese (Vietnam) — vais1000 (medium)');
  });

  it('returns undefined for an unknown id, and for a speaker id', () => {
    expect(resolvePiperVoice('nope-x_low')).toBeUndefined();
    // "<model>#<n>" picks a speaker at synthesis; the download is the model.
    expect(resolvePiperVoice('vi_VN-vivos-x_low#3')).toBeUndefined();
  });

  it('lists every Vietnamese voice, best quality first', () => {
    const vi = listVoicesForLanguage('vi-VN');
    expect(vi.map((v) => v.id)).toEqual([
      'vi_VN-vais1000-medium', // medium, single-speaker -> first
      'vi_VN-25hours_single-low', // low
      'vi_VN-vivos-x_low', // x_low (also 65 speakers)
    ]);
    expect(vi[2]!.numSpeakers).toBe(65);
  });

  it('matches on the base subtag (vi / vi_VN / vi-VN all work)', () => {
    expect(listVoicesForLanguage('vi').length).toBe(3);
    expect(listVoicesForLanguage('vi_VN').length).toBe(3);
  });

  it('has Chinese voices (relevant when the target is zh)', () => {
    expect(listVoicesForLanguage('zh-CN').length).toBeGreaterThanOrEqual(4);
  });

  it('returns [] for a language Piper has no voice for', () => {
    expect(listVoicesForLanguage('xx-XX')).toEqual([]);
  });

  it("flags exactly the curated defaults as recommended (the generator's PIPER_RECOMMENDED)", () => {
    const recommended = allCatalogVoices()
      .filter((v) => v.engine === 'piper' && v.recommended)
      .map((v) => v.id)
      .sort();
    expect(recommended).toEqual(PIPER_VOICES.map((v) => v.id).sort());
  });

  it('bundles the full catalog', () => {
    const stats = voiceCatalogStats();
    expect(stats.voices).toBe(183);
    expect(stats.languages).toBeGreaterThan(50);
  });
});
