import { describe, expect, it } from 'vitest';
import { listVoicesForLanguage, resolvePiperVoice, voiceCatalogStats } from './voicesCatalog.js';

describe('voicesCatalog', () => {
  it('resolves a voice id to download URLs derived from its file paths', () => {
    const v = resolvePiperVoice('vi_VN-vais1000-medium');
    expect(v).toBeDefined();
    expect(v!.url).toBe(
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx',
    );
    expect(v!.configUrl).toBe(`${v!.url}.json`);
    expect(v!.quality).toBe('medium');
    expect(v!.language).toBe('vi-VN');
    expect(v!.languageCode).toBe('vi_VN');
  });

  it('returns undefined for an unknown id', () => {
    expect(resolvePiperVoice('nope-x_low')).toBeUndefined();
  });

  it('lists every Vietnamese voice, best quality first', () => {
    const vi = listVoicesForLanguage('vi-VN');
    expect(vi.map((v) => v.id)).toEqual([
      'vi_VN-vais1000-medium', // medium, single-speaker -> first
      'vi_VN-25hours_single-low', // low
      'vi_VN-vivos-x_low', // x_low (also 65 speakers)
    ]);
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

  it('bundles the full catalog', () => {
    const stats = voiceCatalogStats();
    expect(stats.voices).toBe(161);
    expect(stats.languages).toBeGreaterThan(40);
  });
});
