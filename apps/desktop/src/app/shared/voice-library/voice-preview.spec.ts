import { describe, expect, it } from 'vitest';
import { previewSource, sampleSentence } from './voice-preview';

describe('previewSource', () => {
  const item = (over: Partial<Parameters<typeof previewSource>[0] & object> = {}) => ({
    engine: 'vieneu' as const,
    installed: false,
    sample: true,
    hasPreview: true,
    ...over,
  });

  it("plays the catalog sample when there is one, installed or not", () => {
    expect(previewSource(item())).toBe('sample');
    expect(previewSource(item({ installed: true }))).toBe('sample');
  });

  it('lets an installed voice without a sample say a sentence, or the sentence the user typed', () => {
    expect(previewSource(item({ installed: true, sample: false }))).toBe('speak');
    expect(previewSource(item({ installed: true }), 'Câu của tôi')).toBe('speak');
  });

  it('never makes an OpenAI voice speak just to listen (a billed request)', () => {
    expect(previewSource(item({ engine: 'openai', installed: true }), 'hello')).toBe('sample');
    expect(previewSource(item({ engine: 'openai', installed: true, sample: false, hasPreview: false }))).toBeNull();
  });

  it('has nothing to play for a voice with neither, or no voice', () => {
    expect(previewSource(item({ sample: false, hasPreview: false }))).toBeNull();
    expect(previewSource(undefined)).toBeNull();
  });
});

describe('sampleSentence', () => {
  it('speaks the dub language, region tags included, else English', () => {
    expect(sampleSentence('vi-VN')).toMatch(/^Xin chào/);
    expect(sampleSentence('ja')).toMatch(/^こんにちは/);
    expect(sampleSentence('sw')).toMatch(/^Hello/);
  });
});
